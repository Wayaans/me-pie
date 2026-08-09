import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { environmentError, errorMessage, TerminalEnvironmentError } from "./errors.ts";
import { TERMINAL_ENVIRONMENT_RUNTIME_ROOT } from "./paths.ts";

export function quotePosix(value: string): string {
	if (value.includes("\0")) throw environmentError("create launcher", "Launcher arguments cannot contain NUL bytes.");
	return value.length === 0 ? "''" : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function launcherScript(
	executable: string,
	args: readonly string[],
	environment: Readonly<Record<string, string>> = {},
): string {
	const exports = Object.entries(environment).map(([key, value]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw environmentError("create launcher", `Invalid launcher environment key: ${key}`);
		if (value.includes("\0")) throw environmentError("create launcher", `Launcher environment ${key} contains a NUL byte.`);
		return `export ${key}=${quotePosix(value)}`;
	});
	return [
		"#!/bin/sh",
		"set -eu",
		...exports,
		"launcher=$0",
		"runtime_dir=${launcher%/*}",
		"rm -f -- \"$launcher\"",
		"rmdir -- \"$runtime_dir\" 2>/dev/null || true",
		`exec ${[executable, ...args].map(quotePosix).join(" ")}`,
		"",
	].join("\n");
}

export function makeLauncher(
	executable: string,
	args: readonly string[],
	environment: Readonly<Record<string, string>> = {},
): Effect.Effect<string, TerminalEnvironmentError> {
	return Effect.tryPromise({
		try: async (signal) => {
			signal.throwIfAborted();
			const directory = path.join(TERMINAL_ENVIRONMENT_RUNTIME_ROOT, `launcher-${crypto.randomUUID()}`);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			try {
				await chmod(directory, 0o700);
				const launcherPath = path.join(directory, "launch.sh");
				await writeFile(launcherPath, launcherScript(executable, args, environment), { encoding: "utf8", mode: 0o700, flag: "wx", signal });
				await chmod(launcherPath, 0o700);
				return launcherPath;
			} catch (cause) {
				await rm(directory, { recursive: true, force: true }).catch(() => undefined);
				throw cause;
			}
		},
		catch: (cause) => cause instanceof TerminalEnvironmentError
			? cause
			: environmentError("create launcher", errorMessage(cause), cause),
	});
}

export function removeLauncher(launcherPath: string): Effect.Effect<void> {
	return Effect.promise(async () => {
		await rm(path.dirname(launcherPath), { recursive: true, force: true }).catch(() => undefined);
	});
}
