import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Effect } from "effect";
import { environmentError, errorMessage, type TerminalEnvironmentError } from "./errors.ts";

const MAX_CAPTURE_BYTES = 64 * 1_024;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface CommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
}

export interface CommandOptions {
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	readonly env?: NodeJS.ProcessEnv;
}

export interface CommandRunner {
	run(executable: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
}

export const nodeCommandRunner: CommandRunner = {
	run(executable, args, options = {}) {
		return new Promise((resolve, reject) => {
			const child = spawn(executable, [...args], {
				env: options.env ?? process.env,
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
			});
			let stdout = "";
			let stderr = "";
			let stdoutBytes = 0;
			let stderrBytes = 0;
			let settled = false;
			let timedOut = false;
			const finish = (result: CommandResult): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				resolve(result);
			};
			const fail = (cause: unknown): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				reject(cause);
			};
			const capture = (current: string, currentBytes: number, chunk: Buffer | string): { readonly text: string; readonly bytes: number } => {
				const incoming = String(chunk);
				const incomingBytes = Buffer.byteLength(incoming);
				if (currentBytes + incomingBytes > MAX_CAPTURE_BYTES) {
					child.kill("SIGKILL");
					fail(new Error(`Command output exceeded ${MAX_CAPTURE_BYTES} bytes.`));
					return { text: current, bytes: currentBytes };
				}
				return { text: current + incoming, bytes: currentBytes + incomingBytes };
			};
			const abort = (): void => { child.kill("SIGTERM"); };
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) abort();
			child.stdout.on("data", (chunk: Buffer | string) => {
				const captured = capture(stdout, stdoutBytes, chunk);
				stdout = captured.text; stdoutBytes = captured.bytes;
			});
			child.stderr.on("data", (chunk: Buffer | string) => {
				const captured = capture(stderr, stderrBytes, chunk);
				stderr = captured.text; stderrBytes = captured.bytes;
			});
			child.once("error", fail);
			child.once("close", (code) => {
				if (options.signal?.aborted) { fail(options.signal.reason ?? new DOMException("Aborted", "AbortError")); return; }
				if (timedOut) { fail(new Error(`Command timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`)); return; }
				finish({ stdout, stderr, code: code ?? -1 });
			});
		});
	},
};

export function runCommand(
	runner: CommandRunner,
	executable: string,
	args: readonly string[],
	operation: string,
	environment?: NodeJS.ProcessEnv,
): Effect.Effect<CommandResult, TerminalEnvironmentError> {
	return Effect.tryPromise({
		try: (signal) => runner.run(executable, args, { signal, ...(environment === undefined ? {} : { env: environment }) }),
		catch: (cause) => environmentError(operation, errorMessage(cause), cause),
	});
}

export function findExecutable(
	name: string,
	environment: NodeJS.ProcessEnv,
): Effect.Effect<string, TerminalEnvironmentError> {
	return Effect.tryPromise({
		try: async (signal) => {
			for (const directory of (environment.PATH ?? "").split(path.delimiter)) {
				signal.throwIfAborted();
				if (!directory) continue;
				const candidate = path.join(directory, name);
				try {
					await access(candidate, fsConstants.X_OK);
					return path.resolve(candidate);
				} catch { /* Keep searching PATH. */ }
			}
			throw new Error(`${name} was not found in PATH.`);
		},
		catch: (cause) => environmentError("resolve executable", errorMessage(cause), cause),
	});
}
