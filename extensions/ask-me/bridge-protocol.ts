import type { Socket } from "node:net";
import { createHash } from "node:crypto";
import type { TelegramConfig } from "./telegram.ts";
import { Value } from "typebox/value";
import { AskMeParams, normalizeAskMeRequest, type AskMeDetails, type AskMeRequest } from "./schema.ts";
import { validateDraft, type AskMeDraft } from "./draft.ts";
import { record } from "./telegram.ts";

export const MAX_FRAME_BYTES = 262_144;
export const BRIDGE_VERSION = 3;
export function configurationFingerprint(config: TelegramConfig): string {
	return createHash("sha256").update(JSON.stringify([config.token, config.userId, config.chatId])).digest("hex");
}
export type StopReason = "cancel" | "handoff";
export type BridgeProgress = "sending" | "waiting" | "writing";
export type BridgeRequest =
	| { type: "open"; id: string; label: string; request: AskMeRequest; draft: AskMeDraft; userId: number; chatId: number }
	| { type: "stop"; id: string; reason: StopReason };
export type BridgeResponse =
	| { type: "ready"; version: number; configuration: string }
	| { type: "progress"; id: string; draft: AskMeDraft; status: BridgeProgress }
	| { type: "result"; id: string; draft: AskMeDraft; status: AskMeDetails["status"]; reason?: StopReason }
	| { type: "error"; id?: string; message: string };

export function parseBridgeRequest(raw: unknown): BridgeRequest {
	if (!record(raw) || typeof raw.id !== "string" || !/^[a-f0-9-]{36}$/.test(raw.id)) throw new Error("Invalid bridge request");
	if (raw.type === "stop" && (raw.reason === "cancel" || raw.reason === "handoff")) return { type: "stop", id: raw.id, reason: raw.reason };
	if (raw.type !== "open" || typeof raw.label !== "string" || raw.label.length > 256 || !record(raw.request) || !Array.isArray(raw.request.questions)
		|| typeof raw.userId !== "number" || typeof raw.chatId !== "number") throw new Error("Invalid bridge questionnaire");
	// The internal request includes derived displayType and empty options on
	// non-selection questions. Revalidate through the public schema at IPC.
	const candidate = {
		...(raw.request.title !== undefined ? { title: raw.request.title } : {}),
		questions: raw.request.questions.map((question: unknown) => {
			if (!record(question) || question.type === "selection" || !Array.isArray(question.options) || question.options.length !== 0) return question;
			const { options: _options, ...rest } = question;
			return rest;
		}),
	};
	if (!Value.Check(AskMeParams, candidate)) throw new Error("Invalid bridge questionnaire");
	const request = normalizeAskMeRequest(candidate);
	const draft = validateDraft(request, raw.draft);
	return { type: "open", id: raw.id, label: raw.label, request, draft, userId: raw.userId, chatId: raw.chatId };
}

/** JSONL framing, not readline: Unicode separators are answer data, not delimiters. */
export function readFrames(socket: Socket, receive: (value: unknown) => void): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let boundary: number;
		while ((boundary = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, boundary);
			if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { socket.destroy(); return; }
			buffer = buffer.slice(boundary + 1);
			try { receive(JSON.parse(line)); }
			catch { socket.destroy(); return; }
		}
		if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) socket.destroy();
	});
}

export function sendFrame(socket: Socket, value: BridgeRequest | BridgeResponse): void {
	const text = `${JSON.stringify(value)}\n`;
	if (Buffer.byteLength(text) > MAX_FRAME_BYTES || socket.writableLength > MAX_FRAME_BYTES) throw new Error("ask_me bridge data limit exceeded");
	if (!socket.destroyed) socket.write(text);
}
