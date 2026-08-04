import { Data } from "effect";
import type { TmuxWindowState } from "../domain.ts";

export interface TmuxSessionIdentity {
	readonly serverSocketPath: string;
	readonly sessionId: string;
	readonly sessionName: string;
	readonly paneId: string;
}

export type TmuxWindowHandle = TmuxWindowState;

export interface TmuxCommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
	readonly timedOut?: boolean;
}

export interface TmuxCommandOptions {
	readonly cwd?: string;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
}

export interface TmuxCommandRunner {
	readonly run: (
		executable: string,
		args: readonly string[],
		options: TmuxCommandOptions,
	) => Promise<TmuxCommandResult>;
}

export class MissingTmuxError extends Data.TaggedError("MissingTmuxError")<{
	readonly message: string;
}> {}

export class TmuxCommandTimeoutError extends Data.TaggedError("TmuxCommandTimeoutError")<{
	readonly command: string;
	readonly timeoutMs: number;
}> {}

export class UnexpectedTmuxOutputError extends Data.TaggedError("UnexpectedTmuxOutputError")<{
	readonly operation: string;
	readonly output: string;
}> {}

export class VanishedTmuxSessionError extends Data.TaggedError("VanishedTmuxSessionError")<{
	readonly sessionId?: string;
	readonly message: string;
}> {}

export class TmuxCommandError extends Data.TaggedError("TmuxCommandError")<{
	readonly operation: string;
	readonly code: number;
	readonly stderr: string;
}> {}

export class ForeignTmuxHandleError extends Data.TaggedError("ForeignTmuxHandleError")<{
	readonly message: string;
}> {}

export class WorkerLaunchError extends Data.TaggedError("WorkerLaunchError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}
