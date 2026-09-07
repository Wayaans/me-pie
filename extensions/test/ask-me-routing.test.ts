import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AskMeRouting, restoreAfk, routingFooter, type LocalQuestionnaire } from "../ask-me/routing.ts";
import type { remoteQuestionnaire, RemoteProgress, RemoteResult } from "../ask-me/bridge-client.ts";
import { normalizeAskMeRequest, type AskMeDetails } from "../ask-me/schema.ts";
import { AskMeQuestionnaire } from "../ask-me/questionnaire.ts";
import { runRpcQuestionnaire } from "../ask-me/index.ts";

const request = normalizeAskMeRequest({ questions: [{ id: "q", type: "question", question: "What next?" }] });
const draft = { answers: [{ id: "q", value: "saved", label: "saved", source: "typed" as const }] };

function harness(flag: boolean, remote?: typeof remoteQuestionnaire, check: () => void = () => {}) {
	const entries: unknown[] = [];
	const hooks = new Map<string, (event: { reason: string }, ctx: ExtensionContext) => unknown>();
	let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const statuses: unknown[] = [];
	const notifications: string[] = [];
	const api = {
		registerFlag(name: string) { assert.equal(name, "afk"); },
		getFlag() { return flag; },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		on(name: string, handler: (event: { reason: string }, ctx: ExtensionContext) => unknown) { hooks.set(name, handler); },
		getSessionName() { return "test session"; },
		registerCommand(_name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) { command = options.handler; },
	};
	const router = new AskMeRouting(api as never, remote, check);
	function context(mode: "tui" | "rpc" | "print" | "json" = "tui"): ExtensionCommandContext {
		return { mode, hasUI: mode === "tui" || mode === "rpc", cwd: "/tmp/test-project", sessionManager: { getBranch: () => entries, getSessionId: () => "session" }, ui: {
			setStatus: (_name: string, text: unknown) => statuses.push(text), notify: (text: string) => notifications.push(text),
			theme: { fg: (_color: string, text: string) => text },
		} } as never;
	}
	return { router, entries, statuses, notifications, context,
		event: async (name: string, reason: string, ctx = context()) => { await hooks.get(name)?.({ reason }, ctx); },
		command: async (args: string, ctx = context()) => { assert.ok(command); await command(args, ctx); },
	};
}

const local: LocalQuestionnaire = async (_ctx, questions, _signal, initial) => ({ ...questions, ...initial, status: "submitted" });

test("AFK flag overrides startup once, while reload and branch navigation restore the active branch preference", async () => {
	const h = harness(true);
	await h.event("session_start", "startup");
	assert.equal(restoreAfk(h.entries), true);
	await h.command("afk off"); assert.equal(restoreAfk(h.entries), false);
	await h.event("session_start", "reload");
	await h.command("status"); assert.match(h.notifications.at(-1) ?? "", /AFK off/);
	h.entries.splice(1);
	await h.event("session_tree", "tree");
	await h.command("status"); assert.match(h.notifications.at(-1) ?? "", /AFK on/);
	const independent = harness(false);
	await independent.event("session_start", "startup");
	await independent.command("status"); assert.match(independent.notifications.at(-1) ?? "", /AFK off/);
});

test("AFK commands toggle explicitly and reject missing configuration without changing preference", async () => {
	const h = harness(false);
	await h.event("session_start", "startup");
	await h.command("afk"); assert.equal(restoreAfk(h.entries), true);
	await h.command("afk"); assert.equal(restoreAfk(h.entries), false);
	await h.command("afk on"); assert.equal(restoreAfk(h.entries), true);
	await assert.rejects(h.command("invalid"), /Usage/);
	const missing = harness(false, undefined, () => { throw new Error("missing Telegram config"); });
	await assert.rejects(missing.command("afk on"), /missing Telegram config/);
	assert.equal(missing.entries.length, 0);
});

test("AFK routes print/json without UI, while local headless behavior still fails explicitly", async () => {
	let remoteCalls = 0;
	const remote: typeof remoteQuestionnaire = (questions) => { remoteCalls++; return { result: Promise.resolve({ details: { ...questions, ...draft, status: "submitted" }, handoff: false }), stop() {} }; };
	for (const mode of ["print", "json"] as const) {
		const h = harness(true, remote); const ctx = h.context(mode);
		await h.event("session_start", "startup", ctx);
		const result = await h.router.run(ctx, request, undefined, async () => { throw new Error("local should not run"); }, () => {});
		assert.equal(result.answers[0]?.value, "saved"); assert.equal(h.statuses.length, 0);
		const off = harness(false);
		await assert.rejects(off.router.run(off.context(mode), request, undefined, local, () => {}), /UI is unavailable/);
	}
	assert.equal(remoteCalls, 2);
});

function waitingRemote(): { remote: typeof remoteQuestionnaire; reasons: string[] } {
	const reasons: string[] = [];
	const remote: typeof remoteQuestionnaire = (questions, _draft, _label, signal) => {
		let finish: ((value: RemoteResult) => void) | undefined;
		const result = new Promise<RemoteResult>((resolve) => { finish = resolve; });
		const stop = (reason: "cancel" | "handoff") => {
			reasons.push(reason);
			finish?.({ details: { ...questions, ...draft, status: "cancelled" }, handoff: reason === "handoff" });
		};
		signal.addEventListener("abort", () => stop("cancel"), { once: true });
		return { result, stop };
	};
	return { remote, reasons };
}

test("AFK off reclaims a UI questionnaire with its draft, but cancels headless waiting", async () => {
	for (const mode of ["tui", "rpc", "print", "json"] as const) {
		const pending = waitingRemote(); const h = harness(true, pending.remote); const ctx = h.context(mode);
		await h.event("session_start", "startup", ctx);
		let localDraft: unknown;
		const running = h.router.run(ctx, request, undefined, async (_ctx, questions, _signal, initial) => {
			localDraft = initial.answers; return { ...questions, ...initial, status: "submitted" };
		}, () => {});
		await h.command("afk off", ctx);
		const result = await running;
		if (ctx.hasUI) { assert.deepEqual(localDraft, draft.answers); assert.equal(result.status, "submitted"); }
		else { assert.equal(localDraft, undefined); assert.equal(result.status, "cancelled"); }
		assert.equal(result.answers[0]?.value, "saved");
	}
});

test("Abort, reload shutdown and tree navigation cancel pending requests without local fallback", async () => {
	for (const action of ["abort", "session_shutdown", "session_tree"]) {
		const pending = waitingRemote(); const h = harness(true, pending.remote); const ctx = h.context();
		await h.event("session_start", "startup", ctx);
		const controller = new AbortController();
		const running = h.router.run(ctx, request, controller.signal, async () => { throw new Error("no fallback"); }, () => {});
		if (action === "abort") controller.abort(); else await h.event(action, "reload", ctx);
		const result = await running;
		assert.equal(result.status, "cancelled"); assert.deepEqual(result.answers, draft.answers);
		assert.ok(pending.reasons.includes("cancel"));
	}
});

test("A missing AFK configuration fails the tool, never silently opening local UI", async () => {
	const h = harness(true, () => { throw new Error("ask_me AFK requires configuration"); });
	await h.event("session_start", "startup");
	await assert.rejects(h.router.run(h.context(), request, undefined, async () => { throw new Error("local invoked"); }, () => {}), /AFK requires configuration/);
});

test("Footer shows compact typed AFK state, while status retains request and connection diagnostics", async () => {
	let report: ((progress: RemoteProgress) => void) | undefined;
	let finish: ((value: RemoteResult) => void) | undefined;
	const remote: typeof remoteQuestionnaire = (_request, _draft, _label, _signal, progress) => {
		report = progress;
		return { result: new Promise((resolve) => { finish = resolve; }), stop() {} };
	};
	const h = harness(true, remote); const ctx = h.context();
	await h.event("session_start", "startup", ctx);
	assert.equal(h.statuses.at(-1), "☾ AFK");
	const progressText: string[] = [];
	const running = h.router.run(ctx, request, undefined, local, (text) => progressText.push(text));
	const id = "12345678-1234-4123-8123-123456789abc";
	const expectations = { connecting: "◌ AFK connecting", sending: "◌ AFK sending", waiting: "? AFK 0/1", writing: "? AFK writing 0/1" };
	for (const phase of ["connecting", "sending", "waiting", "writing"] as const) {
		report?.({ phase, id, answered: 0, total: 1 });
		assert.equal(h.statuses.at(-1), expectations[phase]);
		await h.command("status", ctx);
		assert.ok(h.notifications.at(-1)?.includes(id));
		assert.ok(h.notifications.at(-1)?.includes("0/1 answered"));
	}
	assert.ok(h.statuses.every((text) => typeof text === "string" && text.length <= 20 && !text.includes(id)));
	assert.ok(progressText.every((text) => !text.includes(id)));
	finish?.({ details: { ...request, ...draft, status: "submitted" }, handoff: false });
	await running;
	assert.equal(h.statuses.at(-1), "☾ AFK");
	await h.event("session_shutdown", "reload", ctx);
	assert.equal(h.statuses.at(-1), undefined);
	await h.event("session_start", "reload", ctx);
	assert.equal(h.statuses.at(-1), "☾ AFK");
	await h.command("afk off", ctx);
	assert.equal(h.statuses.at(-1), undefined);
});

test("Local and remote errors have distinct compact indicators and clear on retry or preference changes", async () => {
	const message = "A detailed failure. Check the configuration before retrying.";
	const off = harness(false); await off.event("session_start", "startup");
	await assert.rejects(off.router.run(off.context(), request, undefined, async () => { throw new Error(message); }, () => {}), /detailed failure/);
	assert.equal(off.statuses.at(-1), "✗ ask-me error");
	await off.command("status");
	assert.match(off.notifications.at(-1) ?? "", /Local request failed/);
	assert.ok(off.notifications.at(-1)?.includes(message));
	assert.ok(!off.notifications.at(-1)?.includes("Telegram request failed"));
	await off.router.run(off.context(), request, undefined, local, () => {});
	assert.equal(off.statuses.at(-1), undefined);
	const on = harness(true, () => { throw new Error(message); }); await on.event("session_start", "startup");
	await assert.rejects(on.router.run(on.context(), request, undefined, local, () => {}), /detailed failure/);
	assert.equal(on.statuses.at(-1), "✗ AFK error");
	await on.command("status"); assert.match(on.notifications.at(-1) ?? "", /Telegram request failed/);
	await on.command("afk off"); assert.equal(on.statuses.at(-1), undefined);
	assert.equal(routingFooter({ kind: "error", route: "telegram", message: "a".repeat(5000), requestId: "x".repeat(100) }), "✗ AFK error");
});

test("Abort and branch restoration do not leave a stale waiting footer", async () => {
	for (const action of ["abort", "session_tree", "session_shutdown"] as const) {
		const pending = waitingRemote();
		const remote: typeof remoteQuestionnaire = (...args) => {
			args[4]({ phase: "waiting", id: "request", answered: 0, total: 1 });
			return pending.remote(...args);
		};
		const h = harness(true, remote); const ctx = h.context();
		await h.event("session_start", "startup", ctx);
		const controller = new AbortController();
		const running = h.router.run(ctx, request, controller.signal, local, () => {});
		assert.equal(h.statuses.at(-1), "? AFK 0/1");
		if (action === "abort") controller.abort();
		else {
			if (action === "session_tree") h.entries.push({ type: "custom", customType: "ask-me-afk", data: { enabled: false } });
			await h.event(action, "reload", ctx);
		}
		await running;
		assert.equal(h.statuses.at(-1), action === "abort" ? "☾ AFK" : undefined);
	}
});

test("TUI Ctrl+T carries unsubmitted text to Telegram and a failed handoff keeps the local questionnaire open", () => {
	for (const allow of [true, false]) {
		const results: AskMeDetails[] = [];
		const questionnaire = new AskMeQuestionnaire(request,
			{ terminal: { rows: 50 }, requestRender() {} } as never,
			{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
			{ matches: () => false } as never, (result) => results.push(result),
			{ draft: { answers: [] }, send: () => allow });
		questionnaire.handleInput("unsubmitted draft");
		questionnaire.handleInput("\u0014");
		assert.match(questionnaire.render(100).join("\n"), /Ctrl\+T send this draft/);
		if (allow) assert.equal(results[0]?.answers[0]?.value, "unsubmitted draft");
		else assert.equal(results.length, 0);
	}
});

test("RPC reclaim never auto-submits a complete remote draft", async () => {
	for (const submit of [true, false]) {
		let reviews = 0;
		const ctx = {
			mode: "rpc", hasUI: true,
			ui: {
				select: async (title: string, options: string[]) => {
					reviews++; assert.match(title, /Answer: saved/);
					return submit ? options[0] : undefined;
				},
			},
		} as never;
		const result = await runRpcQuestionnaire(ctx, request, undefined, draft);
		assert.equal(reviews, 1);
		assert.equal(result.status, submit ? "submitted" : "cancelled");
		assert.deepEqual(result.answers, draft.answers);
	}
});
