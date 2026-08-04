import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { assertCommandPrerequisites, parseTicketFlowCommand } from "../ticket-flow/command.ts";
import {
	boundStatusOutput,
	restoreToolsConservatively,
	restrictedToolList,
	WorkflowController,
} from "../ticket-flow/controller.ts";
import type { WorkflowPlan, WorkItem } from "../ticket-flow/domain.ts";
import ticketFlow from "../ticket-flow/index.ts";
import { appendOrchestratorSystemPrompt, ORCHESTRATOR_SYSTEM_PROMPT } from "../ticket-flow/orchestrator/system-prompt.ts";
import {
	WorkflowControlParameters,
	WorkflowPlanParameters,
	WorkflowReviewReportParameters,
	WorkflowWorkerParameters,
	registerOrchestratorTools,
} from "../ticket-flow/orchestrator/tools.ts";
import { detectWorkflowRole } from "../ticket-flow/role.ts";
import { TmuxController } from "../ticket-flow/tmux/controller.ts";

function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
	return Effect.runPromise(effect);
}

function temporaryDirectory(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function item(overrides: Partial<WorkItem> = {}): WorkItem {
	return {
		id: "domain",
		title: "Domain",
		sourcePaths: ["docs/ticket.md"],
		specificationPaths: ["docs/spec.md"],
		requirements: ["Define the domain"],
		order: 1,
		orderReason: "Foundation",
		dependsOn: [],
		delegationPrompt: "/implement @docs/ticket.md",
		launchProfile: { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
		completionStrategy: { type: "ledger-only" },
		status: "planned",
		...overrides,
	};
}

function plan(workItems: readonly WorkItem[] = [item()]): WorkflowPlan {
	return { summary: "Implement domain", workItems, userResolutions: [], finalized: false };
}

function fakeToolPi(activeTools = ["read", "bash", "edit", "ask_me", "other"]): {
	readonly pi: { getActiveTools(): string[]; setActiveTools(names: string[]): void };
	readonly active: () => string[];
} {
	let active = [...activeTools];
	return {
		pi: {
			getActiveTools: () => [...active],
			setActiveTools: (names) => { active = [...names]; },
		},
		active: () => [...active],
	};
}

test("command parsing preserves prompt text and reports unsupported input", () => {
	assert.deepEqual(parseTicketFlowCommand("  tmux   first line\n  second line  "), {
		backend: "tmux",
		prompt: "first line\n  second line",
	});
	assert.throws(() => parseTicketFlowCommand("screen do work"), /Unsupported.*screen/);
	assert.throws(() => parseTicketFlowCommand("tmux   "), /non-empty prompt/);
});

test("command prerequisites require TUI mode and active tmux", () => {
	assert.doesNotThrow(() => assertCommandPrerequisites({ mode: "tui", tmux: "/tmp/tmux,1,0" }));
	assert.throws(() => assertCommandPrerequisites({ mode: "rpc", tmux: "/tmp/tmux,1,0" }), /TUI mode/);
	assert.throws(() => assertCommandPrerequisites({ mode: "tui", tmux: undefined }), /active tmux/);
});

test("role detection selects worker only for the exact worker value", () => {
	assert.equal(detectWorkflowRole({ MEPIE_WORKFLOW_ROLE: "worker" }), "worker");
	assert.equal(detectWorkflowRole({ MEPIE_WORKFLOW_ROLE: "orchestrator" }), "orchestrator");
	assert.equal(detectWorkflowRole({}), "orchestrator");
	assert.throws(() => detectWorkflowRole({ MEPIE_WORKFLOW_ROLE: "unexpected" }), /Unsupported/);
});

test("run creation persists the prompt, acquires the lock, and restricts tools", async () => {
	const project = temporaryDirectory("ticket-flow-stage2-project-");
	const agentDir = temporaryDirectory("ticket-flow-stage2-agent-");
	const tools = fakeToolPi();
	const controller = new WorkflowController(tools.pi, () => new Date("2026-01-01T00:00:00.000Z"), () => "run-stage2");
	const run = await runEffect(controller.startRun({ cwd: project, prompt: "  preserve me  ", agentDir, sessionId: "session-1" }));
	assert.equal(run.originalPrompt, "  preserve me  ");
	assert.equal(run.phase, "analyzing");
	assert.equal(fs.existsSync(path.join(agentDir, "state", "ticket-flow", `${run.projectId}.lock`)), true);
	assert.equal(fs.existsSync(path.join(agentDir, "state", "ticket-flow", run.projectId, run.id, "state.json")), true);
	assert.deepEqual(tools.active(), ["read", "ask_me", "workflow_plan", "workflow_worker", "workflow_review_report", "workflow_control"]);
	await runEffect(controller.stop());
	assert.deepEqual(tools.active(), ["read", "bash", "edit", "ask_me", "other"]);
	assert.equal(fs.existsSync(path.join(agentDir, "state", "ticket-flow", `${run.projectId}.lock`)), false);
});

test("plan finalization rejects missing launch profiles and unresolved questions", async () => {
	const project = temporaryDirectory("ticket-flow-stage2-plan-");
	const agentDir = temporaryDirectory("ticket-flow-stage2-agent-");
	const tools = fakeToolPi();
	const controller = new WorkflowController(tools.pi, undefined, () => "run-plan");
	await runEffect(controller.startRun({ cwd: project, prompt: "plan", agentDir }));
	const { launchProfile: _launchProfile, ...missingProfile } = item();
	await runEffect(controller.savePlan(plan([missingProfile])));
	await assert.rejects(runEffect(controller.finalizePlan()), /explicit model and thinking level/);
	await runEffect(controller.savePlan(plan([item({ launchProfile: { model: "openai-codex/gpt-5.6-sol" } })])));
	await assert.rejects(runEffect(controller.finalizePlan()), /explicit model and thinking level/);
	await runEffect(controller.savePlan(plan(), ["Which API behavior?"]));
	await assert.rejects(runEffect(controller.finalizePlan()), /unresolved user question/);
	await runEffect(controller.updatePlan([{ type: "set-unresolved-questions", questions: [] }]));
	const ready = await runEffect(controller.finalizePlan());
	assert.equal(ready.phase, "ready");
	assert.equal(ready.plan.finalized, true);
	await runEffect(controller.stop());
});

test("plan validation rejects dependency cycles and logs typed updates", async () => {
	const project = temporaryDirectory("ticket-flow-stage2-cycle-");
	const agentDir = temporaryDirectory("ticket-flow-stage2-agent-");
	const tools = fakeToolPi();
	const controller = new WorkflowController(tools.pi, () => new Date("2026-01-02T00:00:00.000Z"), () => "run-cycle");
	await runEffect(controller.startRun({ cwd: project, prompt: "plan", agentDir }));
	await assert.rejects(runEffect(controller.savePlan(plan([
		item({ id: "a", order: 1, dependsOn: ["b"] }),
		item({ id: "b", order: 2, dependsOn: ["a"] }),
	]))), /dependency cycle/);
	await runEffect(controller.savePlan(plan()));
	const updated = await runEffect(controller.updatePlan([{ type: "set-summary", summary: "Updated" }]));
	assert.equal(updated.plan.summary, "Updated");
	assert.equal(updated.planning.changes.length, 1);
	await runEffect(controller.stop());
});

test("tool restriction restores only when no unrelated extension changed the active set", () => {
	const tools = fakeToolPi(["read", "bash", "ask_me"]);
	const previous = tools.pi.getActiveTools();
	const restricted = restrictedToolList(previous);
	tools.pi.setActiveTools(restricted);
	assert.equal(restoreToolsConservatively(tools.pi, previous, restricted), true);
	assert.deepEqual(tools.active(), previous);

	tools.pi.setActiveTools([...restricted, "new-extension-tool"]);
	assert.equal(restoreToolsConservatively(tools.pi, previous, restricted), false);
	assert.deepEqual(tools.active(), [...restricted, "new-extension-tool"]);
});

test("workflow tool schemas are strict and expose every legal action", () => {
	for (const action of ["save", "update", "finalize"]) {
		assert.equal(Check(WorkflowPlanParameters, { action }), true);
	}
	for (const action of ["delegate", "wait", "read", "send", "close"]) {
		assert.equal(Check(WorkflowWorkerParameters, { action, workItemId: "domain" }), true);
	}
	for (const action of ["inspect", "accept", "revise", "block"]) {
		assert.equal(Check(WorkflowReviewReportParameters, { action, workItemId: "domain" }), true);
	}
	for (const action of ["status", "pause", "resume", "stop", "recover"]) {
		assert.equal(Check(WorkflowControlParameters, { action }), true);
	}
	assert.equal(Check(WorkflowControlParameters, { action: "status", extra: true }), false);
	assert.equal(Check(WorkflowWorkerParameters, { action: "spawn", workItemId: "domain" }), false);
});

test("workflow tools dispatch legal actions and reject unavailable runtimes", async () => {
	const calls: string[] = [];
	const run = {
		id: "run-tools",
		projectId: "a".repeat(64),
		projectPath: "/project",
		originalPrompt: "plan",
		phase: "analyzing" as const,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		plan: plan(),
		planning: { unresolvedQuestions: [], changes: [] },
	};
	const controller = {
		activeRun: run,
		savePlan: () => Effect.sync(() => { calls.push("save"); return run; }),
		updatePlan: () => Effect.sync(() => { calls.push("update"); return run; }),
		finalizePlan: () => Effect.sync(() => {
			calls.push("finalize");
			return { ...run, phase: "ready" as const, plan: { ...run.plan, finalized: true } };
		}),
		status: () => Effect.succeed("status"),
		pause: () => Effect.sync(() => { calls.push("pause"); return { ...run, phase: "paused" as const }; }),
		stop: () => Effect.sync(() => { calls.push("stop"); return { ...run, phase: "stopped" as const }; }),
		startWorker: () => Effect.sync(() => { calls.push("startWorker"); return { ...run, phase: "executing" as const }; }),
		readWorker: () => Effect.fail(new Error("Stage 3 fake runtime unavailable")),
		closeWorker: () => Effect.fail(new Error("Stage 3 fake runtime unavailable")),
		waitWorker: () => Effect.fail(new Error("Stage 4 fake runtime unavailable")),
		sendWorkerFeedback: () => Effect.fail(new Error("Stage 4 fake runtime unavailable")),
	};
	type CapturedTool = { readonly name: string; readonly execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };
	const tools = new Map<string, CapturedTool>();
	registerOrchestratorTools({
		registerTool: (definition: CapturedTool) => { tools.set(definition.name, definition); },
	} as unknown as ExtensionAPI, controller as unknown as WorkflowController);
	await tools.get("workflow_plan")?.execute("id", { action: "save", plan: run.plan });
	await tools.get("workflow_plan")?.execute("id", { action: "update", changes: [{ type: "set-summary", summary: "next" }] });
	await tools.get("workflow_plan")?.execute("id", { action: "finalize" });
	await tools.get("workflow_control")?.execute("id", { action: "pause" });
	await tools.get("workflow_control")?.execute("id", { action: "stop" });
	assert.deepEqual(calls, ["save", "update", "finalize", "startWorker", "pause", "stop"]);
	await tools.get("workflow_worker")!.execute("id", { action: "delegate", workItemId: "domain" });
	for (const action of ["read", "close"]) {
		await assert.rejects(tools.get("workflow_worker")!.execute("id", { action, workItemId: "domain" }), /Stage 3/);
	}
	for (const action of ["wait", "send"] as const) {
		await assert.rejects(tools.get("workflow_worker")!.execute("id", { action, workItemId: "domain", ...(action === "send" ? { message: "feedback" } : {}) }), /Stage 4/);
	}
	for (const action of ["inspect", "accept", "revise", "block"]) {
		await assert.rejects(tools.get("workflow_review_report")!.execute("id", { action, workItemId: "domain" }), /No worker report/);
	}
	for (const action of ["resume", "recover"]) {
		await assert.rejects(tools.get("workflow_control")!.execute("id", { action }), /Stage 7/);
	}
});

test("status output is bounded by lines and bytes", () => {
	const byLines = boundStatusOutput(Array.from({ length: 2_100 }, (_, index) => `line-${index}`).join("\n"));
	assert.match(byLines, /truncated by line limit/);
	assert.ok(byLines.split("\n").length <= 2_001);
	const byBytes = boundStatusOutput("🙂".repeat(20_000));
	assert.ok(Buffer.byteLength(byBytes) <= 50 * 1024);
	assert.match(byBytes, /truncated by byte limit/);
});

test("orchestrator instructions append without replacing the original prompt", () => {
	const original = "Original user system prompt";
	const appended = appendOrchestratorSystemPrompt(original);
	assert.ok(appended.startsWith(original));
	assert.ok(appended.includes(ORCHESTRATOR_SYSTEM_PROMPT));
	assert.match(appended, /Never implement/);
	assert.match(appended, /explicit provider\/model/);
});

test("system-prompt injection is active only while a command-created run exists", async () => {
	const previousRole = process.env.MEPIE_WORKFLOW_ROLE;
	const previousTmux = process.env.TMUX;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	delete process.env.MEPIE_WORKFLOW_ROLE;
	process.env.TMUX = "/tmp/tmux,1,0";
	process.env.PI_CODING_AGENT_DIR = temporaryDirectory("ticket-flow-stage2-integration-agent-");
	try {
		const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		const sent: string[] = [];
		let active = ["read", "bash", "edit", "ask_me"];
		const fake = {
			registerCommand: (name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, definition.handler),
			registerTool: (definition: { name: string }) => { active.push(definition.name); },
			on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
			getActiveTools: () => [...active],
			setActiveTools: (names: string[]) => { active = [...names]; },
			appendEntry: () => undefined,
			sendUserMessage: (message: string) => { sent.push(message); },
		};
		const tmuxResponses = [
			{ stdout: "tmux 3.7\n", stderr: "", code: 0 },
			{ stdout: "/tmp/tmux.sock\t$1\tmain\t%1\n", stderr: "", code: 0 },
		];
		const tmux = new TmuxController({
			runner: { run: async () => tmuxResponses.shift()! },
			environment: { TMUX: "present" },
			tmuxExecutable: "/bin/tmux",
		});
		ticketFlow(fake as unknown as ExtensionAPI, { tmux });
		const before = handlers.get("before_agent_start");
		assert.equal(before?.({ systemPrompt: "base" }, {}), undefined);
		const project = temporaryDirectory("ticket-flow-stage2-integration-project-");
		const statuses: Array<string | undefined> = [];
		const ctx = {
			mode: "tui",
			hasUI: true,
			cwd: project,
			sessionManager: { getSessionId: () => "session-integration" },
			ui: {
				setStatus: (_key: string, value: string | undefined) => statuses.push(value),
				notify: (message: string) => { throw new Error(message); },
			},
		} as unknown as ExtensionContext;
		await commands.get("ticket-flow")?.("tmux  inspect @tickets exactly", ctx);
		assert.equal(sent.length, 1);
		const injected = before?.({ systemPrompt: "base" }, ctx) as { systemPrompt?: string } | undefined;
		assert.ok(injected?.systemPrompt?.startsWith("base"));
		assert.ok(injected?.systemPrompt?.includes(ORCHESTRATOR_SYSTEM_PROMPT));
		assert.match(statuses.at(-1) ?? "", /analyzing/);
		await handlers.get("session_shutdown")?.({}, ctx);
		assert.equal(before?.({ systemPrompt: "base" }, ctx), undefined);
	} finally {
		if (previousRole === undefined) delete process.env.MEPIE_WORKFLOW_ROLE;
		else process.env.MEPIE_WORKFLOW_ROLE = previousRole;
		if (previousTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = previousTmux;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("worker role excludes commands and workflow tools and rejects nested startup", () => {
	const previousRole = process.env.MEPIE_WORKFLOW_ROLE;
	process.env.MEPIE_WORKFLOW_ROLE = "worker";
	try {
		const commands: string[] = [];
		const tools: string[] = [];
		let inputHandler: ((event: { text: string }, ctx: ExtensionContext) => unknown) | undefined;
		const fake = {
			registerCommand: (name: string) => commands.push(name),
			registerTool: (definition: { name: string }) => tools.push(definition.name),
			on: (name: string, handler: typeof inputHandler) => { if (name === "input") inputHandler = handler; },
		};
		ticketFlow(fake as unknown as ExtensionAPI);
		assert.deepEqual(commands, []);
		assert.deepEqual(tools, []);
		const notices: string[] = [];
		const ctx = { hasUI: true, ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext;
		assert.deepEqual(inputHandler?.({ text: "/ticket-flow tmux nested" }, ctx), { action: "handled" });
		assert.match(notices[0] ?? "", /cannot start a nested workflow/);
	} finally {
		if (previousRole === undefined) delete process.env.MEPIE_WORKFLOW_ROLE;
		else process.env.MEPIE_WORKFLOW_ROLE = previousRole;
	}
});
