import { open, readFile, chmod } from "node:fs/promises";
import { Effect } from "effect";
import { CorruptDataError, PersistenceError, UnsupportedVersionError, ValidationError } from "./errors.ts";
import { decodeWorkflowEvent, SCHEMA_VERSION, type WorkflowEvent } from "./schemas.ts";
import { containsCredential, deterministicJsonLine, FILE_MODE } from "./state-store.ts";

export const MAX_EVENT_BYTES = 32 * 1024;

export interface AppendFile {
	readonly writeFile: (content: string) => Promise<void>;
	readonly sync: () => Promise<void>;
	readonly close: () => Promise<void>;
}

export interface EventFileSystem {
	readonly openAppend: (filePath: string, mode: number) => Promise<AppendFile>;
	readonly chmod: (filePath: string, mode: number) => Promise<void>;
	readonly readText: (filePath: string) => Promise<string>;
}

export const nodeEventFileSystem: EventFileSystem = {
	openAppend: (filePath, mode) => open(filePath, "a", mode),
	chmod,
	readText: (filePath) => readFile(filePath, "utf8"),
};

export interface EventClock {
	readonly now: () => Date;
	readonly randomId: () => string;
}

export const systemEventClock: EventClock = {
	now: () => new Date(),
	randomId: () => crypto.randomUUID(),
};

export function makeWorkflowEvent(
	runId: string,
	type: string,
	data: unknown,
	clock: EventClock = systemEventClock,
): Effect.Effect<WorkflowEvent, ValidationError> {
	if (!runId.trim()) return Effect.fail(new ValidationError({ message: "event run ID must not be empty", path: "runId" }));
	if (!type.trim()) return Effect.fail(new ValidationError({ message: "event type must not be empty", path: "type" }));
	if (containsCredential(data)) {
		return Effect.fail(new ValidationError({ message: "event data must not contain credentials", path: "data" }));
	}
	try {
		deterministicJsonLine(data);
	} catch {
		return Effect.fail(new ValidationError({ message: "event data must be JSON-serializable", path: "data" }));
	}
	return Effect.succeed({
		version: SCHEMA_VERSION,
		id: clock.randomId(),
		timestamp: clock.now().toISOString(),
		runId,
		type,
		data,
	});
}

export function appendEvent(
	filePath: string,
	event: WorkflowEvent,
	fs: EventFileSystem = nodeEventFileSystem,
): Effect.Effect<void, PersistenceError | ValidationError> {
	return Effect.gen(function* () {
		if (containsCredential(event.data)) {
			return yield* Effect.fail(new ValidationError({ message: "event data must not contain credentials", path: "data" }));
		}
		const line = yield* Effect.try({
			try: () => deterministicJsonLine(event),
			catch: (cause) => new PersistenceError({ operation: "serialize event", path: filePath, cause }),
		});
		if (Buffer.byteLength(line) > MAX_EVENT_BYTES) {
			return yield* Effect.fail(new ValidationError({ message: `event exceeds ${MAX_EVENT_BYTES} bytes`, path: filePath }));
		}
		let handle: AppendFile | undefined;
		yield* Effect.tryPromise({
			try: async () => {
				handle = await fs.openAppend(filePath, FILE_MODE);
				await fs.chmod(filePath, FILE_MODE);
				await handle.writeFile(line);
				await handle.sync();
				await handle.close();
				handle = undefined;
			},
			catch: (cause) => new PersistenceError({ operation: "append event", path: filePath, cause }),
		}).pipe(Effect.ensuring(Effect.promise(() => handle?.close().catch(() => undefined) ?? Promise.resolve())));
	});
}

export function replayEvents(
	filePath: string,
	fs: EventFileSystem = nodeEventFileSystem,
): Effect.Effect<readonly WorkflowEvent[], PersistenceError | CorruptDataError | UnsupportedVersionError> {
	return Effect.gen(function* () {
		const content = yield* Effect.tryPromise({
			try: () => fs.readText(filePath),
			catch: (cause) => new PersistenceError({ operation: "read events", path: filePath, cause }),
		});
		const lines = content.split("\n");
		const events: WorkflowEvent[] = [];
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (line === undefined || !line.trim()) continue;
			const linePath = `${filePath}:${index + 1}`;
			const input = yield* Effect.try({
				try: () => JSON.parse(line) as unknown,
				catch: (cause) => new CorruptDataError({ path: linePath, message: "invalid JSONL event", cause }),
			});
			events.push(yield* decodeWorkflowEvent(input, linePath));
		}
		return events;
	});
}
