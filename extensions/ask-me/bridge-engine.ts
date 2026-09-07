import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { RemoteDraft, type RemoteAction } from "./draft.ts";
import type { BridgeRequest, BridgeResponse, StopReason } from "./bridge-protocol.ts";
import { authorizedInput, record, TelegramError, type TelegramCall, type TelegramConfig, type TelegramInput } from "./telegram.ts";
import { compactTelegramLabel, escapeTelegramHtml, shortRequestId, telegramHtmlChunks } from "./telegram-view.ts";

interface Client {
	send: (response: BridgeResponse) => void;
}
interface Pending {
	id: string;
	label: string;
	owner: Client;
	state: RemoteDraft;
	controller: AbortController;
	messages: Set<number>;
	buttons: Map<string, { action: RemoteAction; messageId: number }>;
	revision: number;
	pageController: AbortController;
	writing: boolean;
}
interface MessageTarget {
	pending: Pending;
	revision: number;
	index: number;
}

export class TelegramBridgeEngine {
	private readonly requests = new Map<string, Pending>();
	private readonly messages = new Map<number, MessageTarget>();
	private readonly callbacks = new Set<string>();
	private readonly lifetime = new AbortController();
	private failure: string | undefined;

	constructor(private readonly config: TelegramConfig, private readonly call: TelegramCall) {}

	connect(send: Client["send"]): { receive: (request: BridgeRequest) => void; close: () => void } {
		const client: Client = { send };
		return {
			receive: (request) => {
				if (request.type === "stop") {
					const pending = this.requests.get(request.id);
					if (pending?.owner === client) this.finish(pending, "cancelled", request.reason);
					return;
				}
				if (this.failure || this.lifetime.signal.aborted) { send({ type: "error", id: request.id, message: this.failure ?? "ask_me bridge closed" }); return; }
				if (request.userId !== this.config.userId || request.chatId !== this.config.chatId) {
					send({ type: "error", id: request.id, message: "ask_me bridge authorization configuration differs from this Pi instance" }); return;
				}
				if (this.requests.has(request.id) || this.requests.size >= 32 || [...this.requests.values()].some((pending) => pending.owner === client)) {
					send({ type: "error", id: request.id, message: "ask_me bridge request limit or duplicate request" }); return;
				}
				const pending: Pending = {
					id: request.id, label: request.label, owner: client,
					state: new RemoteDraft(request.request, request.draft), controller: new AbortController(), messages: new Set(), buttons: new Map(),
					revision: 0, pageController: new AbortController(), writing: false,
				};
				this.requests.set(pending.id, pending);
				this.show(pending);
			},
			close: () => {
				for (const pending of this.requests.values()) if (pending.owner === client) this.finish(pending, "cancelled", "cancel");
			},
		};
	}

	private active(pending: Pending): boolean { return this.requests.get(pending.id) === pending; }

	private invalidate(pending: Pending): void {
		pending.revision++;
		pending.pageController.abort();
		pending.pageController = new AbortController();
		pending.writing = false;
		for (const id of pending.messages) this.messages.delete(id);
		pending.messages.clear();
		pending.buttons.clear();
	}

	private finish(pending: Pending, status: "submitted" | "cancelled", reason?: StopReason): void {
		if (!this.active(pending)) return;
		this.requests.delete(pending.id);
		this.invalidate(pending);
		pending.controller.abort();
		pending.owner.send({ type: "result", id: pending.id, status, draft: pending.state.draft, ...(reason ? { reason } : {}) });
		this.bestEffort("sendMessage", { chat_id: this.config.chatId, text: `${compactTelegramLabel(pending.label, 80)} · #${shortRequestId(pending.id)}\n${reason === "handoff" ? "Reclaimed locally" : status === "submitted" ? "Submitted" : "Cancelled"}.`, protect_content: true });
	}

	private bestEffort(method: "sendMessage" | "answerCallbackQuery", body: Record<string, unknown>): void {
		void this.call(method, body, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)])).catch(() => {});
	}

	private current(target: MessageTarget): boolean {
		return this.active(target.pending) && target.revision === target.pending.revision && target.index === target.pending.state.index;
	}

	private show(pending: Pending, notice?: string): void {
		this.deliver(pending, false, notice);
	}

	private writeAnswer(pending: Pending): void {
		if (pending.writing) return;
		// Keep the question page's navigation/cancel controls usable while writing.
		// Its revision owns both the original page and this one reply prompt.
		pending.writing = true;
		this.deliver(pending, true);
	}

	private deliver(pending: Pending, writing: boolean, notice?: string): void {
		const target: MessageTarget = { pending, revision: pending.revision, index: pending.state.index };
		const view = pending.state.view();
		const question = pending.state.request.questions[target.index];
		const subject = writing ? `\nWrite: ${escapeTelegramHtml(compactTelegramLabel(question?.question ?? "Overall response", 80))}` : "";
		const prefix = `${escapeTelegramHtml(compactTelegramLabel(pending.label, 80))} · #${shortRequestId(pending.id)}\n${escapeTelegramHtml(view.heading)}${subject}`;
		const instruction = writing
			? "Reply with your answer. To leave writing, use the original page's navigation or Cancel."
			: question ? "Or reply directly to this page. Review before submitting." : "Submit sends these answers. Cancel means no decision.";
		const chunks = telegramHtmlChunks([
			...(notice ? [{ text: `${notice}\n\n` }] : []),
			...view.body, { text: `\n\n${instruction}` },
		], 4000 - prefix.length - 32);
		const rows = writing ? [] : view.rows.map((row) => row.map((button) => ({
			id: randomUUID(), action: button.action, text: button.text,
		})));
		pending.owner.send({ type: "progress", id: pending.id, draft: pending.state.draft, status: "sending" });
		const workflow = Effect.tryPromise({
			try: async (signal) => {
				const ids: number[] = [];
				for (const [index, text] of chunks.entries()) {
					if (!this.current(target)) return;
					const last = index === chunks.length - 1;
					const response = await this.call("sendMessage", {
						chat_id: this.config.chatId,
						text: `${prefix}${chunks.length > 1 ? ` · ${index + 1}/${chunks.length}` : ""}\n\n${text}`,
						parse_mode: "HTML", protect_content: true, link_preview_options: { is_disabled: true },
						...(last ? { reply_markup: writing
							? { force_reply: true, input_field_placeholder: target.index < pending.state.request.questions.length ? "Write your answer" : "Write an overall response" }
							: { inline_keyboard: rows.map((row) => row.map((button) => ({ text: button.text, callback_data: button.id }))) },
						} : {}),
					}, signal);
					if (!record(response) || typeof response.message_id !== "number" || !Number.isSafeInteger(response.message_id) || response.message_id <= 0
						|| !record(response.chat) || response.chat.id !== this.config.chatId || response.chat.type !== "private") throw new TelegramError("protocol");
					ids.push(response.message_id);
				}
				if (!this.current(target)) return;
				for (const id of ids) { pending.messages.add(id); this.messages.set(id, target); }
				const keyboardMessage = ids.at(-1);
				if (keyboardMessage !== undefined) for (const row of rows) for (const button of row) {
					pending.buttons.set(button.id, { action: button.action, messageId: keyboardMessage });
				}
				pending.owner.send({ type: "progress", id: pending.id, draft: pending.state.draft, status: writing ? "writing" : "waiting" });
			},
			catch: () => new Error("ask_me Telegram delivery failed. No fallback was made. Check connection and retry ask_me."),
		});
		void Effect.runPromise(workflow, { signal: AbortSignal.any([this.lifetime.signal, pending.controller.signal, pending.pageController.signal]) }).catch(() => {
			if (!this.current(target)) return;
			this.requests.delete(pending.id);
			this.invalidate(pending);
			pending.controller.abort();
			pending.owner.send({ type: "error", id: pending.id, message: "ask_me Telegram delivery failed. No fallback was made. Check connection and retry ask_me." });
		});
	}

	handleUpdate(raw: unknown): void {
		const input = authorizedInput(raw, this.config);
		if (!input) return;
		if (input.callback) {
			if (this.callbacks.has(input.callback.id)) return;
			this.callbacks.add(input.callback.id);
			if (this.callbacks.size > 1024) { const oldest = this.callbacks.values().next().value; if (oldest) this.callbacks.delete(oldest); }
		}
		this.apply(input);
	}

	private apply(input: TelegramInput): void {
		const target = this.messages.get(input.reply?.to ?? input.messageId);
		const pending = target?.pending;
		const button = input.callback && pending?.buttons.get(input.callback.data);
		const action = button?.messageId === input.messageId ? button.action : undefined;
		if (!target || !pending || !this.current(target) || (input.callback && !action)) {
			if (input.callback) this.bestEffort("answerCallbackQuery", { callback_query_id: input.callback.id, text: "This control expired. Use the latest page for this request." });
			else this.bestEffort("sendMessage", { chat_id: this.config.chatId, text: "That reply does not belong to a current ask_me page. Reply to the latest page for the intended request." });
			return;
		}
		if (action?.kind === "write") {
			if (input.callback) this.bestEffort("answerCallbackQuery", { callback_query_id: input.callback.id, text: pending.writing ? "Reply to the writing prompt for this question." : "Write your answer in the reply field." });
			this.writeAnswer(pending);
			return;
		}
		this.invalidate(pending);
		let status: "submitted" | "cancelled" | undefined;
		let notice: string | undefined;
		try {
			if (input.reply) pending.state.text(input.reply.text);
			else if (action) status = pending.state.act(action);
		} catch (error) { notice = error instanceof Error ? error.message : "Invalid answer"; }
		if (input.callback) {
			let text = "Opening page";
			if (notice) text = "Please check the new page.";
			else if (status === "submitted") text = "Submitted";
			else if (status === "cancelled") text = "Cancelled";
			else if (action?.kind === "option" || action?.kind === "recommend") text = "Answer saved";
			this.bestEffort("answerCallbackQuery", { callback_query_id: input.callback.id, text });
		}
		if (status) this.finish(pending, status);
		else this.show(pending, notice);
	}

	async poll(signal: AbortSignal, ready: () => void = () => {}): Promise<void> {
		const combined = AbortSignal.any([signal, this.lifetime.signal]);
		try {
			const webhook = await this.call("getWebhookInfo", {}, combined);
			if (!record(webhook) || typeof webhook.url !== "string") throw new TelegramError("protocol");
			if (webhook.url) throw new TelegramError("conflict");
			// Probe before accepting questionnaires so webhook/poller conflicts fail
			// before any decision context is sent. Old updates cannot own new pages.
			const backlog = await this.call("getUpdates", { timeout: 0, limit: 100, allowed_updates: ["message", "callback_query"] }, combined);
			if (!Array.isArray(backlog) || backlog.length > 100) throw new TelegramError("protocol");
			let offset = 0;
			for (const update of backlog) {
				if (!record(update) || typeof update.update_id !== "number" || !Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new TelegramError("protocol");
				offset = Math.max(offset, update.update_id + 1);
			}
			ready();
			while (!combined.aborted) {
				const updates = await this.call("getUpdates", { offset, timeout: 30, limit: 100, allowed_updates: ["message", "callback_query"] }, combined);
				if (!Array.isArray(updates) || updates.length > 100) throw new TelegramError("protocol");
				for (const update of updates) {
					if (!record(update) || typeof update.update_id !== "number" || !Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new TelegramError("protocol");
					if (update.update_id < offset) continue;
					offset = update.update_id + 1;
					this.handleUpdate(update);
				}
			}
		} catch (error) {
			if (combined.aborted) return;
			this.failure = error instanceof TelegramError ? error.message : "ask_me Telegram polling failed after bounded retries. Restart AFK to reconnect.";
			for (const pending of this.requests.values()) {
				pending.owner.send({ type: "error", id: pending.id, message: this.failure });
				this.invalidate(pending);
				pending.controller.abort();
			}
			this.requests.clear();
			throw new Error(this.failure);
		}
	}

	close(): void {
		if (this.lifetime.signal.aborted) return;
		this.lifetime.abort();
		for (const pending of this.requests.values()) this.finish(pending, "cancelled", "cancel");
	}
}
