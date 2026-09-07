import { CONFIG_DIR_NAME, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { constants, lstatSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { record, telegramConfig, type TelegramConfig } from "./telegram.ts";
import { readToken, validReference } from "./keychain.ts";

export class SettingsError extends Error { override readonly name = "SettingsError"; }
export interface SavedDestination { version: 1; tokenRef: string; userId: number; chatId: number }
export type Destination = { source: "env"; config: TelegramConfig } | { source: "project" | "global"; config: SavedDestination };
export interface SettingsPaths { global: string; project: string; trusted: boolean }
export interface Snapshot { raw: string | undefined; destination: SavedDestination | undefined }
export const validId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function settingsPaths(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): SettingsPaths {
	return { global: join(getAgentDir(), "ask-me.json"), project: join(ctx.cwd, CONFIG_DIR_NAME, "ask-me.json"), trusted: ctx.isProjectTrusted() };
}

export function parseDestination(value: unknown): SavedDestination {
	if (!record(value) || value.version !== 1 || !validReference(value.tokenRef) || !validId(value.userId) || !validId(value.chatId)
		|| Object.keys(value).some((key) => !["version", "tokenRef", "userId", "chatId"].includes(key))) {
		throw new SettingsError("ask_me settings must contain version 1, a Keychain reference, and complete numeric private chat/user IDs. No token or extra fields are allowed.");
	}
	return { version: 1, tokenRef: value.tokenRef, userId: value.userId, chatId: value.chatId };
}

function checkParent(path: string): void {
	try {
		const stat = lstatSync(dirname(path));
		if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new Error();
	} catch (error) {
		if (record(error) && error.code === "ENOENT") return;
		throw new SettingsError("ask_me settings directory must be owned by you, not symlinked or writable by other users.");
	}
}

export function readSettings(path: string): Snapshot {
	checkParent(path);
	let fd: number;
	try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) {
		if (record(error) && error.code === "ENOENT") return { raw: undefined, destination: undefined };
		throw new SettingsError("ask_me settings cannot be read. Check file ownership and permissions; no fallback was made.");
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw new Error();
		const bytes = Buffer.alloc(4097);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, null);
			if (count === 0) break;
			length += count;
		}
		if (length > 4096) throw new Error();
		const raw = bytes.subarray(0, length).toString("utf8");
		let value: unknown;
		try { value = JSON.parse(raw); } catch { throw new SettingsError("ask_me settings contain invalid JSON; no fallback was made."); }
		return { raw, destination: parseDestination(value) };
	} catch (error) {
		if (error instanceof SettingsError) throw error;
		throw new SettingsError("ask_me settings must be an owner-private regular file of at most 4096 bytes; no fallback was made.");
	} finally { closeSync(fd); }
}

/** Only ask-me-specific variables opt in. An unrelated TELEGRAM_BOT_TOKEN alone is ignored. */
export function environmentOverride(env: NodeJS.ProcessEnv): TelegramConfig | undefined {
	if (!["MEPIE_ASK_ME_TOKEN_ENV", "MEPIE_ASK_ME_TELEGRAM_USER_ID", "MEPIE_ASK_ME_TELEGRAM_CHAT_ID"].some((key) => env[key] !== undefined)) return undefined;
	try { return telegramConfig(env); }
	catch { throw new SettingsError("ask_me environment override is incomplete or invalid. Set both MEPIE_ASK_ME_TELEGRAM_USER_ID and MEPIE_ASK_ME_TELEGRAM_CHAT_ID plus the token variable selected by MEPIE_ASK_ME_TOKEN_ENV (default TELEGRAM_BOT_TOKEN), or unset all three MEPIE_ASK_ME settings. Saved destinations were not used."); }
}

export function resolveDestination(paths: SettingsPaths, env: NodeJS.ProcessEnv = process.env): Destination | undefined {
	const override = environmentOverride(env);
	if (override) return { source: "env", config: override };
	if (paths.trusted) {
		const project = readSettings(paths.project).destination;
		if (project) return { source: "project", config: project };
	}
	const global = readSettings(paths.global).destination;
	return global ? { source: "global", config: global } : undefined;
}

export function describeDestination(destination: Destination | undefined, platform = process.platform): string {
	if (!destination) return "Configuration: not configured. Run /ask-me setup.";
	const credential = destination.source === "env" ? "Environment token present." : platform === "darwin"
		? "Keychain reference present, credential not checked."
		: "Not ready: saved Keychain credentials require macOS. Use an explicit environment override on this platform.";
	return `Configuration source: ${destination.source}. User ID: ${destination.config.userId}. Private chat ID: ${destination.config.chatId}. ${credential} Telegram connectivity not tested.`;
}

export function loadTelegramConfig(destination: Destination, signal: AbortSignal, read = readToken) {
	return Effect.tryPromise({
		try: async (effectSignal) => {
			const combined = AbortSignal.any([signal, effectSignal]);
			combined.throwIfAborted();
			if (destination.source === "env") return destination.config;
			const token = await read(destination.config.tokenRef, combined);
			return telegramConfig({ TELEGRAM_BOT_TOKEN: token, MEPIE_ASK_ME_TELEGRAM_USER_ID: String(destination.config.userId), MEPIE_ASK_ME_TELEGRAM_CHAT_ID: String(destination.config.chatId) });
		},
		catch: () => new SettingsError("ask_me could not resolve the configured token. Check Keychain access and token validity; no fallback was made."),
	});
}

/** Exclusive lock + optimistic snapshot prevents two wizards overwriting each other's choices. */
export async function saveSettings(path: string, expected: Snapshot, destination: SavedDestination | undefined, beforeCommit: () => Promise<void>, signal: AbortSignal): Promise<void> {
	if (destination) parseDestination(destination);
	signal.throwIfAborted();
	checkParent(path);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	checkParent(path);
	let lock;
	try { lock = await open(`${path}.lock`, "wx", 0o600); }
	catch { throw new SettingsError("ask_me settings are locked by another setup. Retry after it finishes. A stale ask-me.json.lock requires manual removal."); }
	const temporary = `${path}.${randomUUID()}.tmp`;
	let created = false;
	try {
		if (readSettings(path).raw !== expected.raw) throw new SettingsError("ask_me settings changed during setup. Nothing was replaced; run setup again.");
		if (destination) {
			const file = await open(temporary, "wx", 0o600);
			created = true;
			try { await file.writeFile(`${JSON.stringify(destination, null, 2)}\n`); await file.sync(); }
			finally { await file.close(); }
		}
		signal.throwIfAborted();
		await beforeCommit();
		signal.throwIfAborted();
		if (readSettings(path).raw !== expected.raw) throw new SettingsError("ask_me settings changed during save. Previous configuration was preserved.");
		if (destination) await rename(temporary, path);
		else if (expected.raw !== undefined) await unlink(path);
	} catch (error) {
		if (error instanceof SettingsError) throw error;
		throw new SettingsError("ask_me setup could not save. Previous configuration was preserved. A newly created Keychain item may remain unused; no existing credential was changed.");
	} finally {
		if (created) await unlink(temporary).catch(() => {});
		await lock.close();
		await unlink(`${path}.lock`);
	}
}
