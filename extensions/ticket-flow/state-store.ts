import { open, mkdir, chmod, rename, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import type { WorkflowPlan, WorkflowRun } from "./domain.ts";
import { CorruptDataError, PersistenceError, UnsupportedVersionError, ValidationError } from "./errors.ts";
import { normalizePlan, validatePlan, validateRun } from "./state-machine.ts";
import {
	SCHEMA_VERSION,
	decodePlanDocument,
	decodeStateDocument,
	type PlanDocument,
	type StateDocument,
} from "./schemas.ts";
import type { WorkflowPaths } from "./paths.ts";

export const DIRECTORY_MODE = 0o700;
export const FILE_MODE = 0o600;

export interface WritableFile {
	readonly writeFile: (content: string) => Promise<void>;
	readonly sync: () => Promise<void>;
	readonly close: () => Promise<void>;
}

export interface StateFileSystem {
	readonly mkdir: (filePath: string, options: { readonly recursive: boolean; readonly mode: number }) => Promise<unknown>;
	readonly chmod: (filePath: string, mode: number) => Promise<void>;
	readonly openExclusive: (filePath: string, mode: number) => Promise<WritableFile>;
	readonly rename: (from: string, to: string) => Promise<void>;
	readonly remove: (filePath: string) => Promise<void>;
	readonly readText: (filePath: string) => Promise<string>;
}

export const nodeStateFileSystem: StateFileSystem = {
	mkdir,
	chmod,
	openExclusive: (filePath, mode) => open(filePath, "wx", mode),
	rename,
	remove: (filePath) => rm(filePath, { force: true }),
	readText: (filePath) => readFile(filePath, "utf8"),
};

function persistenceFailure(operation: string, filePath: string, cause: unknown): PersistenceError {
	return new PersistenceError({ operation, path: filePath, cause });
}

function throwIfAborted(...signals: readonly (AbortSignal | undefined)[]): void {
	const signal = signals.find((candidate) => candidate?.aborted);
	if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

const SECRET_KEY_PARTS = ["apikey", "authorization", "credential", "password", "secret", "token"];
const SECRET_ASSIGNMENT = /(?:api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|authorization|password)\s*[:=]\s*\S+/i;

function normalizedKey(key: string): string {
	return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function containsCredential(value: unknown, seen = new Set<object>()): boolean {
	if (typeof value === "string") return SECRET_ASSIGNMENT.test(value);
	if (value === null || typeof value !== "object" || seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some((item) => containsCredential(item, seen));
	return Object.entries(value).some(([key, item]) => {
		const normalized = normalizedKey(key);
		return SECRET_KEY_PARTS.some((part) => normalized.includes(part)) || containsCredential(item, seen);
	});
}

function stableValue(value: unknown, ancestors = new Set<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("cannot serialize a non-finite number");
		return value;
	}
	if (typeof value !== "object") throw new TypeError(`cannot serialize ${typeof value}`);
	if (ancestors.has(value)) throw new TypeError("cannot serialize a cyclic value");
	const nextAncestors = new Set(ancestors).add(value);
	if (Array.isArray(value)) return value.map((item) => stableValue(item, nextAncestors));
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
		throw new TypeError("cannot serialize a non-plain object");
	}
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, stableValue(item, nextAncestors)]),
	);
}

export function deterministicJson(value: unknown): string {
	return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function deterministicJsonLine(value: unknown): string {
	return `${JSON.stringify(stableValue(value))}\n`;
}

export function ensureRunDirectories(
	paths: WorkflowPaths,
	fs: StateFileSystem = nodeStateFileSystem,
	signal?: AbortSignal,
): Effect.Effect<void, PersistenceError> {
	return Effect.forEach(
		[paths.rootDir, paths.projectDir, paths.runDir, paths.reportsDir],
		(directory) => Effect.tryPromise({
			try: async (effectSignal) => {
				throwIfAborted(signal, effectSignal);
				await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
				throwIfAborted(signal, effectSignal);
				await fs.chmod(directory, DIRECTORY_MODE);
				throwIfAborted(signal, effectSignal);
			},
			catch: (cause) => persistenceFailure("create secure directory", directory, cause),
		}),
		{ discard: true },
	);
}

export function atomicWriteJson(
	filePath: string,
	value: unknown,
	fs: StateFileSystem = nodeStateFileSystem,
	signal?: AbortSignal,
): Effect.Effect<void, PersistenceError> {
	return Effect.gen(function* () {
		const content = yield* Effect.try({
			try: () => deterministicJson(value),
			catch: (cause) => persistenceFailure("serialize JSON", filePath, cause),
		});
		const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
		let handle: WritableFile | undefined;
		const write = Effect.tryPromise({
			try: async (effectSignal) => {
				throwIfAborted(signal, effectSignal);
				handle = await fs.openExclusive(temporaryPath, FILE_MODE);
				throwIfAborted(signal, effectSignal);
				await handle.writeFile(content);
				throwIfAborted(signal, effectSignal);
				await handle.sync();
				throwIfAborted(signal, effectSignal);
				await handle.close();
				handle = undefined;
				throwIfAborted(signal, effectSignal);
				await fs.rename(temporaryPath, filePath);
				throwIfAborted(signal, effectSignal);
				await fs.chmod(filePath, FILE_MODE);
				throwIfAborted(signal, effectSignal);
			},
			catch: (cause) => persistenceFailure("atomically write JSON", filePath, cause),
		});
		const cleanup = Effect.tryPromise({
			try: async () => {
				await handle?.close().catch(() => undefined);
				await fs.remove(temporaryPath);
			},
			catch: (cause) => persistenceFailure("clean temporary file", temporaryPath, cause),
		}).pipe(Effect.catch(() => Effect.void));
		yield* write.pipe(Effect.ensuring(cleanup));
	});
}

function parseUnknownJson(content: string, filePath: string): Effect.Effect<unknown, CorruptDataError> {
	return Effect.try({
		try: () => JSON.parse(content) as unknown,
		catch: (cause) => new CorruptDataError({ path: filePath, message: "invalid JSON", cause }),
	});
}

function readUnknownJson(
	filePath: string,
	fs: StateFileSystem,
): Effect.Effect<unknown, PersistenceError | CorruptDataError> {
	return Effect.tryPromise({
		try: () => fs.readText(filePath),
		catch: (cause) => persistenceFailure("read JSON", filePath, cause),
	}).pipe(Effect.flatMap((content) => parseUnknownJson(content, filePath)));
}

export function saveRun(
	paths: WorkflowPaths,
	run: WorkflowRun,
	fs: StateFileSystem = nodeStateFileSystem,
): Effect.Effect<void, PersistenceError | ValidationError> {
	return Effect.gen(function* () {
		const plan = normalizePlan(run.plan);
		const normalizedRun = { ...run, plan };
		yield* validateRun(normalizedRun);
		if (normalizedRun.projectId !== paths.projectId || normalizedRun.projectPath !== paths.canonicalProjectPath) {
			return yield* Effect.fail(new ValidationError({ message: "run project metadata does not match its storage path", path: "run.projectId" }));
		}
		if (containsCredential(normalizedRun)) {
			return yield* Effect.fail(new ValidationError({ message: "workflow state must not contain model credentials", path: "run" }));
		}
		yield* ensureRunDirectories(paths, fs);
		const state: StateDocument = { version: SCHEMA_VERSION, run: normalizedRun };
		const planDocument: PlanDocument = { version: SCHEMA_VERSION, plan };
		yield* atomicWriteJson(paths.planFile, planDocument, fs);
		yield* atomicWriteJson(paths.stateFile, state, fs);
	});
}

export function loadRun(
	paths: WorkflowPaths,
	fs: StateFileSystem = nodeStateFileSystem,
): Effect.Effect<WorkflowRun, PersistenceError | CorruptDataError | UnsupportedVersionError | ValidationError> {
	return Effect.gen(function* () {
		const input = yield* readUnknownJson(paths.stateFile, fs);
		const document = yield* decodeStateDocument(input, paths.stateFile);
		yield* validateRun(document.run);
		if (document.run.projectId !== paths.projectId || document.run.projectPath !== paths.canonicalProjectPath) {
			return yield* Effect.fail(new ValidationError({ message: "run project metadata does not match its storage path", path: "run.projectId" }));
		}
		return document.run;
	});
}

export function loadPlan(
	paths: WorkflowPaths,
	fs: StateFileSystem = nodeStateFileSystem,
): Effect.Effect<WorkflowPlan, PersistenceError | CorruptDataError | UnsupportedVersionError | ValidationError> {
	return Effect.gen(function* () {
		const input = yield* readUnknownJson(paths.planFile, fs);
		const document = yield* decodePlanDocument(input, paths.planFile);
		yield* validatePlan(document.plan);
		return document.plan;
	});
}
