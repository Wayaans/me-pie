import { Effect, Schedule, Semaphore } from "effect";

export function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface TelegramConfig {
	token: string;
	botId: string;
	userId: number;
	chatId: number;
}

export function telegramConfig(env: NodeJS.ProcessEnv): TelegramConfig {
	const reference = env.MEPIE_ASK_ME_TOKEN_ENV ?? "TELEGRAM_BOT_TOKEN";
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) throw new Error("ask_me Telegram token environment reference is invalid");
	const token = env[reference];
	const user = env.MEPIE_ASK_ME_TELEGRAM_USER_ID;
	const chat = env.MEPIE_ASK_ME_TELEGRAM_CHAT_ID;
	if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
		throw new Error("ask_me AFK requires a bot token through MEPIE_ASK_ME_TOKEN_ENV, default TELEGRAM_BOT_TOKEN");
	}
	if (!user || !chat || !/^[1-9]\d*$/.test(user) || !/^[1-9]\d*$/.test(chat)
		|| !Number.isSafeInteger(Number(user)) || !Number.isSafeInteger(Number(chat))) {
		throw new Error("ask_me AFK requires numeric MEPIE_ASK_ME_TELEGRAM_USER_ID and private MEPIE_ASK_ME_TELEGRAM_CHAT_ID");
	}
	return { token, botId: token.split(":")[0] ?? "", userId: Number(user), chatId: Number(chat) };
}

export class TelegramError extends Error {
	readonly name = "TelegramError";
	constructor(readonly kind: "network" | "protocol" | "conflict" | "rejected", readonly retryable = false) {
		super(kind === "conflict"
			? "ask_me Telegram conflict: this bot has a webhook or another getUpdates poller. Use a dedicated bot."
			: `ask_me Telegram ${kind} error. Check connection, bot configuration and permissions.`);
	}
}

export type TelegramMethod = "getWebhookInfo" | "getUpdates" | "sendMessage" | "answerCallbackQuery";
export type TelegramCall = (method: TelegramMethod, body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

/** Never propagate fetch errors or Telegram descriptions: either can contain the token URL. */
export function telegramClient(config: TelegramConfig, http: (url: string, init: RequestInit) => Promise<Response> = fetch): TelegramCall {
	const sending = Semaphore.makeUnsafe(1);
	return (method, body, signal) => {
		if (signal.aborted) return Promise.reject(new TelegramError("network"));
		const attempt = Effect.tryPromise({
			try: async (effectSignal) => {
				if (signal.aborted || effectSignal.aborted) throw new TelegramError("network");
				const deadline = AbortSignal.timeout(method === "getUpdates" ? 40_000 : 15_000);
				let response: Response;
				try {
					response = await http(`https://api.telegram.org/bot${config.token}/${method}`, {
						method: "POST", redirect: "error", headers: { "content-type": "application/json" },
						body: JSON.stringify(body), signal: AbortSignal.any([signal, effectSignal, deadline]),
					});
				} catch { throw new TelegramError("network", method !== "sendMessage"); }
				if (response.status === 409) { await response.body?.cancel(); throw new TelegramError("conflict"); }
				if (!response.ok) {
					await response.body?.cancel();
					throw new TelegramError("rejected", response.status >= 500 && method !== "sendMessage");
				}
				// Bound even successful bodies before parsing external JSON.
				const reader = response.body?.getReader();
				if (!reader) throw new TelegramError("protocol");
				const chunks: Uint8Array[] = [];
				let length = 0;
				try {
					while (true) {
						const next = await reader.read();
						if (next.done) break;
						length += next.value.byteLength;
						if (length > 1_048_576) throw new TelegramError("protocol");
						chunks.push(next.value);
					}
				} finally { await reader.cancel().catch(() => {}); }
				let data: unknown;
				try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
				catch { throw new TelegramError("protocol"); }
				if (!record(data) || typeof data.ok !== "boolean") throw new TelegramError("protocol");
				if (!data.ok) throw new TelegramError(data.error_code === 409 ? "conflict" : "rejected");
				if (!("result" in data)) throw new TelegramError("protocol");
				return data.result;
			},
			catch: (error) => error instanceof TelegramError ? error : new TelegramError("network", method !== "sendMessage"),
		});
		const retried = attempt.pipe(Effect.retry({
			times: 2,
			while: (error) => error.retryable && !signal.aborted,
			schedule: Schedule.spaced("500 millis"),
		}));
		// All requests share one private chat. Pace sends across concurrent sessions.
		const workflow = method === "sendMessage"
			? sending.withPermit(Effect.sleep("1100 millis").pipe(Effect.andThen(retried)))
			: retried;
		return Effect.runPromise(workflow, { signal });
	};
}

export interface TelegramInput {
	updateId: number;
	messageId: number;
	callback?: { id: string; data: string };
	reply?: { to: number; text: string };
}

export function authorizedInput(value: unknown, config: Pick<TelegramConfig, "userId" | "chatId">): TelegramInput | undefined {
	if (!record(value) || !Number.isSafeInteger(value.update_id)) return undefined;
	const callback = value.callback_query;
	const message = record(callback) ? callback.message : value.message;
	const sender = record(callback) ? callback.from : record(message) ? message.from : undefined;
	if (!record(message) || !record(sender) || sender.id !== config.userId || sender.is_bot === true
		|| !record(message.chat) || message.chat.id !== config.chatId || message.chat.type !== "private"
		|| typeof message.message_id !== "number" || !Number.isSafeInteger(message.message_id)) return undefined;
	const updateId = Number(value.update_id);
	if (record(callback)) {
		if (typeof callback.id !== "string" || callback.id.length > 128 || typeof callback.data !== "string" || callback.data.length > 64) return undefined;
		return { updateId, messageId: message.message_id, callback: { id: callback.id, data: callback.data } };
	}
	if (!record(message.reply_to_message) || typeof message.reply_to_message.message_id !== "number"
		|| !Number.isSafeInteger(message.reply_to_message.message_id) || typeof message.text !== "string" || message.text.length > 4096) return undefined;
	return { updateId, messageId: message.message_id, reply: { to: message.reply_to_message.message_id, text: message.text } };
}
