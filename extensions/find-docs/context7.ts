import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { Data, Effect } from "effect";

const DEFAULT_CTX7_TIMEOUT_MS = 60_000;
const LIBRARY_ID_PATTERN = /^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/;

export interface FindDocsInput {
	readonly query: string;
	readonly library?: string | undefined;
	readonly libraryId?: string | undefined;
}

export type FindDocsOutcome =
	| {
			readonly status: "found";
			readonly query: string;
			readonly library?: string | undefined;
			readonly libraryId: string;
			readonly docs: string;
			readonly resolvedLibrary: boolean;
		}
	| {
			readonly status: "library-not-found";
			readonly query: string;
			readonly library: string;
		}
	| {
			readonly status: "docs-not-found";
			readonly query: string;
			readonly library?: string | undefined;
			readonly libraryId: string;
			readonly resolvedLibrary: boolean;
		};

export type Context7ErrorKind = "command" | "invalid-input" | "invalid-response" | "quota" | "timeout";

export class Context7Error extends Data.TaggedError("Context7Error")<{
	readonly kind: Context7ErrorKind;
	readonly message: string;
	readonly cause?: unknown;
}> {}

export type Context7CommandRunner = (
	command: string,
	args: string[],
	options: ExecOptions,
) => Promise<ExecResult>;

type Context7Command = "ctx7" | "bunx";

interface CommandOutput {
	readonly stdout: string;
	readonly stderr: string;
}

function context7Error(kind: Context7ErrorKind, message: string, cause?: unknown): Context7Error {
	return new Context7Error({ kind, message, ...(cause === undefined ? {} : { cause }) });
}

function commandLabel(command: Context7Command): string {
	return command === "ctx7" ? "ctx7" : "bunx --bun ctx7@latest";
}

function commandArgs(command: Context7Command, args: string[]): string[] {
	return command === "ctx7" ? args : ["--bun", "ctx7@latest", ...args];
}

function commandTimeoutMs(command: Context7Command): number {
	return command === "ctx7" ? DEFAULT_CTX7_TIMEOUT_MS : DEFAULT_CTX7_TIMEOUT_MS * 2;
}

function commandFailure(command: Context7Command, result: ExecResult): Context7Error {
	const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
	if (/quota|monthly quota reached|quota exceeded/i.test(output)) {
		return context7Error(
			"quota",
			`Context7 quota exhausted. Run ctx7 login for higher limits.${output ? `\n\n${output}` : ""}`,
		);
	}
	if (result.killed) {
		return context7Error("timeout", `${commandLabel(command)} timed out after ${commandTimeoutMs(command)}ms.`);
	}
	return context7Error(
		"command",
		output || `${commandLabel(command)} failed with exit code ${result.code}.`,
	);
}

function commandUnavailable(result: ExecResult): boolean {
	return result.code !== 0 && !result.killed && !result.stdout.trim() && !result.stderr.trim();
}

function executeCommand(
	runner: Context7CommandRunner,
	command: Context7Command,
	args: string[],
): Effect.Effect<CommandOutput, Context7Error> {
	return Effect.tryPromise({
		try: (signal) => runner(command, commandArgs(command, args), {
			signal,
			timeout: commandTimeoutMs(command),
		}),
		catch: (cause) => context7Error("command", `${commandLabel(command)} could not run.`, cause),
	}).pipe(
		Effect.flatMap((result) => result.code === 0
			? Effect.succeed({ stdout: result.stdout, stderr: result.stderr })
			: Effect.fail(commandFailure(command, result))),
	);
}

function makeContext7Client(runner: Context7CommandRunner) {
	let selectedCommand: Context7Command | undefined;

	return (args: string[]): Effect.Effect<CommandOutput, Context7Error> => {
		if (selectedCommand) return executeCommand(runner, selectedCommand, args);

		return Effect.tryPromise({
			try: (signal) => runner("ctx7", args, { signal, timeout: DEFAULT_CTX7_TIMEOUT_MS }),
			catch: (cause) => context7Error("command", "ctx7 could not run.", cause),
		}).pipe(
			Effect.flatMap((result) => {
				if (result.code === 0) {
					selectedCommand = "ctx7";
					return Effect.succeed({ stdout: result.stdout, stderr: result.stderr });
				}
				if (!commandUnavailable(result)) return Effect.fail(commandFailure("ctx7", result));

				return executeCommand(runner, "bunx", args).pipe(
					Effect.tap(() => Effect.sync(() => { selectedCommand = "bunx"; })),
				);
			}),
		);
	};
}

export function isContext7LibraryId(value: string): boolean {
	return LIBRARY_ID_PATTERN.test(value);
}

export function parseContext7LibraryId(output: string): Effect.Effect<string | undefined, Context7Error> {
	return Effect.try({
		try: () => JSON.parse(output) as unknown,
		catch: (cause) => context7Error("invalid-response", "Context7 returned invalid library search JSON.", cause),
	}).pipe(
		Effect.flatMap((value) => {
			if (!Array.isArray(value)) {
				return Effect.fail(context7Error("invalid-response", "Context7 library search returned an unexpected response."));
			}
			if (value.length === 0) return Effect.succeed(undefined);

			const first = value[0];
			if (typeof first !== "object" || first === null || !("id" in first) || typeof first.id !== "string") {
				return Effect.fail(context7Error("invalid-response", "Context7 library search did not return a library ID."));
			}
			const libraryId = first.id.trim();
			return isContext7LibraryId(libraryId)
				? Effect.succeed(libraryId)
				: Effect.fail(context7Error("invalid-response", `Context7 returned an invalid library ID: ${libraryId || "(empty)"}.`));
		}),
	);
}

function normalizeInput(input: FindDocsInput): Effect.Effect<FindDocsInput, Context7Error> {
	const query = input.query.trim();
	const library = input.library?.trim();
	const libraryId = input.libraryId?.trim();

	if (!query) return Effect.fail(context7Error("invalid-input", "find_docs requires a non-empty query."));
	if (input.library !== undefined && !library) {
		return Effect.fail(context7Error("invalid-input", "find_docs library cannot be blank."));
	}
	if (input.libraryId !== undefined && !libraryId) {
		return Effect.fail(context7Error("invalid-input", "find_docs libraryId cannot be blank."));
	}
	if (libraryId && !isContext7LibraryId(libraryId)) {
		return Effect.fail(context7Error(
			"invalid-input",
			`Invalid Context7 library ID: ${libraryId}. Expected /owner/project or /owner/project/version.`,
		));
	}
	if (!libraryId && !library) {
		return Effect.fail(context7Error("invalid-input", "find_docs requires either library or libraryId."));
	}

	return Effect.succeed({
		query,
		...(library ? { library } : {}),
		...(libraryId ? { libraryId } : {}),
	});
}

export function findDocumentation(
	input: FindDocsInput,
	runner: Context7CommandRunner,
): Effect.Effect<FindDocsOutcome, Context7Error> {
	return Effect.gen(function* () {
		const normalized = yield* normalizeInput(input);
		const runContext7 = makeContext7Client(runner);
		let libraryId = normalized.libraryId;
		const resolvedLibrary = libraryId === undefined;

		if (!libraryId) {
			const library = normalized.library;
			if (!library) return yield* context7Error("invalid-input", "find_docs requires a library name.");

			const resolution = yield* runContext7(["library", library, normalized.query, "--json"]);
			if (!resolution.stdout.trim()) {
				return { status: "library-not-found", library, query: normalized.query };
			}
			libraryId = yield* parseContext7LibraryId(resolution.stdout);
			if (!libraryId) return { status: "library-not-found", library, query: normalized.query };
		}

		const docs = yield* runContext7(["docs", libraryId, normalized.query]);
		const docsText = docs.stdout.trim();
		if (!docsText) {
			return {
				status: "docs-not-found",
				query: normalized.query,
				...(normalized.library ? { library: normalized.library } : {}),
				libraryId,
				resolvedLibrary,
			};
		}

		return {
			status: "found",
			query: normalized.query,
			...(normalized.library ? { library: normalized.library } : {}),
			libraryId,
			docs: docsText,
			resolvedLibrary,
		};
	});
}
