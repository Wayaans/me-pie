import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { PiLaunchProfile } from "../domain.ts";
import type { TmuxCommandOptions, TmuxCommandResult, TmuxCommandRunner } from "./types.ts";

export const DEFAULT_TMUX_TIMEOUT_MS = 3_000;

export const nodeCommandRunner: TmuxCommandRunner = {
	run(executable, args, options) {
		return new Promise((resolve, reject) => {
			const child = spawn(executable, [...args], {
				cwd: options.cwd,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
			});
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timedOut = false;
			const finish = (result: TmuxCommandResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				resolve(result);
			};
			const abort = () => child.kill("SIGTERM");
			const fail = (cause: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				reject(cause);
			};
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, options.timeoutMs);
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) abort();
			child.stdout.on("data", (chunk) => { stdout += String(chunk); });
			child.stderr.on("data", (chunk) => { stderr += String(chunk); });
			child.on("error", fail);
			child.on("close", (code) => finish({ stdout, stderr, code: code ?? -1, timedOut }));
		});
	},
};

export function quotePosixArgument(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export interface WorkerEnvironmentInput {
	readonly runId: string;
	readonly workItemId: string;
	readonly profile: PiLaunchProfile;
	/** Launch metadata is intentionally carried outside the prompt. */
	readonly kind?: "implementation" | "audit" | "fix";
	readonly socketPath: string;
	readonly token: string;
}

export function buildWorkerEnvironment(input: WorkerEnvironmentInput): Readonly<Record<string, string>> {
	return {
		MEPIE_WORKFLOW_ROLE: "worker",
		MEPIE_WORKFLOW_RUN_ID: input.runId,
		MEPIE_WORKFLOW_ITEM_ID: input.workItemId,
		MEPIE_WORKFLOW_REQUESTED_MODEL: input.profile.model,
		MEPIE_WORKFLOW_REQUESTED_THINKING: input.profile.thinking,
		...(input.kind === undefined ? {} : { MEPIE_WORKFLOW_WORKER_KIND: input.kind }),
		MEPIE_WORKFLOW_SOCKET: input.socketPath,
		MEPIE_WORKFLOW_TOKEN: input.token,
	};
}

export function buildPiArguments(profile: PiLaunchProfile, packageRoot: string, options: { readonly readOnly?: boolean } = {}): readonly string[] {
	return [
		"--model", profile.model,
		"--thinking", profile.thinking,
		...(options.readOnly ? ["--tools", "read,grep,find,ls"] : []),
		"--extension", packageRoot,
	];
}

export function buildLauncherScript(
	piExecutable: string,
	args: readonly string[],
	environment: Readonly<Record<string, string>>,
): string {
	const exports = Object.entries(environment).map(([key, value]) => `export ${key}=${quotePosixArgument(value)}`);
	return [
		"#!/bin/sh",
		"set -eu",
		'launcher=$0',
		'rm -f -- "$launcher"',
		...exports,
		`exec ${[piExecutable, ...args].map(quotePosixArgument).join(" ")}`,
		"",
	].join("\n");
}

export async function writeOwnerOnlyLauncher(directory: string, script: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	signal?.throwIfAborted();
	await chmod(directory, 0o700);
	const launcherPath = path.join(directory, `worker-${crypto.randomUUID()}.sh`);
	await writeFile(launcherPath, script, { encoding: "utf8", mode: 0o700, flag: "wx", signal });
	signal?.throwIfAborted();
	await chmod(launcherPath, 0o700);
	return launcherPath;
}

export async function resolveExecutable(name: string, searchPath = process.env.PATH, signal?: AbortSignal): Promise<string | undefined> {
	signal?.throwIfAborted();
	if (name.includes(path.sep)) {
		try {
			await access(name, fsConstants.X_OK);
			return path.resolve(name);
		} catch {
			return undefined;
		}
	}
	for (const directory of (searchPath ?? "").split(path.delimiter)) {
		signal?.throwIfAborted();
		if (!directory) continue;
		const candidate = path.join(directory, name);
		try {
			await access(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// Continue searching PATH.
		}
	}
	return undefined;
}

export function workflowRuntimeDirectory(runId: string): string {
	const safeRunId = runId.replace(/[^A-Za-z0-9_.-]/g, "-");
	return path.join(os.tmpdir(), "mepie-ticket-flow", safeRunId);
}
