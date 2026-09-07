import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Effect, Schedule } from "effect";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { BRIDGE_VERSION, configurationFingerprint, readFrames, sendFrame, type BridgeProgress, type StopReason } from "./bridge-protocol.ts";
import { bridgeDirectory, privateDirectory } from "./bridge-runtime.ts";
import { canSubmitDraft, draftDetails, validateDraft, type AskMeDraft } from "./draft.ts";
import type { AskMeDetails, AskMeRequest } from "./schema.ts";
import { record, telegramConfig, type TelegramConfig } from "./telegram.ts";

async function connectSocket(path: string, signal: AbortSignal): Promise<Socket> {
	const info = await lstat(path);
	if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("ask_me bridge socket is not private");
	return new Promise<Socket>((resolve, reject) => {
		const socket = connect(path);
		const abort = () => { socket.destroy(); reject(new Error("ask_me bridge connection cancelled")); };
		const timer = setTimeout(abort, 1500);
		const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
		signal.addEventListener("abort", abort, { once: true });
		socket.once("error", () => { cleanup(); reject(new Error("ask_me bridge connection unavailable")); });
		socket.once("connect", () => { cleanup(); resolve(socket); });
		if (signal.aborted) abort();
	});
}

async function openBridge(config: TelegramConfig, signal: AbortSignal): Promise<Socket> {
	const directory = bridgeDirectory(config.botId);
	await privateDirectory(dirname(directory));
	const path = join(directory, "socket");
	try {
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("unsafe");
	} catch (error) {
		if (!record(error) || error.code !== "ENOENT") throw new Error("ask_me bridge directory is not private");
	}
	try { return await connectSocket(path, signal); } catch { signal.throwIfAborted(); }
	let piEntry: string;
	try {
		if (process.versions.bun) throw new Error("Node runtime required");
		piEntry = join(getPackageDir(), "dist", "index.js");
		createRequire(piEntry).resolve("jiti");
	} catch { throw new Error("ask_me AFK needs the Node Pi installation with its jiti runtime available"); }
	const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "bridge-launcher.cjs"), piEntry], {
		detached: true, stdio: "ignore",
		env: {
			TELEGRAM_BOT_TOKEN: config.token,
			MEPIE_ASK_ME_TELEGRAM_USER_ID: String(config.userId),
			MEPIE_ASK_ME_TELEGRAM_CHAT_ID: String(config.chatId),
		},
	});
	child.on("error", () => {});
	child.unref();
	const attempt = Effect.tryPromise({ try: () => connectSocket(path, signal), catch: () => new Error("ask_me bridge could not start. Another process may be starting it, or a crashed owner's lock needs manual cleanup. See extensions/ask-me/README.md.") });
	return Effect.runPromise(attempt.pipe(Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") })), { signal });
}

export interface RemoteProgress { phase: "connecting" | BridgeProgress; id: string; answered: number; total: number }
export function remoteProgressText(progress: RemoteProgress): string {
	const phase = { connecting: "Connecting to Telegram", sending: "Sending Telegram page", waiting: "Waiting for Telegram answer", writing: "Waiting for written Telegram answer" }[progress.phase];
	return `${phase}. ${progress.answered}/${progress.total} answered.`;
}

export interface RemoteResult { details: AskMeDetails; handoff: boolean }
export interface RemoteHandle { result: Promise<RemoteResult>; stop: (reason: StopReason) => void }

export function remoteQuestionnaire(
	request: AskMeRequest,
	initial: AskMeDraft,
	label: string,
	signal: AbortSignal,
	progress: (status: RemoteProgress) => void,
	connection: (config: TelegramConfig, signal: AbortSignal) => Promise<Socket> = openBridge,
	env: NodeJS.ProcessEnv = process.env,
	resolveConfig?: (signal: AbortSignal) => Promise<TelegramConfig>,
): RemoteHandle {
	const immediateConfig = resolveConfig ? undefined : telegramConfig(env);
	const id = randomUUID();
	const startup = new AbortController();
	let draft = validateDraft(request, initial);
	let socket: Socket | undefined;
	let stopReason: StopReason | undefined;
	let stopTimer: ReturnType<typeof setTimeout> | undefined;
	let forceStop: (() => void) | undefined;
	const stop = (reason: StopReason) => {
		if (stopReason) return;
		stopReason = reason;
		if (!socket) startup.abort();
		else {
			sendFrame(socket, { type: "stop", id, reason });
			stopTimer = setTimeout(() => forceStop?.(), 2000);
		}
	};
	const abort = () => stop("cancel");
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	const cancelled = (): RemoteResult => ({ details: draftDetails(request, draft), handoff: stopReason === "handoff" });
	const result = (async (): Promise<RemoteResult> => {
		progress({ phase: "connecting", id, answered: draft.answers.length, total: request.questions.length });
		try {
			if (stopReason) return cancelled();
			const config = immediateConfig ?? await resolveConfig?.(startup.signal);
			if (!config) throw new Error("ask_me Telegram configuration is unavailable");
			if (stopReason) return cancelled();
			socket = await connection(config, startup.signal);
			const connected = socket;
			return await new Promise<RemoteResult>((resolve, reject) => {
				let ready = false;
				let settled = false;
				const finish = (value: RemoteResult | Error) => {
					if (settled) return;
					settled = true;
					clearTimeout(readyTimer);
					if (value instanceof Error) reject(value); else resolve(value);
				};
				const readyTimer = setTimeout(() => finish(new Error("ask_me bridge handshake timed out")), 180_000);
				forceStop = () => { connected.destroy(); finish(cancelled()); };
				connected.on("error", () => finish(stopReason ? cancelled() : new Error("ask_me Telegram bridge disconnected. The remote request is invalid; retry ask_me.")));
				connected.on("close", () => finish(stopReason ? cancelled() : new Error("ask_me Telegram bridge disconnected. The remote request is invalid; retry ask_me.")));
				readFrames(connected, (raw) => {
					if (!record(raw)) throw new Error("Invalid bridge response");
					if (raw.type === "ready" && !ready) {
						if (raw.version !== BRIDGE_VERSION || raw.configuration !== configurationFingerprint(config)) {
							finish(new Error("ask_me running bridge uses different settings or protocol. Finish its pending requests and wait for it to exit before retrying. No restart or takeover was attempted.")); return;
						}
						ready = true; clearTimeout(readyTimer);
						if (stopReason) { finish(cancelled()); return; }
						sendFrame(connected, { type: "open", id, label: label.slice(0, 256), request, draft, userId: config.userId, chatId: config.chatId });
						return;
					}
					if (raw.type === "error" && (raw.id === undefined || raw.id === id)) {
						const message = typeof raw.message === "string" ? raw.message.replaceAll(config.token, "[redacted]").replace(/https?:\/\/\S+/g, "[redacted URL]").slice(0, 512) : "ask_me Telegram bridge failed";
						finish(new Error(message)); return;
					}
					if (!ready || raw.id !== id) throw new Error("Uncorrelated bridge response");
					if (raw.type !== "progress" && raw.type !== "result") throw new Error("Invalid bridge response");
					draft = validateDraft(request, raw.draft);
					if (raw.type === "progress") {
						if (raw.status !== "sending" && raw.status !== "waiting" && raw.status !== "writing") throw new Error("Invalid bridge progress");
						progress({ phase: raw.status, id, answered: draft.answers.length, total: request.questions.length });
						return;
					}
					if (raw.status !== "submitted" && raw.status !== "cancelled") throw new Error("Invalid bridge result");
					if (raw.status === "submitted" && !canSubmitDraft(request, draft)) throw new Error("Incomplete bridge submission");
					finish({ details: draftDetails(request, draft, raw.status), handoff: raw.status === "cancelled" && raw.reason === "handoff" && stopReason === "handoff" });
				});
				if (stopReason) finish(cancelled());
			});
		} catch (error) {
			if (stopReason) return cancelled();
			throw error;
		} finally {
			if (stopTimer) clearTimeout(stopTimer);
			socket?.destroy();
			signal.removeEventListener("abort", abort);
		}
	})();
	return { result, stop };
}
