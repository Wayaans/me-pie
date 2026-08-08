import { Data } from "effect";

export class TerminalEnvironmentError extends Data.TaggedError("TerminalEnvironmentError")<{
	readonly operation: string;
	readonly message: string;
	readonly cause?: unknown;
}> {}

export function environmentError(operation: string, message: string, cause?: unknown): TerminalEnvironmentError {
	return new TerminalEnvironmentError({ operation, message, ...(cause === undefined ? {} : { cause }) });
}

export function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
