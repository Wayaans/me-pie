import { Cause, Data } from "effect";

export type Provider = "firecrawl" | "openai" | "http" | "github";

export class ConfigError extends Data.TaggedError("ConfigError")<{
	readonly message: string;
}> {}

export class FirecrawlError extends Data.TaggedError("FirecrawlError")<{
	readonly message: string;
	readonly status?: number | undefined;
	readonly retryable: boolean;
	/** True when the request never got an HTTP response (DNS/TLS/connect failure). */
	readonly network: boolean;
}> {}

export class OpenAIError extends Data.TaggedError("OpenAIError")<{
	readonly message: string;
	readonly status?: number;
	readonly retryable: boolean;
}> {}

export class HttpError extends Data.TaggedError("HttpError")<{
	readonly message: string;
	readonly status?: number;
}> {}

export class SsrfBlockedError extends Data.TaggedError("SsrfBlockedError")<{
	readonly message: string;
}> {}

export class GitHubError extends Data.TaggedError("GitHubError")<{
	readonly message: string;
}> {}

export class CacheError extends Data.TaggedError("CacheError")<{
	readonly message: string;
}> {}

export type WebwebError =
	| ConfigError
	| FirecrawlError
	| OpenAIError
	| HttpError
	| SsrfBlockedError
	| GitHubError
	| CacheError;

export function isTransientStatus(status: number | undefined): boolean {
	return status !== undefined && (status === 429 || status >= 500);
}

/** Strip secrets from provider messages before they reach tool output or logs. */
export function redact(text: string, secrets: Array<string | undefined>): string {
	let result = text;
	for (const secret of secrets) {
		if (secret) result = result.split(secret).join("[redacted]");
	}
	return result;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Extract a readable message from an Effect 4 Cause (typed failure preferred). */
export function causeMessage(cause: Cause.Cause<unknown>): string {
	const fail = cause.reasons.find((reason): reason is Cause.Fail<unknown> => reason._tag === "Fail");
	if (fail) return errorMessage(fail.error);
	return cause.reasons.length > 0 ? "operation failed" : "operation interrupted";
}
