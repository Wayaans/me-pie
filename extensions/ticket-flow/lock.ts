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

export type ProjectLockStatus =
	| { readonly state: "missing" }
	| { readonly state: "owned" | "live" | "stale" | "ambiguous"; readonly owner?: LockOwner; readonly reason: string };

export interface ProcessLiveness {
	readonly isAlive: (pid: number) => boolean;
}

export const nodeProcessLiveness: ProcessLiveness = {
	isAlive: (pid) => {
		try { process.kill(pid, 0); return true; }
		catch (cause) { return (cause as NodeJS.ErrnoException).code !== "ESRCH"; }
	},
};

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

function decodeLockOwner(input: unknown): LockOwner | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const candidate = input as Partial<LockOwner>;
	if (candidate.version !== SCHEMA_VERSION || typeof candidate.runId !== "string" || !candidate.runId
		|| typeof candidate.acquisitionId !== "string" || !candidate.acquisitionId
		|| !Number.isSafeInteger(candidate.pid) || (candidate.pid ?? 0) <= 0
		|| typeof candidate.createdAt !== "string"
		|| (candidate.sessionId !== undefined && typeof candidate.sessionId !== "string")) return undefined;
	return candidate as LockOwner;
}

export function inspectProjectLock(
	rootDir: string,
	projectId: string,
	options: { readonly runId?: string; readonly sessionId?: string; readonly fs?: LockFileSystem; readonly liveness?: ProcessLiveness } = {},
): Effect.Effect<ProjectLockStatus> {
	const fs = options.fs ?? nodeLockFileSystem;
	const lockPath = path.join(rootDir, `${projectId}.lock`);
	const ownerPath = path.join(lockPath, "owner.json");
	return Effect.promise(async () => {
		const input = await readOwner(ownerPath, fs);
		if (input === undefined) {
			try { await fs.readText(ownerPath); } catch (cause) {
				if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" } as const;
			}
			return { state: "ambiguous", reason: "The lock exists without valid owner metadata." } as const;
		}
		const owner = decodeLockOwner(input);
		if (!owner) return { state: "ambiguous", reason: "The lock owner schema is invalid." } as const;
		if (owner.pid === process.pid && owner.runId === options.runId && (options.sessionId === undefined || owner.sessionId === options.sessionId)) {
			return { state: "owned", owner, reason: "This live Pi session already owns the lock." } as const;
		}
		const alive = (options.liveness ?? nodeProcessLiveness).isAlive(owner.pid);
		if (alive) return { state: "live", owner, reason: "The recorded owner process is still alive." } as const;
		if (options.runId !== undefined && owner.runId !== options.runId) {
			return { state: "ambiguous", owner, reason: "The dead lock names a different run." } as const;
		}
		return { state: "stale", owner, reason: "The lock owner is dead and its run metadata matches." } as const;
	});
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

export function recoverProjectLock(
	rootDir: string,
	projectId: string,
	runId: string,
	options: {
		readonly sessionId?: string;
		readonly allowAmbiguousTakeover?: boolean;
		readonly fs?: LockFileSystem;
		readonly liveness?: ProcessLiveness;
	} = {},
): Effect.Effect<{ readonly lock: ProjectLock; readonly takeover: "none" | "stale" | "approved" }, LockContentionError | PersistenceError, Scope.Scope> {
	const fs = options.fs ?? nodeLockFileSystem;
	const lockPath = path.join(rootDir, `${projectId}.lock`);
	const ownerPath = path.join(lockPath, "owner.json");
	return Effect.gen(function* () {
		const status = yield* inspectProjectLock(rootDir, projectId, {
			runId,
			...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
			fs,
			...(options.liveness === undefined ? {} : { liveness: options.liveness }),
		});
		if (status.state === "owned" && status.owner) {
			let released = false;
			const release = () => {
				if (released) return Effect.void;
				released = true;
				return releaseLock(lockPath, ownerPath, status.owner!, fs);
			};
			const lock = { path: lockPath, owner: status.owner, release } satisfies ProjectLock;
			yield* Effect.addFinalizer(() => release().pipe(Effect.catch(() => Effect.void)));
			return { lock, takeover: "none" as const };
		}
		if (status.state === "live") return yield* Effect.fail(new LockContentionError({ path: lockPath, owner: status.owner }));
		if (status.state === "ambiguous" && !options.allowAmbiguousTakeover) {
			return yield* Effect.fail(new LockContentionError({ path: lockPath, ...(status.owner === undefined ? {} : { owner: status.owner }) }));
		}
		if (status.state === "stale" || status.state === "ambiguous") {
			const expectedOwnerText = yield* Effect.tryPromise({
				try: () => fs.readText(ownerPath),
				catch: (cause) => new PersistenceError({ operation: "snapshot project lock owner", path: ownerPath, cause }),
			});
			yield* Effect.tryPromise({
				try: async () => {
					if (await fs.readText(ownerPath) !== expectedOwnerText) throw new Error("Project lock ownership changed during recovery.");
					await fs.removeDirectory(lockPath);
				},
				catch: (cause) => new PersistenceError({ operation: "take over project lock", path: lockPath, cause }),
			});
			const lock = yield* acquireProjectLock(rootDir, projectId, runId, {
				...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
				fs,
			});
			return { lock, takeover: status.state === "stale" ? "stale" as const : "approved" as const };
		}
		const lock = yield* acquireProjectLock(rootDir, projectId, runId, {
			...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
			fs,
		});
		return { lock, takeover: "none" as const };
	});
}
