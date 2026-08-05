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
	decodeWorkflowEvent,
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
	/** Used only to reconcile an ambiguous pending event append. */
	readonly openAppend?: (filePath: string, mode: number) => Promise<WritableFile>;
}

export const nodeStateFileSystem: StateFileSystem = {
	mkdir,
	chmod,
	openExclusive: (filePath, mode) => open(filePath, "wx", mode),
	rename,
	remove: (filePath) => rm(filePath, { force: true }),
	readText: (filePath) => readFile(filePath, "utf8"),
	openAppend: (filePath, mode) => open(filePath, "a", mode),
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

/** Pending transaction lives beside the canonical snapshot and is owner-only. */
export function pendingPersistencePath(paths: WorkflowPaths): string {
	return path.join(paths.runDir, ".pending-persistence.json");
}

export function stagePendingSnapshot(
	paths: WorkflowPaths,
	run: WorkflowRun,
	event: unknown,
	fs: StateFileSystem = nodeStateFileSystem,
): Effect.Effect<void, PersistenceError> {
	return Effect.gen(function* () {
		yield* ensureRunDirectories(paths, fs);
		// `not-started` proves that no append was attempted yet. The controller
		// advances this marker before opening the journal, so recovery never
		// discards an append which may have reached the filesystem.
		yield* atomicWriteJson(pendingPersistencePath(paths), { version: SCHEMA_VERSION, run, event, appendStatus: "not-started" }, fs);
	});
}

export function markPendingSnapshotStarted(
	paths: WorkflowPaths,
	fs: StateFileSystem = nodeStateFileSystem,
): Effect.Effect<void, PersistenceError | CorruptDataError> {
	return Effect.gen(function* () {
		const pendingPath = pendingPersistencePath(paths);
		const pending = yield* readUnknownJson(pendingPath, fs);
		if (pending === null || typeof pending !== "object") return yield* Effect.fail(new PersistenceError({ operation: "mark pending append", path: pendingPath, cause: new Error("pending transaction is not an object") }));
		yield* atomicWriteJson(pendingPath, { ...(pending as Record<string, unknown>), appendStatus: "started" }, fs);
	});
}

export function clearPendingSnapshot(
	paths: WorkflowPaths,
	fs: StateFileSystem = nodeStateFileSystem,
): Effect.Effect<void, PersistenceError> {
	return Effect.tryPromise({
		try: () => fs.remove(pendingPersistencePath(paths)),
		catch: (cause) => persistenceFailure("remove pending snapshot", pendingPersistencePath(paths), cause),
	});
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

function eventIdInJournal(content: string, eventId: string): "present" | "absent" | "malformed" {
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line) as { readonly id?: unknown };
			if (value.id === eventId) return "present";
		} catch {
			// A malformed journal must be surfaced, never silently repaired by a
			// pending snapshot or a second append.
			return "malformed";
		}
	}
	return "absent";
}

/**
 * Complete or discard a staged transaction. Appending the event precedes the
 * snapshot; this recovery step handles a process crash between those writes.
 */
export function recoverPendingSnapshot(
	paths: WorkflowPaths,
	fs: StateFileSystem = nodeStateFileSystem,
): Effect.Effect<void, PersistenceError | CorruptDataError | UnsupportedVersionError | ValidationError> {
	return Effect.gen(function* () {
		const pendingPath = pendingPersistencePath(paths);
		const pendingResult = yield* Effect.result(readUnknownJson(pendingPath, fs));
		if (pendingResult._tag === "Failure") {
			const nestedCause = pendingResult.failure instanceof PersistenceError ? pendingResult.failure.cause : pendingResult.failure;
			if ((nestedCause as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || String(nestedCause).includes("ENOENT")) return yield* Effect.void;
			return yield* Effect.fail(pendingResult.failure);
		}
		const pending: unknown = pendingResult.success;
		if (pending === null || typeof pending !== "object") return yield* Effect.fail(new CorruptDataError({ path: pendingPath, message: "pending persistence is not an object" }));
		const value = pending as { readonly version?: unknown; readonly run?: unknown; readonly event?: unknown; readonly appendStatus?: unknown };
		if (value.version !== SCHEMA_VERSION || value.run === undefined || value.event === undefined) {
			return yield* Effect.fail(new CorruptDataError({ path: pendingPath, message: "pending persistence has an invalid transaction shape" }));
		}
		if (value.event === null || typeof value.event !== "object" || typeof (value.event as { readonly id?: unknown }).id !== "string") {
			return yield* Effect.fail(new CorruptDataError({ path: pendingPath, message: "pending persistence has no event identity" }));
		}
		const journalResult = yield* Effect.result(Effect.tryPromise({
			try: () => fs.readText(paths.eventsFile),
			catch: (cause) => persistenceFailure("read event journal for recovery", paths.eventsFile, cause),
		}));
		let journal = "";
		if (journalResult._tag === "Failure") {
			if ((journalResult.failure.cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return yield* Effect.fail(journalResult.failure);
		} else {
			journal = journalResult.success;
		}
		const pendingEvent = yield* decodeWorkflowEvent(value.event, `${pendingPath}:event`);
		if (containsCredential(pendingEvent.data)) return yield* Effect.fail(new ValidationError({ message: "pending event data must not contain credentials", path: `${pendingPath}:event.data` }));
		const eventId = pendingEvent.id;
		const pendingDocument = yield* decodePlanDocument({ version: SCHEMA_VERSION, run: value.run }, paths.planFile);
		if (pendingEvent.runId !== pendingDocument.run.id) return yield* Effect.fail(new CorruptDataError({ path: pendingPath, message: "pending event and snapshot run IDs do not match" }));
		const journalEventState = eventIdInJournal(journal, eventId);
		if (journalEventState === "malformed") return yield* Effect.fail(new CorruptDataError({ path: paths.eventsFile, message: "event journal contains malformed JSON while reconciling a pending transaction" }));
		if (journalEventState === "absent") {
			if (value.appendStatus === "not-started" || value.appendStatus === undefined) {
				// The transaction was staged but no append attempt was recorded. This
				// is the one safe point at which an absent event proves the append did
				// not happen (and preserves compatibility with old pending files).
				yield* clearPendingSnapshot(paths, fs);
				return;
			}
			const openAppend = fs.openAppend;
			if (!openAppend) return yield* Effect.fail(new PersistenceError({ operation: "reconcile pending event", path: paths.eventsFile, cause: new Error("event append is ambiguous and this filesystem cannot reconcile it") }));
			let handle: WritableFile | undefined;
			yield* Effect.tryPromise({
				try: async () => {
					handle = await openAppend(paths.eventsFile, FILE_MODE);
					await fs.chmod(paths.eventsFile, FILE_MODE);
					const line = deterministicJsonLine(pendingEvent);
					await handle.writeFile(line);
					await handle.sync();
					await handle.close();
					handle = undefined;
					journal += line;
				},
				catch: (cause) => persistenceFailure("reconcile pending event", paths.eventsFile, cause),
			}).pipe(Effect.ensuring(Effect.promise(() => handle?.close().catch(() => undefined) ?? Promise.resolve())));
		}
		const document = pendingDocument;
		yield* validateRun(document.run);
		if (containsCredential(document.run)) return yield* Effect.fail(new ValidationError({ message: "workflow state must not contain model credentials", path: "run" }));
		yield* ensureRunDirectories(paths, fs);
		yield* atomicWriteJson(paths.planFile, document, fs);
		yield* atomicWriteJson(paths.stateFile, { version: SCHEMA_VERSION, planFile: path.basename(paths.planFile) }, fs);
		yield* clearPendingSnapshot(paths, fs);
	});
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
		// plan.json is the sole authoritative snapshot. Keeping the complete run
		// here makes recovery independent from a second, potentially stale state
		// document. state.json is intentionally not rewritten.
		const planDocument: PlanDocument = { version: SCHEMA_VERSION, run: normalizedRun };
		yield* atomicWriteJson(paths.planFile, planDocument, fs);
		// Keep a non-authoritative compatibility pointer for tooling that only
		// checks the historical state.json path. It contains no workflow data.
		yield* atomicWriteJson(paths.stateFile, { version: SCHEMA_VERSION, planFile: path.basename(paths.planFile) }, fs);
		// Pending transaction cleanup belongs to the event-first transaction
		// boundary. A direct snapshot save must not discard an ambiguous append.
	});
}

export function loadRun(
	paths: WorkflowPaths,
	fs: StateFileSystem = nodeStateFileSystem,
): Effect.Effect<WorkflowRun, PersistenceError | CorruptDataError | UnsupportedVersionError | ValidationError> {
	return Effect.gen(function* () {
		yield* recoverPendingSnapshot(paths, fs);
		// New runs are loaded exclusively from the canonical plan snapshot. The
		// state.json fallback lets older installations recover without restoring
		// duplicate state as a new source of truth.
		let loadedFromLegacy = false;
		const input = yield* readUnknownJson(paths.planFile, fs).pipe(
			Effect.catchTag("PersistenceError", () => Effect.gen(function* () {
				loadedFromLegacy = true;
				return yield* readUnknownJson(paths.stateFile, fs);
			})),
		);
		const run = yield* decodePlanDocument(input, paths.planFile).pipe(
			Effect.map((document) => document.run),
			Effect.catchTag("CorruptDataError", () => Effect.gen(function* () {
				loadedFromLegacy = true;
				const legacy = yield* readUnknownJson(paths.stateFile, fs);
				return yield* decodeStateDocument(legacy, paths.stateFile).pipe(Effect.map((document) => document.run));
			})),
			Effect.catchTag("UnsupportedVersionError", (unsupported) => Effect.gen(function* () {
				loadedFromLegacy = true;
				const legacy = yield* readUnknownJson(paths.stateFile, fs).pipe(Effect.catch(() => Effect.fail(unsupported)));
				return yield* decodeStateDocument(legacy, paths.stateFile).pipe(Effect.map((document) => document.run), Effect.catch(() => Effect.fail(unsupported)));
			})),
		);
		yield* validateRun(run);
		if (run.projectId !== paths.projectId || run.projectPath !== paths.canonicalProjectPath) {
			return yield* Effect.fail(new ValidationError({ message: "run project metadata does not match its storage path", path: "run.projectId" }));
		}
		if (loadedFromLegacy) yield* saveRun(paths, run, fs);
		return run;
	});
}

export function loadPlan(
	paths: WorkflowPaths,
	fs: StateFileSystem = nodeStateFileSystem,
): Effect.Effect<WorkflowPlan, PersistenceError | CorruptDataError | UnsupportedVersionError | ValidationError> {
	return Effect.gen(function* () {
		const run = yield* loadRun(paths, fs);
		return run.plan;
	});
}
