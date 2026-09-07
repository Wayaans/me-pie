import { mkdir, lstat, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { telegramClient, telegramConfig, type TelegramCall, type TelegramConfig } from "./telegram.ts";
import { runBridgeServer } from "./bridge-server.ts";

export function bridgeDirectory(botId: string): string {
	if (!/^\d+$/.test(botId) || !process.getuid) throw new Error("ask_me AFK requires a Unix host and numeric bot ID");
	// Keep below macOS's 104-byte Unix socket path limit, independent of TMPDIR.
	return join("/tmp", `mepie-ask-me-${process.getuid()}`, botId);
}

export async function privateDirectory(path: string): Promise<void> {
	await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
		if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw new Error("ask_me cannot create its private bridge directory");
	});
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
		throw new Error("ask_me bridge directory must be owned by this user with mode 0700, without symlinks");
	}
}

export async function runOwnedBridge(directory: string, config: TelegramConfig, call: TelegramCall, signal: AbortSignal, idleMs = 15_000): Promise<void> {
	await privateDirectory(join(directory, ".."));
	// Atomic mkdir is the cross-process election. Never steal a lock: a crashed
	// owner's directory requires explicit operator cleanup, not a racy PID guess.
	const acquire = Effect.tryPromise({
		try: async () => {
			await mkdir(directory, { mode: 0o700 });
			return directory;
		},
		catch: () => new Error("ask_me bridge election already owned"),
	});
	await Effect.runPromise(Effect.acquireUseRelease(acquire,
		() => Effect.tryPromise({
			try: async () => {
				await writeFile(join(directory, "pid"), String(process.pid), { mode: 0o600, flag: "wx" });
				await runBridgeServer(join(directory, "socket"), config, call, signal, idleMs);
			},
			catch: () => new Error("ask_me bridge stopped"),
		}),
		() => Effect.promise(async () => {
			await unlink(join(directory, "socket")).catch(() => {});
			await unlink(join(directory, "pid")).catch(() => {});
			await rmdir(directory).catch(() => {});
		}),
	));
}

export async function bridgeMain(): Promise<void> {
	const config = telegramConfig(process.env);
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	try {
		await runOwnedBridge(bridgeDirectory(config.botId), config, telegramClient(config), controller.signal);
	} finally {
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGINT", stop);
	}
}
