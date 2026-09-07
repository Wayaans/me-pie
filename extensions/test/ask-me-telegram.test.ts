import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:net";
import { authorizedInput, record, telegramClient, telegramConfig, TelegramError, type TelegramCall, type TelegramConfig } from "../ask-me/telegram.ts";
import { canSubmitDraft, RemoteDraft, validateDraft } from "../ask-me/draft.ts";
import { normalizeAskMeRequest } from "../ask-me/schema.ts";
import { TelegramBridgeEngine } from "../ask-me/bridge-engine.ts";
import { BRIDGE_VERSION, configurationFingerprint, parseBridgeRequest, readFrames, type BridgeRequest, type BridgeResponse } from "../ask-me/bridge-protocol.ts";
import { remoteQuestionnaire } from "../ask-me/bridge-client.ts";
import { runBridgeServer } from "../ask-me/bridge-server.ts";
import { escapeTelegramHtml, shortRequestId, telegramHtmlChunks } from "../ask-me/telegram-view.ts";

const config: TelegramConfig = { token: "123456:FAKE_TEST_TOKEN", botId: "123456", userId: 42, chatId: 42 };
const env = { TELEGRAM_BOT_TOKEN: config.token, MEPIE_ASK_ME_TELEGRAM_USER_ID: "42", MEPIE_ASK_ME_TELEGRAM_CHAT_ID: "42" };
const request = normalizeAskMeRequest({ questions: [
	{ id: "q", type: "confirmation", question: "Proceed?", detail: "Changes the staging service.", recommendation: { answer: "no", reason: "Wait for tests." } },
] });

async function until(predicate: () => boolean): Promise<void> {
	const end = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() > end) throw new Error("test wait timed out");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

interface Sent { id: number; text: string; buttons: Array<{ text: string; data: string }>; body: Record<string, unknown> }
function fakeTelegram() {
	const sent: Sent[] = [];
	const acknowledgements: string[] = [];
	let firstPoll = true;
	const call: TelegramCall = async (method, body, signal) => {
		signal.throwIfAborted();
		if (method === "getWebhookInfo") return { url: "" };
		if (method === "getUpdates") {
			if (firstPoll) { firstPoll = false; return []; }
			return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
		}
		if (method === "answerCallbackQuery") { acknowledgements.push(String(body.text)); return true; }
		if (method === "sendMessage") {
			const buttons: Sent["buttons"] = [];
			if (record(body.reply_markup) && Array.isArray(body.reply_markup.inline_keyboard)) {
				for (const row of body.reply_markup.inline_keyboard) {
					if (!Array.isArray(row)) continue;
					for (const button of row) if (record(button) && typeof button.text === "string" && typeof button.callback_data === "string") buttons.push({ text: button.text, data: button.callback_data });
				}
			}
			const id = sent.length + 1;
			sent.push({ id, text: String(body.text), buttons, body });
			return { message_id: id, chat: { id: config.chatId, type: "private" } };
		}
		return true;
	};
	return { sent, acknowledgements, call };
}
function open(id = randomUUID()): Extract<BridgeRequest, { type: "open" }> {
	return { type: "open", id, label: "project / session", request, draft: { answers: [] }, userId: 42, chatId: 42 };
}
function callback(page: Sent, label: string, updateId = 1, sender = 42, chat = 42) {
	const button = page.buttons.find((button) => button.text === label);
	assert.ok(button, `missing ${label}`);
	return { update_id: updateId, callback_query: { id: String(updateId), data: button.data, from: { id: sender }, message: { message_id: page.id, chat: { id: chat, type: "private" } } } };
}
function reply(to: number | undefined, text: string, updateId = 1) {
	return { update_id: updateId, message: { message_id: updateId + 10_000, from: { id: 42 }, chat: { id: 42, type: "private" }, text, ...(to ? { reply_to_message: { message_id: to } } : {}) } };
}
function latest(sent: Sent[], id: string): Sent {
	const page = sent.filter((page) => page.text.includes(shortRequestId(id)) && page.buttons.length > 0).at(-1);
	assert.ok(page); return page;
}
function waiting(responses: BridgeResponse[], count = 1) {
	return responses.filter((response) => response.type === "progress" && response.status === "waiting").length >= count;
}

test("Telegram config accepts only an env reference and numeric private identity, with redacted errors", () => {
	assert.deepEqual(telegramConfig(env), config);
	assert.equal(telegramConfig({ ...env, MEPIE_ASK_ME_TOKEN_ENV: "TEST_SECRET", TEST_SECRET: config.token }).token, config.token);
	for (const invalid of [{}, { ...env, MEPIE_ASK_ME_TOKEN_ENV: "!some-command" }, { ...env, MEPIE_ASK_ME_TELEGRAM_CHAT_ID: "-42" }, { ...env, MEPIE_ASK_ME_TELEGRAM_USER_ID: "someone" }]) {
		assert.throws(() => telegramConfig(invalid), (error: unknown) => error instanceof Error && !error.message.includes(config.token));
	}
});

test("Telegram authorization rejects wrong users/chats, groups, bots and uncorrelated text", () => {
	assert.equal(authorizedInput(reply(undefined, "bare answer"), config), undefined);
	const valid = reply(1, "/ask-me afk off is answer text");
	assert.equal(authorizedInput(valid, config)?.reply?.text, "/ask-me afk off is answer text");
	for (const message of [
		{ ...valid.message, from: { id: 99 } },
		{ ...valid.message, from: { id: 42, is_bot: true } },
		{ ...valid.message, chat: { id: 99, type: "private" } },
		{ ...valid.message, chat: { id: 42, type: "group" } },
	]) assert.equal(authorizedInput({ ...valid, message }, config), undefined);
});

test("Every split Telegram page carries its request identity without dropping option descriptions", async () => {
	const transport = fakeTelegram(); const engine = new TelegramBridgeEngine(config, transport.call);
	const responses: BridgeResponse[] = []; const client = engine.connect((item) => responses.push(item));
	const description = "Full decision context. ".repeat(500);
	const item = { ...open(), request: normalizeAskMeRequest({ questions: [{ id: "q", type: "selection", question: "Choose?", options: [{ value: "a", label: "A", description }] }] }) };
	try {
		client.receive(item); await until(() => waiting(responses));
		assert.ok(transport.sent.length > 1);
		assert.ok(transport.sent.every((page) => page.text.includes(shortRequestId(item.id)) && !page.text.includes(item.id) && page.text.length <= 4096));
		const content = transport.sent.map((page) => page.text.slice(page.text.indexOf("\n\n") + 2)).join("");
		assert.ok(content.includes(description.trim()));
	} finally { engine.close(); }
});

test("Telegram HTML chunks escape untrusted text and keep entities, tags and Unicode intact", () => {
	const parts = [
		{ text: '<b>not markup</b> & "quoted" 😀'.repeat(70), bold: true },
		{ text: "\n\n" },
		{ text: "<script>&amp;</script> 😀".repeat(100) },
	];
	for (const limit of [16, 17, 64, 3500]) {
		const chunks = telegramHtmlChunks(parts, limit);
		assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length <= limit));
		for (const chunk of chunks) {
			assert.equal((chunk.match(/<b>/g) ?? []).length, (chunk.match(/<\/b>/g) ?? []).length);
			assert.doesNotMatch(chunk, /<(?!\/?b>)/);
			assert.doesNotMatch(chunk, /&(?!amp;|lt;|gt;)/);
			assert.doesNotMatch(chunk.replaceAll("</b>", ""), /[\uD800-\uDBFF]$/);
		}
		assert.equal(chunks.join("").replaceAll("<b>", "").replaceAll("</b>", ""), escapeTelegramHtml(parts.map((part) => part.text).join("")));
	}
});

test("Long formatted pages and writing prompts preserve full titles, questions, context, labels and recommendation reasons", async () => {
	const transport = fakeTelegram(); const engine = new TelegramBridgeEngine(config, transport.call);
	const responses: BridgeResponse[] = [];
	const fields = {
		title: "Interview <&> 😀 ".repeat(50).trim(),
		question: "Question <&> 😀 ".repeat(50).trim(),
		detail: "Context <&> 😀 ".repeat(200).trim(),
		label: "Long option <&> 😀 ".repeat(10).trim(),
		description: "Description <&> 😀 ".repeat(100).trim(),
		reason: "Reason <&> 😀 ".repeat(100).trim(),
	};
	const item = { ...open(), label: "project <&> / session <&>", request: normalizeAskMeRequest({ title: fields.title, questions: [{
		id: "q", type: "selection", question: fields.question, detail: fields.detail,
		options: [{ value: "a", label: fields.label, description: fields.description }], recommendation: { answer: "a", reason: fields.reason },
	}] }) };
	try {
		engine.connect((response) => responses.push(response)).receive(item);
		await until(() => waiting(responses));
		const page = latest(transport.sent, item.id);
		const checkContext = (pages: Sent[]) => {
			assert.ok(pages.length > 1);
			assert.ok(pages.every((page) => page.text.length <= 4096 && page.body.parse_mode === "HTML" && !page.text.includes(item.id)));
			assert.ok(pages.every((page) => page.text.startsWith("project &lt;&amp;&gt; / session &lt;&amp;&gt;")));
			const body = pages.map((page) => page.text.slice(page.text.indexOf("\n\n") + 2)).join("").replaceAll("<b>", "").replaceAll("</b>", "");
			for (const field of Object.values(fields)) assert.ok(body.includes(escapeTelegramHtml(field)), "missing unabridged decision field");
		};
		checkContext(transport.sent);
		assert.ok(page.buttons[0]?.text.startsWith("1. Long option"));
		assert.ok((page.buttons[0]?.text.length ?? Infinity) < fields.label.length);
		const before = transport.sent.length;
		engine.handleUpdate(callback(page, "Write another answer", 1));
		await until(() => responses.some((response) => response.type === "progress" && response.status === "writing"));
		checkContext(transport.sent.slice(before));
		assert.equal(transport.sent.slice(before).filter((page) => record(page.body.reply_markup) && page.body.reply_markup.force_reply === true).length, 1);
	} finally { engine.close(); }
});

test("Telegram keyboard uses real labels, paired yes/no and bounded navigation without impossible controls", () => {
	const state = new RemoteDraft(request, { answers: [] });
	assert.deepEqual(state.view().rows[0]?.map((button) => button.text), ["Yes", "No"]);
	assert.ok(state.view().rows.flat().some((button) => button.text === "Write another answer"));
	assert.ok(!state.view().rows.flat().some((button) => ["Previous", "Next", "Skip", "Submit"].includes(button.text)));
	state.act({ kind: "review" });
	assert.ok(!state.view().rows.flat().some((button) => ["Submit", "Write overall response"].includes(button.text)));
	assert.match(state.view().body.map((part) => part.text).join(""), /Go back/);
	state.act({ kind: "previous" }); state.text("a custom decision");
	const rows = state.view().rows;
	assert.ok(rows.some((row) => row.length === 1 && row[0]?.text === "Submit"));
	assert.deepEqual(rows.at(-1)?.map((button) => button.text), ["Cancel interview"]);
	const selection = new RemoteDraft(normalizeAskMeRequest({ questions: [
		{ id: "a", type: "selection", question: "Which?", required: false, options: [{ value: "postgres", label: "Postgres" }, { value: "file", label: "SQLite" }] },
		{ id: "b", type: "question", question: "Why?" },
	] }), { answers: [] });
	assert.deepEqual(selection.view().rows.slice(0, 2).map((row) => row[0]?.text), ["1. Postgres", "2. SQLite"]);
	assert.deepEqual(selection.view().rows.at(-2)?.map((button) => button.text), ["Skip", "Next", "Review"]);
	assert.ok(selection.view().rows.every((row) => row.length >= 1 && row.length <= 3));
});

test("Write answer opens a scoped ForceReply for every question type, saves typed data and still requires Submit", async () => {
	for (const type of ["question", "selection", "confirmation"] as const) {
		const transport = fakeTelegram(); const engine = new TelegramBridgeEngine(config, transport.call);
		const responses: BridgeResponse[] = []; const client = engine.connect((response) => responses.push(response));
		const item = { ...open(), request: normalizeAskMeRequest({ title: "Decision <review>", questions: [{ id: "q", type, question: "Your <answer>?", detail: "Keep this & that.", ...(type === "selection" ? { options: [{ value: "a", label: "A" }] } : {}) }] }) };
		try {
			client.receive(item); await until(() => waiting(responses));
			const page = latest(transport.sent, item.id);
			assert.doesNotMatch(page.text, /Part 1\/1/);
			assert.match(page.text, /<b>Your &lt;answer&gt;\?<\/b>/);
			assert.equal(page.body.parse_mode, "HTML");
			const write = type === "question" ? "Write answer" : "Write another answer";
			engine.handleUpdate(callback(page, write, 1));
			engine.handleUpdate(callback(page, write, 1));
			engine.handleUpdate(callback(page, write, 2));
			await until(() => responses.some((response) => response.type === "progress" && response.status === "writing"));
			const prompts = transport.sent.filter((sent) => record(sent.body.reply_markup) && sent.body.reply_markup.force_reply === true);
			assert.equal(prompts.length, 1);
			const prompt = prompts[0]; assert.ok(prompt);
			assert.deepEqual(prompt.body.reply_markup, { force_reply: true, input_field_placeholder: "Write your answer" });
			assert.match(prompt.text, /Your &lt;answer&gt;\?/);
			assert.match(prompt.text, /Keep this &amp; that/);
			assert.match(prompt.text, /original page's navigation or Cancel/);
			assert.ok(!responses.some((response) => response.type === "result"));
			engine.handleUpdate(reply(undefined, "bare text is not routed", 3));
			engine.handleUpdate(reply(prompt.id, "not yes/no; my own <answer>", 4));
			engine.handleUpdate(reply(prompt.id, "duplicate", 4));
			engine.handleUpdate(reply(page.id, "stale original page", 5));
			await until(() => waiting(responses, 2));
			assert.ok(!responses.some((response) => response.type === "result"));
			engine.handleUpdate(callback(latest(transport.sent, item.id), "Submit", 6));
			const results = responses.filter((response) => response.type === "result");
			assert.equal(results.length, 1);
			assert.deepEqual(results[0]?.draft.answers, [{ id: "q", value: "not yes/no; my own <answer>", label: "not yes/no; my own <answer>", source: "typed" }]);
			const acknowledgment = transport.sent.at(-1); assert.ok(acknowledgment);
			assert.match(acknowledgment.text, /Submitted\.$/);
			assert.ok(acknowledgment.text.includes(shortRequestId(item.id)) && !acknowledgment.text.includes(item.id));
		} finally { engine.close(); }
	}
});

test("Review exposes Write overall response without implicitly approving required questions", async () => {
	const transport = fakeTelegram(); const engine = new TelegramBridgeEngine(config, transport.call);
	const responses: BridgeResponse[] = []; const client = engine.connect((response) => responses.push(response));
	const item = { ...open(), request: normalizeAskMeRequest({ questions: [{ id: "a", type: "question", question: "A?" }, { id: "b", type: "confirmation", question: "B?", detail: "This changes the shared service.", recommendation: { answer: "no", reason: "Tests are incomplete." } }] }) };
	try {
		client.receive(item); await until(() => waiting(responses));
		engine.handleUpdate(callback(latest(transport.sent, item.id), "Review", 1));
		await until(() => waiting(responses, 2));
		const review = latest(transport.sent, item.id);
		assert.ok(!review.buttons.some((button) => button.text === "Submit"));
		engine.handleUpdate(callback(review, "Write overall response", 2));
		await until(() => responses.some((response) => response.type === "progress" && response.status === "writing"));
		const prompt = transport.sent.at(-1); assert.ok(prompt);
		assert.deepEqual(prompt.body.reply_markup, { force_reply: true, input_field_placeholder: "Write an overall response" });
		assert.match(prompt.text, /This changes the shared service/);
		assert.match(prompt.text, /Tests are incomplete/);
		engine.handleUpdate(reply(prompt.id, "Answering both at once", 3));
		await until(() => waiting(responses, 3));
		assert.ok(!responses.some((response) => response.type === "result"));
		engine.handleUpdate(callback(latest(transport.sent, item.id), "Submit", 4));
		const result = responses.find((response) => response.type === "result");
		assert.equal(result?.status, "submitted");
		assert.deepEqual(result?.draft, { answers: [], overallResponse: "Answering both at once" });
	} finally { engine.close(); }
});

test("ForceReply targets the owning session even when displayed short request IDs collide", async () => {
	const transport = fakeTelegram(); const engine = new TelegramBridgeEngine(config, transport.call);
	const a: BridgeResponse[] = []; const b: BridgeResponse[] = [];
	const first = { ...open("aaaaaaaa-1111-4111-8111-111111111111"), label: "project / first session" };
	const second = { ...open("aaaaaaaa-2222-4222-8222-222222222222"), label: "project / second session" };
	try {
		engine.connect((response) => a.push(response)).receive(first);
		engine.connect((response) => b.push(response)).receive(second);
		await until(() => waiting(a) && waiting(b));
		const pageA = transport.sent.find((page) => page.text.includes(first.label));
		const pageB = transport.sent.find((page) => page.text.includes(second.label));
		assert.ok(pageA); assert.ok(pageB);
		const forged = callback(pageA, "Yes", 1); forged.callback_query.message.message_id = pageB.id;
		engine.handleUpdate(forged);
		engine.handleUpdate(callback(pageA, "Write another answer", 2));
		engine.handleUpdate(callback(pageB, "Write another answer", 3));
		await until(() => [a, b].every((responses) => responses.some((response) => response.type === "progress" && response.status === "writing")));
		const promptA = transport.sent.find((page) => page.text.includes(first.label) && record(page.body.reply_markup) && page.body.reply_markup.force_reply === true);
		const promptB = transport.sent.find((page) => page.text.includes(second.label) && record(page.body.reply_markup) && page.body.reply_markup.force_reply === true);
		assert.ok(promptA); assert.ok(promptB);
		engine.handleUpdate(reply(promptB.id, "second only", 4));
		engine.handleUpdate(reply(promptA.id, "first only", 5));
		await until(() => waiting(a, 2) && waiting(b, 2));
		assert.equal(a.filter((response) => response.type === "progress").at(-1)?.draft.answers[0]?.value, "first only");
		assert.equal(b.filter((response) => response.type === "progress").at(-1)?.draft.answers[0]?.value, "second only");
		assert.ok(transport.acknowledgements.some((text) => text.includes("expired")));
	} finally { engine.close(); }
});

test("Navigation and cancellation expire both writing prompts and original pages, preserving partial answers", async () => {
	const transport = fakeTelegram(); const engine = new TelegramBridgeEngine(config, transport.call);
	const responses: BridgeResponse[] = []; const client = engine.connect((response) => responses.push(response));
	const item = { ...open(), request: normalizeAskMeRequest({ questions: [{ id: "a", type: "question", question: "A?" }, { id: "b", type: "question", question: "B?" }] }) };
	try {
		client.receive(item); await until(() => waiting(responses));
		const first = latest(transport.sent, item.id);
		engine.handleUpdate(callback(first, "Write answer", 1));
		await until(() => responses.some((response) => response.type === "progress" && response.status === "writing"));
		const prompt = transport.sent.at(-1); assert.ok(prompt);
		engine.handleUpdate(callback(first, "Next", 2));
		await until(() => waiting(responses, 2));
		engine.handleUpdate(reply(prompt.id, "stale writing", 3));
		engine.handleUpdate(reply(first.id, "stale original", 4));
		engine.handleUpdate(callback(first, "Write answer", 5));
		const second = latest(transport.sent, item.id);
		engine.handleUpdate(reply(second.id, "saved B", 6));
		await until(() => waiting(responses, 3));
		engine.handleUpdate(callback(latest(transport.sent, item.id), "Previous", 7));
		await until(() => waiting(responses, 4));
		const editing = latest(transport.sent, item.id);
		engine.handleUpdate(callback(editing, "Write answer", 8));
		await until(() => responses.filter((response) => response.type === "progress" && response.status === "writing").length === 2);
		const lastPrompt = transport.sent.at(-1); assert.ok(lastPrompt);
		engine.handleUpdate(callback(editing, "Cancel interview", 9));
		engine.handleUpdate(reply(lastPrompt.id, "too late", 10));
		const results = responses.filter((response) => response.type === "result");
		assert.equal(results.length, 1);
		assert.equal(results[0]?.status, "cancelled");
		assert.deepEqual(results[0]?.draft.answers, [{ id: "b", value: "saved B", label: "saved B", source: "typed" }]);
	} finally { engine.close(); }
});

test("Delayed writing delivery cannot reopen an old revision or fail a newer page", async () => {
	for (const fail of [false, true]) {
		const transport = fakeTelegram();
		let deliver: (() => void) | undefined;
		const call: TelegramCall = (method, body, signal) => {
			if (record(body.reply_markup) && body.reply_markup.force_reply === true) return new Promise((resolve, reject) => {
				deliver = () => fail ? reject(new Error("late transport failure")) : resolve({ message_id: 9000, chat: { id: 42, type: "private" } });
			});
			return transport.call(method, body, signal);
		};
		const engine = new TelegramBridgeEngine(config, call);
		const responses: BridgeResponse[] = []; const client = engine.connect((response) => responses.push(response)); const item = open();
		try {
			client.receive(item); await until(() => waiting(responses));
			const page = latest(transport.sent, item.id);
			engine.handleUpdate(callback(page, "Write another answer", 1));
			await until(() => Boolean(deliver));
			engine.handleUpdate(callback(page, "No", 2));
			await until(() => waiting(responses, 2));
			deliver?.(); await new Promise((resolve) => setTimeout(resolve, 10));
			engine.handleUpdate(reply(9000, "late answer", 3));
			assert.ok(!responses.some((response) => response.type === "error"));
			engine.handleUpdate(callback(latest(transport.sent, item.id), "Submit", 4));
			assert.equal(responses.find((response) => response.type === "result")?.draft.answers[0]?.value, "no");
		} finally { engine.close(); }
	}
});

test("Remote questionnaire preserves selection descriptions and requires explicit recommendation and submission", () => {
	const mixed = normalizeAskMeRequest({ questions: [
		{ id: "db", type: "selection", question: "Which database?", options: [{ value: "pg", label: "Postgres", description: "Concurrent writers" }], recommendation: { answer: "pg", reason: "Required for production" } },
		{ id: "notes", type: "question", question: "Notes?", required: false },
	] });
	const state = new RemoteDraft(mixed, { answers: [] });
	assert.match(state.view().body.map((part) => part.text).join(""), /Concurrent writers/);
	assert.match(state.view().body.map((part) => part.text).join(""), /Required for production/);
	assert.equal(canSubmitDraft(mixed, state.draft), false);
	assert.equal(state.act({ kind: "recommend" }), undefined);
	assert.equal(state.draft.answers[0]?.source, "recommended");
	assert.equal(state.act({ kind: "skip" }), undefined);
	assert.equal(state.act({ kind: "submit" }), "submitted");
	state.act({ kind: "previous" }); state.text("custom notes");
	assert.equal(state.draft.answers[1]?.value, "custom notes");
});

test("Overall response replaces required answers only for a questionnaire; draft limits are enforced", () => {
	const mixed = normalizeAskMeRequest({ questions: [{ id: "a", type: "question", question: "A?" }, { id: "b", type: "confirmation", question: "B?" }] });
	const state = new RemoteDraft(mixed, { answers: [] });
	state.act({ kind: "review" });
	assert.throws(() => state.act({ kind: "submit" }), /required/);
	state.text("Answer both in one response");
	assert.equal(state.act({ kind: "submit" }), "submitted");
	assert.throws(() => validateDraft(request, { answers: [], overallResponse: "yes" }), /Invalid/);
	assert.throws(() => validateDraft(request, { answers: [{ id: "q", value: "yes", label: "Yes", source: "recommended" }] }), /recommendation/);
	assert.throws(() => state.text("x".repeat(60_000)), /limit/);
	assert.equal(state.draft.overallResponse, "Answer both in one response");
});

test("Bridge isolates concurrent sessions, rejects unauthorized and stale callbacks, and submits once", async () => {
	const transport = fakeTelegram();
	const engine = new TelegramBridgeEngine(config, transport.call);
	const a: BridgeResponse[] = []; const b: BridgeResponse[] = [];
	const clientA = engine.connect((response) => a.push(response));
	const clientB = engine.connect((response) => b.push(response));
	const first = open(); const second = open();
	try {
		clientA.receive(first); clientB.receive(second);
		await until(() => waiting(a) && waiting(b));
		const pageA = latest(transport.sent, first.id); const pageB = latest(transport.sent, second.id);
		engine.handleUpdate(callback(pageA, "Yes", 1, 99));
		engine.handleUpdate(callback(pageA, "Yes", 2, 42, 99));
		assert.equal(a.filter((item) => item.type === "result").length, 0);
		clientB.receive({ type: "stop", id: first.id, reason: "cancel" });
		engine.handleUpdate(callback(pageB, "No", 3));
		engine.handleUpdate(callback(pageA, "Yes", 4));
		engine.handleUpdate(callback(pageA, "Yes", 4));
		engine.handleUpdate(callback(pageA, "No", 5));
		await until(() => waiting(a, 2) && waiting(b, 2));
		const reviewA = latest(transport.sent, first.id); const reviewB = latest(transport.sent, second.id);
		engine.handleUpdate(callback(reviewA, "Submit", 6));
		engine.handleUpdate(callback(reviewA, "Submit", 7));
		engine.handleUpdate(callback(reviewB, "Submit", 8));
		const resultsA = a.filter((response) => response.type === "result");
		const resultsB = b.filter((response) => response.type === "result");
		assert.equal(resultsA.length, 1); assert.equal(resultsB.length, 1);
		assert.equal(resultsA[0]?.draft.answers[0]?.value, "yes");
		assert.equal(resultsB[0]?.draft.answers[0]?.value, "no");
		assert.ok(transport.acknowledgements.some((text) => text.includes("expired")));
	} finally { engine.close(); }
});

test("Replies require current mapped message, preserve custom command-looking text, and handoff retains the draft", async () => {
	const transport = fakeTelegram(); const engine = new TelegramBridgeEngine(config, transport.call);
	const responses: BridgeResponse[] = []; const client = engine.connect((item) => responses.push(item)); const item = open();
	try {
		client.receive(item); await until(() => waiting(responses));
		const page = latest(transport.sent, item.id);
		engine.handleUpdate(reply(undefined, "not an answer"));
		engine.handleUpdate(reply(987, "wrong request", 2));
		engine.handleUpdate(reply(page.id, "/ask-me afk off; rm -rf is literal data", 3));
		engine.handleUpdate(reply(page.id, "stale replacement", 4));
		await until(() => waiting(responses, 2));
		const review = latest(transport.sent, item.id);
		client.receive({ type: "stop", id: item.id, reason: "handoff" });
		engine.handleUpdate(callback(review, "Submit", 5));
		client.close(); engine.close();
		const results = responses.filter((response) => response.type === "result");
		assert.equal(results.length, 1);
		assert.equal(results[0]?.reason, "handoff");
		assert.equal(results[0]?.status, "cancelled");
		assert.equal(results[0]?.draft.answers[0]?.value, "/ask-me afk off; rm -rf is literal data");
	} finally { engine.close(); }
});

test("Disconnect and shutdown invalidate in-flight delivery without reopening controls", async () => {
	let deliver: ((value: unknown) => void) | undefined;
	const transport = fakeTelegram();
	const call: TelegramCall = (method, body, signal) => method === "sendMessage" && String(body.text).includes("Question 1/")
		? new Promise((resolve) => { deliver = resolve; }) : transport.call(method, body, signal);
	const engine = new TelegramBridgeEngine(config, call);
	const responses: BridgeResponse[] = []; const client = engine.connect((item) => responses.push(item));
	client.receive(open()); await until(() => Boolean(deliver));
	client.close(); engine.close(); engine.close();
	deliver?.({ message_id: 1, chat: { id: 42, type: "private" } });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(responses.filter((item) => item.type === "result").length, 1);
	assert.equal(responses.some((item) => item.type === "progress" && item.status === "waiting"), false);
});

test("Bridge detects webhook and conflicting pollers without deleting webhooks or sending questions", async () => {
	for (const webhook of [true, false]) {
		const methods: string[] = [];
		const engine = new TelegramBridgeEngine(config, async (method) => {
			methods.push(method);
			if (method === "getWebhookInfo") return { url: webhook ? "https://private.invalid/secret" : "" };
			throw new TelegramError("conflict");
		});
		let ready = false;
		await assert.rejects(engine.poll(new AbortController().signal, () => { ready = true; }), /conflict/);
		assert.equal(ready, false); assert.equal(methods.includes("sendMessage"), false);
		assert.equal(methods.includes("deleteWebhook"), false);
		engine.close();
	}
});

test("Telegram HTTP bounds retries and never leaks token URLs or server descriptions", async () => {
	let attempts = 0;
	const client = telegramClient(config, async () => { attempts++; throw new Error(`fetch https://api.telegram.org/bot${config.token}/getUpdates`); });
	await assert.rejects(client("getUpdates", {}, new AbortController().signal), (error: unknown) => error instanceof Error && !String(error).includes(config.token));
	assert.equal(attempts, 3);
	const conflict = telegramClient(config, async () => new Response(config.token, { status: 409 }));
	await assert.rejects(conflict("getUpdates", {}, new AbortController().signal), /conflict/);
	const malformed = telegramClient(config, async () => new Response(JSON.stringify({ ok: true })));
	await assert.rejects(malformed("getWebhookInfo", {}, new AbortController().signal), /protocol/);
	const rejection = telegramClient(config, async () => new Response(JSON.stringify({ ok: false, error_code: 401, description: config.token })));
	await assert.rejects(rejection("getWebhookInfo", {}, new AbortController().signal), (error: unknown) => !String(error).includes(config.token));
});

test("Telegram HTTP bounds response bodies, refuses redirects and interrupts in-flight requests", async () => {
	const large = telegramClient(config, async (_url, options) => {
		assert.equal(options.redirect, "error");
		return new Response("x".repeat(1_048_577));
	});
	await assert.rejects(large("getWebhookInfo", {}, new AbortController().signal), /protocol/);
	const controller = new AbortController();
	let entered = false;
	const waiting = telegramClient(config, async (_url, options) => {
		entered = true;
		return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error(config.token)), { once: true }));
	});
	const result = waiting("getUpdates", {}, controller.signal);
	await until(() => entered);
	controller.abort();
	await assert.rejects(result, (error: unknown) => !String(error).includes(config.token));
});

test("Telegram HTTP respects abort and does not retry an ambiguous send", async () => {
	let attempts = 0;
	const client = telegramClient(config, async () => { attempts++; throw new Error("network lost after delivery"); });
	await assert.rejects(client("sendMessage", {}, new AbortController().signal));
	assert.equal(attempts, 1);
	const controller = new AbortController(); controller.abort();
	await assert.rejects(client("getUpdates", {}, controller.signal));
	assert.equal(attempts, 1);
});

test("Bridge protocol rejects forged drafts, invalid identities and oversized question counts", () => {
	assert.equal(parseBridgeRequest(open()).type, "open");
	assert.throws(() => parseBridgeRequest({ ...open(), draft: { answers: [{ id: "unknown", value: "a", label: "a", source: "typed" }] } }));
	assert.throws(() => parseBridgeRequest({ ...open(), request: { questions: Array(21).fill({ id: "a", type: "question", question: "A?" }) } }));
	assert.throws(() => parseBridgeRequest({ type: "stop", id: "latest", reason: "cancel" }));
});

test("Unix socket bridge routes a pending tool through handoff and releases resources", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ask-me-test-"));
	const path = join(directory, "socket");
	const transport = fakeTelegram(); const controller = new AbortController();
	const running = runBridgeServer(path, config, transport.call, controller.signal);
	try {
		for (let attempt = 0; attempt < 100; attempt++) {
			try { await lstat(path); break; } catch { await new Promise((resolve) => setTimeout(resolve, 2)); }
		}
		const remote = remoteQuestionnaire(request, { answers: [] }, "socket project", new AbortController().signal, () => {},
			async () => new Promise((resolve, reject) => { const socket = connect(path); socket.on("error", reject); socket.on("connect", () => resolve(socket)); }), env);
		await until(() => transport.sent.some((item) => item.buttons.length > 0));
		remote.stop("handoff");
		const result = await remote.result;
		assert.equal(result.handoff, true); assert.equal(result.details.status, "cancelled");
	} finally { controller.abort(); await running; await rm(directory, { recursive: true, force: true }); }
});

test("New clients reject an older loaded bridge before sending a questionnaire, without restarting it", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ask-me-old-bridge-"));
	const path = join(directory, "socket");
	const received: unknown[] = [];
	const server = createServer((socket) => {
		readFrames(socket, (frame) => received.push(frame));
		socket.write(`${JSON.stringify({ type: "ready", version: BRIDGE_VERSION - 1, configuration: configurationFingerprint(config) })}\n`);
	});
	try {
		await new Promise<void>((resolve) => server.listen(path, resolve));
		const remote = remoteQuestionnaire(request, { answers: [] }, "new client", new AbortController().signal, () => {},
			async () => new Promise((resolve, reject) => { const socket = connect(path); socket.on("error", reject); socket.on("connect", () => resolve(socket)); }), env);
		await assert.rejects(remote.result, /protocol.*Finish its pending requests.*No restart or takeover/);
		assert.deepEqual(received, []);
		assert.equal(server.listening, true);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

test("saved config is passed explicitly and a running bridge rejects changed tokens or destination without restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ask-me-config-bridge-"));
	const path = join(directory, "socket");
	const controller = new AbortController();
	const transport = fakeTelegram();
	const running = runBridgeServer(path, config, transport.call, controller.signal);
	try {
		for (let attempt = 0; attempt < 100; attempt++) {
			try { await lstat(path); break; } catch { await new Promise((resolve) => setTimeout(resolve, 2)); }
		}
		for (const changed of [{ ...config, token: "123456:MOCK_REPLACEMENT_TOKEN" }, { ...config, chatId: 999 }, { ...config, userId: 999 }]) {
			let resolutions = 0;
			const remote = remoteQuestionnaire(request, { answers: [] }, "saved setup", new AbortController().signal, () => {},
				async (received) => {
					assert.deepEqual(received, changed);
					return new Promise((resolve, reject) => { const socket = connect(path); socket.on("error", reject); socket.on("connect", () => resolve(socket)); });
				}, {}, async () => { resolutions++; return changed; });
			await assert.rejects(remote.result, /running bridge uses different settings.*No restart or takeover/);
			assert.equal(resolutions, 1);
		}
		assert.equal(transport.sent.length, 0);
	} finally { controller.abort(); await running; await rm(directory, { recursive: true, force: true }); }
});
