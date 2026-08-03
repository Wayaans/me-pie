import { mkdir, chmod, open, rename, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Result, Scope } from "effect";
import { LockContentionError, PersistenceError } from "./errors.ts";
import { atomicWriteJson, DIRECTORY_MODE, type StateFileSystem } from "./state-store.ts";
import { SCHEMA_VERSION } from "./schemas.ts";

export interface LockOwner {
	readonly version: typeof SCHEMA_VERSION;
	readonly runId: string;
	readonly acquisitionId: string;
	readonly pid: number;
	readonly sessionId?: string;
	readonly createdAt: string;
}

export interface ProjectLock {
	readonly path: string;
	readonly owner: LockOwner;
	readonly release: () => Effect.Effect<void, PersistenceError>;
}

export interface LockFileSystem extends StateFileSystem {
	readonly removeDirectory: (directory: string) => Promise<void>;
}

export const nodeLockFileSystem: LockFileSystem = {
	mkdir,
	chmod,
	openExclusive: (filePath, mode) => open(filePath, "wx", mode),
	rename,
	remove: (filePath) => rm(filePath, { force: true }),
	readText: (filePath) => readFile(filePath, "utf8"),
	removeDirectory: (directory) => rm(directory, { recursive: true, force: true }),
};

export interface LockClock {
	readonly now: () => Date;
	readonly randomId: () => string;
}

export const systemLockClock: LockClock = { now: () => new Date(), randomId: () => crypto.randomUUID() };

function isAlreadyExists(cause: unknown): boolean {
	return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST";
}

async function readOwner(ownerPath: string, fs: LockFileSystem): Promise<unknown> {
	try {
		return JSON.parse(await fs.readText(ownerPath)) as unknown;
	} catch {
		return undefined;
	}
}

function releaseLock(
	lockPath: string,
	ownerPath: string,
	owner: LockOwner,
	fs: LockFileSystem,
): Effect.Effect<void, PersistenceError> {
	return Effect.tryPromise({
		try: async () => {
			const persisted = await readOwner(ownerPath, fs);
			if (persisted === undefined) return;
			if (
				typeof persisted !== "object" || persisted === null ||
				!("acquisitionId" in persisted) || persisted.acquisitionId !== owner.acquisitionId
			) return;
			await fs.removeDirectory(lockPath);
		},
		catch: (cause) => new PersistenceError({ operation: "release project lock", path: lockPath, cause }),
	});
}

export function acquireProjectLock(
	rootDir: string,
	projectId: string,
	runId: string,
	options: {
		readonly sessionId?: string;
		readonly pid?: number;
		readonly fs?: LockFileSystem;
		readonly clock?: LockClock;
	} = {},
): Effect.Effect<ProjectLock, LockContentionError | PersistenceError, Scope.Scope> {
	const fs = options.fs ?? nodeLockFileSystem;
	const clock = options.clock ?? systemLockClock;
	const lockPath = path.join(rootDir, `${projectId}.lock`);
	const ownerPath = path.join(lockPath, "owner.json");

	const acquire = Effect.gen(function* () {
		if (!/^[a-f0-9]{64}$/.test(projectId)) {
			return yield* Effect.fail(new PersistenceError({
				operation: "validate project lock ID",
				path: lockPath,
				cause: new Error("project ID must be a SHA-256 hex digest"),
			}));
		}
		const owner = yield* Effect.try({
			try: (): LockOwner => ({
				version: SCHEMA_VERSION,
				runId,
				acquisitionId: clock.randomId(),
				pid: options.pid ?? process.pid,
				...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
				createdAt: clock.now().toISOString(),
			}),
			catch: (cause) => new PersistenceError({ operation: "create lock owner", path: lockPath, cause }),
		});
		yield* Effect.tryPromise({
			try: async () => {
				await fs.mkdir(rootDir, { recursive: true, mode: DIRECTORY_MODE });
				await fs.chmod(rootDir, DIRECTORY_MODE);
			},
			catch: (cause) => new PersistenceError({ operation: "create lock root", path: rootDir, cause }),
		});
		const created = yield* Effect.tryPromise({
			try: async () => {
				await fs.mkdir(lockPath, { recursive: false, mode: DIRECTORY_MODE });
				await fs.chmod(lockPath, DIRECTORY_MODE);
			},
			catch: (cause) => new PersistenceError({ operation: "acquire project lock", path: lockPath, cause }),
		}).pipe(Effect.result);
		if (Result.isFailure(created)) {
			if (isAlreadyExists(created.failure.cause)) {
				const existingOwner = yield* Effect.promise(() => readOwner(ownerPath, fs));
				return yield* Effect.fail(new LockContentionError({
					path: lockPath,
					...(existingOwner === undefined ? {} : { owner: existingOwner }),
				}));
			}
			return yield* Effect.fail(created.failure);
		}
		const writeOwner = atomicWriteJson(ownerPath, owner, fs).pipe(
			Effect.tapError(() => Effect.promise(() => fs.removeDirectory(lockPath))),
		);
		yield* writeOwner;
		let released = false;
		const release = () => {
			if (released) return Effect.void;
			released = true;
			return releaseLock(lockPath, ownerPath, owner, fs);
		};
		return { path: lockPath, owner, release } satisfies ProjectLock;
	});

	return Effect.acquireRelease(acquire, (lock) => lock.release().pipe(Effect.catch(() => Effect.void)));
}
