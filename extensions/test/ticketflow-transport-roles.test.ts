import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkerReport } from "../ticket-flow/model.ts";
import {
	MAIN_TICKETFLOW_TOOLS,
	WORKER_TICKETFLOW_TOOLS,
	filterTicketflowContext,
	isAllowedTicketflowTool,
	isTicketflowTool,
} from "../ticket-flow/tool-names.ts";
import ticketflow, { auditToolBlocked } from "../ticket-flow/index.ts";
import {
	TransportServer,
	type TransportIdentity,
	type TransportReportEvent,
	 type TransportSettledEvent,
} from "../ticket-flow/transport.ts";
import { TicketflowReportParametersSchema, WorkerChannel } from "../ticket-flow/worker.ts";

async function temp(prefix: string): Promise<string> {
	return (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), prefix));
}

async function eventually(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(predicate(), true, "condition did not become true before timeout");
}

interface FakePi {
	readonly registered: Array<{ readonly name: string; readonly parameters?: unknown; readonly execute?: (...args: unknown[]) => unknown }>;
	readonly handlers: Map<string, Array<(event: any, ctx: any) => unknown>>;
	activeTools: string[];
	readonly sent: Array<{ readonly message: string; readonly options?: unknown }>;
	registerTool(tool: { readonly name: string; readonly parameters?: unknown; readonly execute?: (...args: unknown[]) => unknown }): void;
	registerCommand(): void;
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
	on(name: string, handler: (event: any, ctx: any) => unknown): void;
	sendUserMessage(message: string, options?: unknown): void;
}

function fakePi(activeTools: string[] = []): FakePi {
	const pi: FakePi = {
		registered: [], handlers: new Map(), activeTools: [...activeTools], sent: [],
		registerTool(tool) { this.registered.push(tool); },
		registerCommand() {},
		getActiveTools() { return [...this.activeTools]; },
		setActiveTools(names) { this.activeTools = [...names]; },
		on(name, handler) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); },
		sendUserMessage(message, options) { this.sent.push({ message, options }); },
	};
	return pi;
}

function workerContext(sessionId = "worker-session", sessionFile = "/tmp/worker-session.jsonl"): any {
	return {
		mode: "tui", hasUI: false, cwd: "/tmp", signal: new AbortController().signal,
		model: { provider: "provider", id: "model" }, thinkingLevel: "medium",
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile },
		abort() {}, shutdown() {},
	};
}

const profile = { model: "provider/model", thinking: "medium" as const };

async function connectedPair(options: {
	onReady?: (identity: TransportIdentity) => Promise<void> | void;
	onReport?: (event: TransportReportEvent) => Promise<void> | void;
	onSettled?: (event: TransportSettledEvent) => Promise<void> | void;
	token?: string;
	workerProfile?: typeof profile;
	workerContext?: any;
} = {}) {
	const directory = await temp("ticketflow-transport-");
	const server = new TransportServer({
		socketPath: path.join(directory, "bridge.sock"), runId: "run-1", assignmentId: "assignment-1",
		token: options.token ?? "token-1", requestedProfile: options.workerProfile ?? profile,
		...(options.onReady ? { onReady: options.onReady } : {}),
		...(options.onReport ? { onReport: options.onReport } : {}),
		...(options.onSettled ? { onSettled: options.onSettled } : {}),
	});
	await server.start();
	const pi = fakePi();
	const worker = new WorkerChannel({
		pi: pi as never, ctx: options.workerContext ?? workerContext(), socketPath: server.options.socketPath,
		runId: "run-1", assignmentId: "assignment-1", token: options.token ?? "token-1",
		requestedProfile: options.workerProfile ?? profile, retryDelaysMs: [20, 20, 20],
	});
	worker.start();
	await server.waitReady(AbortSignal.timeout(2_000));
	return { server, worker, pi };
}

async function closePair(pair: { server: TransportServer; worker: WorkerChannel }): Promise<void> {
	await pair.worker.close();
	await pair.server.close();
}

test("transport preserves report-before-settlement ordering and makes cancellation of wait inert", async () => {
	const events: string[] = [];
	const pair = await connectedPair({
		onReport: async () => { events.push("report"); },
		onSettled: async () => { events.push("settled"); },
	});
	try {
		const report: WorkerReport = { status: "blocked", summary: "need an answer", questions: ["What should I choose?"] };
		pair.worker.submitReport(report, 1);
		pair.worker.notifySettled(1);
		const settlement = await pair.server.waitForSettlement(1, AbortSignal.timeout(2_000));
		assert.equal(settlement.turn, 1);
		assert.deepEqual(events, ["report", "settled"]);

		const abort = new AbortController();
		const waiting = pair.server.waitForSettlement(2, abort.signal);
		abort.abort();
		await assert.rejects(waiting, /aborted/i);
		assert.equal(pair.worker.isReady, true, "cancelling a Main wait must not abort or disconnect the worker");
		pair.worker.notifySettled(2);
		await pair.server.waitForSettlement(2, AbortSignal.timeout(2_000));
	} finally { await closePair(pair); }
});

test("transport durable callback acknowledgement retries one exact report event until persistence succeeds", async () => {
	const received: string[] = [];
	let attempts = 0;
	const pair = await connectedPair({
		onReport: async (event) => {
			received.push(event.eventId);
			attempts += 1;
			if (attempts === 1) throw new Error("durable write temporarily failed");
		},
	});
	try {
		pair.worker.submitReport({ status: "failed", summary: "temporary failure" }, 1);
		await eventually(() => attempts >= 2, 2_500);
		assert.equal(new Set(received).size, 1, "retry must preserve the event ID and exact event identity");
	} finally { await closePair(pair); }
});

test("ticketflow_report returns terminate only after Main durably acknowledges the report", async () => {
	let release!: () => void;
	let callbackStarted = false;
	const durable = new Promise<void>((resolve) => { release = resolve; });
	const pair = await connectedPair({ onReport: async () => { callbackStarted = true; await durable; } });
	try {
		await pair.server.send({ command: "task", message: "exact task", turn: 1, requestId: "task-1" }, AbortSignal.timeout(2_000));
		const tool = pair.pi.registered.find((candidate) => candidate.name === "ticketflow_report")!;
		assert.equal(typeof (tool as { readonly renderCall?: unknown }).renderCall, "function");
		assert.equal(typeof (tool as { readonly renderResult?: unknown }).renderResult, "function");
		let completed = false;
		const execution = Promise.resolve(tool.execute!("report-call", { status: "failed", summary: "failed safely" }, new AbortController().signal, undefined, workerContext())).then((result) => { completed = true; return result; });
		await eventually(() => callbackStarted);
		assert.equal(completed, false, "report tool must wait for durable Main persistence");
		release();
		const result = await execution as { readonly terminate?: boolean };
		assert.equal(result.terminate, true);
	} finally { await closePair(pair); }
});

test("transport rejects authentication, requested profile, and effective session mismatches", async () => {
	const tokenPair = await connectedPair({ token: "right-token" });
	await closePair(tokenPair);

	const directory = await temp("ticketflow-transport-mismatch-");
	const server = new TransportServer({
		socketPath: path.join(directory, "bridge.sock"), runId: "run-1", assignmentId: "assignment-1",
		token: "right-token", requestedProfile: profile,
		onReady: (identity) => { if (identity.sessionId !== "expected-session") throw new Error("session mismatch"); },
	});
	await server.start();
	const wrongToken = new WorkerChannel({ pi: fakePi() as never, ctx: workerContext("expected-session"), socketPath: server.options.socketPath, runId: "run-1", assignmentId: "assignment-1", token: "wrong-token", requestedProfile: profile, retryDelaysMs: [10] });
	wrongToken.start();
	await eventually(() => !wrongToken.isConnected, 1_000);
	assert.equal(server.isAuthenticated, false);
	await wrongToken.close();
	await server.close();

	const profileDirectory = await temp("ticketflow-transport-profile-");
	const profileServer = new TransportServer({ socketPath: path.join(profileDirectory, "bridge.sock"), runId: "run-1", assignmentId: "assignment-1", token: "token", requestedProfile: profile });
	await profileServer.start();
	const wrongProfile = new WorkerChannel({ pi: fakePi() as never, ctx: workerContext(), socketPath: profileServer.options.socketPath, runId: "run-1", assignmentId: "assignment-1", token: "token", requestedProfile: { model: "provider/other", thinking: "medium" }, retryDelaysMs: [10] });
	wrongProfile.start();
	await eventually(() => !wrongProfile.isConnected, 1_000);
	assert.equal(profileServer.isAuthenticated, false);
	await wrongProfile.close();
	await profileServer.close();

	const sessionDirectory = await temp("ticketflow-transport-session-");
	const sessionServer = new TransportServer({ socketPath: path.join(sessionDirectory, "bridge.sock"), runId: "run-1", assignmentId: "assignment-1", token: "token", requestedProfile: profile, onReady: () => { throw new Error("persisted session differs"); } });
	await sessionServer.start();
	const wrongSession = new WorkerChannel({ pi: fakePi() as never, ctx: workerContext("wrong-session"), socketPath: sessionServer.options.socketPath, runId: "run-1", assignmentId: "assignment-1", token: "token", requestedProfile: profile, retryDelaysMs: [10] });
	wrongSession.start();
	await eventually(() => !wrongSession.isConnected, 1_000);
	assert.equal(sessionServer.isReady, false);
	await wrongSession.close();
	await sessionServer.close();
});

test("Main and Worker expose disjoint exact tool surfaces and strip stale Ticket Flow context", async () => {
	assert.deepEqual(MAIN_TICKETFLOW_TOOLS, ["ticketflow_delegate", "ticketflow_send", "ticketflow_wait", "ticketflow_close", "ticketflow_resume", "ticketflow_abort"]);
	assert.deepEqual(WORKER_TICKETFLOW_TOOLS, ["ticketflow_report"]);
	assert.equal(isTicketflowTool("ticketflow_report"), true);
	assert.equal(isTicketflowTool("workflow_legacy"), true);
	assert.equal(isAllowedTicketflowTool("ticketflow_delegate", "worker"), false);
	assert.equal(isAllowedTicketflowTool("ticketflow_report", "worker"), true);
	assert.equal(isAllowedTicketflowTool("ticketflow_report", "main"), false);

	const messages = [
		{ role: "assistant", content: [{ type: "toolCall", name: "ticketflow_delegate" }, { type: "text", text: "keep" }] },
		{ role: "assistant", content: [{ type: "toolCall", name: "ticketflow_report" }] },
		{ role: "toolResult", toolName: "ticketflow_delegate", content: "main result" },
		{ role: "toolResult", toolName: "ticketflow_report", content: "worker result" },
		{ role: "user", content: "ordinary" },
	];
	const mainFiltered = filterTicketflowContext(messages, "main");
	const workerFiltered = filterTicketflowContext(messages, "worker");
	assert.deepEqual(mainFiltered, [messages[0], { role: "assistant", content: [] }, messages[2], messages[4]]);
	assert.deepEqual(workerFiltered, [{ role: "assistant", content: [{ type: "text", text: "keep" }] }, messages[1], messages[3], messages[4]]);
	assert.match(auditToolBlocked("bash")!, /read-only/);
	assert.equal(auditToolBlocked("read"), undefined);
	assert.equal(auditToolBlocked("ticketflow_report"), undefined);

	assert.equal((TicketflowReportParametersSchema as { readonly type?: unknown }).type, "object", "worker tool parameters must be Google-compatible object schema");
	const earlyMain = fakePi();
	earlyMain.getActiveTools = () => { throw new Error("extension runtime not initialized"); };
	assert.doesNotThrow(() => ticketflow(earlyMain as never, { role: "main" }), "Main factory must not query runtime-only tool state");

	const main = fakePi(["ordinary", "ticketflow_report"]);
	ticketflow(main as never, { role: "main" });
	assert.deepEqual(main.registered.map((tool) => tool.name), [...MAIN_TICKETFLOW_TOOLS]);
	const mainToolCall = main.handlers.get("tool_call")![0]!({ toolName: "ticketflow_report" }, workerContext());
	assert.equal((mainToolCall as { readonly block?: boolean } | undefined)?.block, true);

	const worker = fakePi(["read", "ticketflow_send"]);
	const environment = {
		TICKETFLOW_ROLE: "worker", TICKETFLOW_KIND: "implementation", TICKETFLOW_RUN_ID: "run-1", TICKETFLOW_ASSIGNMENT_ID: "assignment-1",
		TICKETFLOW_SOCKET: "/tmp/nonexistent-ticketflow.sock", TICKETFLOW_TOKEN: "token", TICKETFLOW_REQUESTED_MODEL: "provider/model", TICKETFLOW_REQUESTED_THINKING: "medium",
	};
	ticketflow(worker as never, { role: "worker", environment });
	assert.deepEqual(worker.registered.map((tool) => tool.name), []);
	const start = worker.handlers.get("session_start")![0]!({}, workerContext());
	await Promise.resolve(start);
	assert.deepEqual(worker.registered.map((tool) => tool.name), ["ticketflow_report"]);
	assert.deepEqual(worker.activeTools, ["read", "ticketflow_report"]);
	const workerToolCall = worker.handlers.get("tool_call")![0]!({ toolName: "ticketflow_delegate" }, workerContext());
	assert.equal((workerToolCall as { readonly block?: boolean } | undefined)?.block, true);
	await Promise.resolve(worker.handlers.get("session_shutdown")![0]!({}, workerContext()));

	const audit = fakePi(["read", "bash", "edit", "write", "grep", "find", "ls", "rg", "fd"]);
	ticketflow(audit as never, { role: "worker", environment: { ...environment, TICKETFLOW_KIND: "audit" } });
	await Promise.resolve(audit.handlers.get("session_start")![0]!({}, workerContext()));
	assert.deepEqual(audit.activeTools, ["read", "grep", "find", "ls", "rg", "fd", "ticketflow_report"]);
	const bashResult = audit.handlers.get("user_bash")![0]!({ command: "rm -rf .", excludeFromContext: false, cwd: "/tmp" }, workerContext()) as { readonly result?: { readonly exitCode?: number } };
	assert.equal(bashResult.result?.exitCode, 126);
	await Promise.resolve(audit.handlers.get("session_shutdown")![0]!({}, workerContext()));
});
