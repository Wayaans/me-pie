import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { Effect } from "effect";
import { WorkflowController } from "../ticket-flow/controller.ts";
import type { AuthoritativeWorkerContext, WorkerIdentity, WorkerReport, WorkflowRun, WorkItem } from "../ticket-flow/domain.ts";
import { pathsForProject } from "../ticket-flow/paths.ts";
import { ProtocolClient } from "../ticket-flow/protocol/client.ts";
import { ProtocolServer } from "../ticket-flow/protocol/server.ts";
import { readWorkflowToken } from "../ticket-flow/protocol/runtime.ts";
import {
	EXPECTED_REPORT_CONTRACT,
	WORKER_CONTEXT_MAX_BYTES,
	WorkerContextRuntime,
	makeAuthoritativeWorkerContext,
} from "../ticket-flow/worker/context.ts";
import {
	persistAcceptedReport,
	persistReportAttempt,
	safeReportItemId,
	validateWorkerReport,
	WorkerReportRuntime,
} from "../ticket-flow/worker/report.ts";
import { WorkflowContextParameters, WorkflowSubmitReportParameters, boundWorkerToolOutput, registerWorkerTools } from "../ticket-flow/worker/tools.ts";
import { workflowContextLabel, workflowReportLabel } from "../ticket-flow/worker/renderers.ts";

const profile = { model: "openai-codex/gpt-5.6-sol", thinking: "high" as const };
const identity: WorkerIdentity = { runId: "run-stage5", workItemId: "worker-tools", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high", sessionId: "session-5" };

function temporarySocket(name: string): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage5-socket-"));
	return path.join(directory, `${name}.sock`);
}

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
	return {
		id: "worker-tools",
		title: "Worker tools",
		sourcePaths: ["docs/ticket.md"],
		specificationPaths: ["docs/spec.md"],
		requirements: ["Implement context retrieval", "Submit a structured report"],
		order: 5,
		orderReason: "Protocol is complete",
		dependsOn: [],
		delegationPrompt: "/implement worker tools",
		launchProfile: profile,
		completionStrategy: { type: "ledger-only" },
		status: "running",
		...overrides,
	};
}

function run(item = workItem(), overrides: Partial<WorkflowRun> = {}): WorkflowRun {
	return {
		id: "run-stage5",
		projectId: "a".repeat(64),
		projectPath: "/project",
		originalPrompt: "implement stage 5",
		phase: "executing",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		plan: { summary: "stage 5", workItems: [item], userResolutions: [], finalized: true },
		planning: { unresolvedQuestions: [], changes: [] },
		activeWorkItemId: item.id,
		requestedLaunchProfile: profile,
		worker: identity,
		...overrides,
	};
}

function context(): AuthoritativeWorkerContext {
	return makeAuthoritativeWorkerContext(run(), workItem(), identity);
}

function completedReport(overrides: Partial<WorkerReport> = {}): WorkerReport {
	return {
		status: "completed",
		summary: "Implemented worker and report tools.",
		requirements: [
			{ requirementId: "requirement-1", result: "satisfied", evidence: "Context tool implemented." },
			{ requirement: "Submit a structured report", result: "satisfied", evidence: "Report tool implemented." },
		],
		filesChanged: ["extensions/ticket-flow/worker/tools.ts"],
		checks: [{ command: "bun test stage5", result: "passed", output: "passed" }],
		caveats: [],
		blockers: [],
		...overrides,
	};
}

async function eventually(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("worker tool schemas are strict and render compact labels", () => {
	assert.equal(Check(WorkflowContextParameters, { action: "get" }), true);
	assert.equal(Check(WorkflowContextParameters, { action: "wait-for-feedback", timeoutMs: 10 }), true);
	assert.equal(Check(WorkflowContextParameters, { action: "get", extra: true }), false);
	assert.equal(Check(WorkflowSubmitReportParameters, completedReport()), true);
	assert.equal(Check(WorkflowSubmitReportParameters, { status: "unknown", summary: "no" }), false);
	assert.equal(workflowContextLabel("get"), "workflow-worker · get");
	assert.equal(workflowReportLabel("progress"), "workflow-worker · submit · progress");
	assert.equal(workflowReportLabel("completed", 2, 2), "workflow-worker · submit · completed · 2/2 requirements");
});

test("authoritative context preserves identity, paths, requirements, and exact delegation while bounding prose", () => {
	const item = workItem({
		title: "x".repeat(100_000),
		sourcePaths: [`docs/${"p".repeat(5_000)}.md`],
		requirements: [`Preserve ${"r".repeat(5_000)}`, "Submit a structured report"],
	});
	const authoritative = makeAuthoritativeWorkerContext(run(item), item, identity);
	assert.equal(authoritative.runId, identity.runId);
	assert.equal(authoritative.workItemId, identity.workItemId);
	assert.deepEqual(authoritative.sourcePaths, item.sourcePaths);
	assert.deepEqual(authoritative.requirements.map((entry) => entry.requirement), item.requirements);
	assert.equal(authoritative.delegationPrompt, item.delegationPrompt);
	assert.deepEqual(authoritative.requestedLaunchProfile, profile);
	assert.deepEqual(authoritative.actualLaunchProfile, { provider: identity.provider, model: identity.model, thinking: identity.thinking });
	assert.equal(authoritative.truncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(authoritative)) <= WORKER_CONTEXT_MAX_BYTES);
});

test("completed reports require complete unique results, files, checks, caveats, and blockers", () => {
	assert.deepEqual(validateWorkerReport(completedReport(), context().requirements), { matchedRequirements: 2, plannedRequirements: 2 });
	const { requirements: _requirements, ...withoutRequirements } = completedReport();
	assert.throws(() => validateWorkerReport(withoutRequirements, context().requirements), /requires requirement results/);
	assert.throws(() => validateWorkerReport(completedReport({ requirements: [{ requirementId: "requirement-1", result: "satisfied", evidence: "one" }] }), context().requirements), /missing requirement/);
	assert.throws(() => validateWorkerReport(completedReport({ requirements: [
		{ requirementId: "requirement-1", result: "satisfied", evidence: "one" },
		{ requirementId: "requirement-1", result: "satisfied", evidence: "duplicate" },
	] }), context().requirements), /Duplicate result/);
	assert.throws(() => validateWorkerReport(completedReport({ filesChanged: [] }), context().requirements), /filesChangedExplanation/);
	assert.doesNotThrow(() => validateWorkerReport(completedReport({ filesChanged: [], filesChangedExplanation: "No repository changes were necessary." }), context().requirements));
	assert.throws(() => validateWorkerReport(completedReport({ checks: [{ command: "bun test", result: "not-run" }] }), context().requirements), /Reason for not running/);
	const { caveats: _caveats, ...withoutCaveats } = completedReport();
	const { blockers: _blockers, ...withoutBlockers } = completedReport();
	assert.throws(() => validateWorkerReport(withoutCaveats, context().requirements), /caveats is required/);
	assert.throws(() => validateWorkerReport(withoutBlockers, context().requirements), /blockers is required/);
});

test("progress, blocked, and failed reports enforce only their status-specific contract", () => {
	assert.doesNotThrow(() => validateWorkerReport({ status: "progress", summary: "Still working" }, context().requirements));
	assert.throws(() => validateWorkerReport({ status: "blocked", summary: "Need input", blockers: ["API choice"] }, context().requirements), /whether user intervention/);
	assert.doesNotThrow(() => validateWorkerReport({ status: "blocked", summary: "Need input", blockers: ["API choice"], userInterventionRequired: true }, context().requirements));
	assert.throws(() => validateWorkerReport({ status: "failed", summary: " " }, context().requirements), /non-empty/);
	assert.throws(() => validateWorkerReport({ status: "failed", summary: "oops" }, context().requirements), /useful failure summary/);
	assert.doesNotThrow(() => validateWorkerReport({ status: "failed", summary: "Compilation cannot continue" }, context().requirements));
	const bounded = boundWorkerToolOutput("x".repeat(100_000));
	assert.ok(Buffer.byteLength(bounded) <= 50 * 1024);
	assert.ok(bounded.split("\n").length <= 2_000);
});

test("final report attempts use safe filenames, secure modes, monotonic numbering, and accepted snapshots", async () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage5-project-"));
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage5-agent-"));
	const resolved = await Effect.runPromise(pathsForProject(project, "run-stage5", agent));
	const unsafeId = "../../worker tools";
	const unsafeIdentity = { ...identity, workItemId: unsafeId };
	const first = await Effect.runPromise(persistReportAttempt({ paths: resolved.paths, runId: "run-stage5", workItemId: unsafeId, submittedAt: "2026-01-01T00:00:00.000Z", identity: unsafeIdentity, requestedLaunchProfile: profile, report: completedReport() }));
	const second = await Effect.runPromise(persistReportAttempt({ paths: resolved.paths, runId: "run-stage5", workItemId: unsafeId, submittedAt: "2026-01-02T00:00:00.000Z", identity: unsafeIdentity, requestedLaunchProfile: profile, report: { status: "failed", summary: "Useful failure" } }));
	assert.equal(first.attempt.attempt, 1);
	assert.equal(second.attempt.attempt, 2);
	assert.equal(path.dirname(first.path), resolved.paths.reportsDir);
	assert.match(path.basename(first.path), new RegExp(`^${safeReportItemId(unsafeId)}-attempt-1\\.json$`));
	assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
	const accepted = await Effect.runPromise(persistAcceptedReport(resolved.paths, first.attempt, "2026-01-03T00:00:00.000Z"));
	assert.equal(fs.statSync(accepted).mode & 0o777, 0o600);
	assert.equal((JSON.parse(fs.readFileSync(accepted, "utf8")) as { acceptedAt: string }).acceptedAt, "2026-01-03T00:00:00.000Z");
	assert.equal(fs.existsSync(path.join(project, ".mepie")), false);
	fs.rmSync(project, { recursive: true, force: true });
	fs.rmSync(agent, { recursive: true, force: true });
});

test("authenticated context, report events, late waiters, feedback, and cancellation use native protocol", async () => {
	const socketPath = temporarySocket("native");
	const events: string[] = [];
	const server = new ProtocolServer({ socketPath, runId: identity.runId, workItemId: identity.workItemId, token: "secret", profile, onEvent: (event) => { events.push(event.type); } });
	await Effect.runPromise(server.start());
	const client = new ProtocolClient({ socketPath, identity, token: "secret", onDelegate: () => undefined, onFeedback: () => undefined, onShutdown: () => undefined, retryDelaysMs: [10] });
	await Effect.runPromise(client.start());
	await eventually(() => client.isVerified && server.isVerified);
	server.send("delegate", { prompt: context().delegationPrompt, context: context(), requestId: "delegate-stage5" });
	await eventually(() => client.authoritativeContext !== undefined);
	const contextRuntime = new WorkerContextRuntime(client);
	assert.equal(contextRuntime.get().workItemTitle, "Worker tools");

	const reports = new WorkerReportRuntime(client);
	await reports.submit({ status: "progress", summary: "Working" }, context());
	assert.equal((await server.wait((event) => event.type === "worker-progress")).type, "worker-progress", "event remains available to a late waiter");
	assert.ok(events.includes("worker-progress"));

	server.send("feedback", { kind: "revision", message: "Add evidence", missingRequirements: ["requirement-2"], requestId: "feedback-stage5" });
	const feedback = await contextRuntime.waitForFeedback(undefined, 500);
	assert.equal(feedback.type, "feedback");
	if (feedback.type === "feedback") assert.deepEqual(feedback.missingRequirements, ["requirement-2"]);
	const queued = server.send("feedback", { kind: "user-answer", message: "Use strict mode", requestId: "queued-feedback" })!;
	await server.waitForAcknowledgement(queued.requestId);
	const alreadyAborted = new AbortController();
	alreadyAborted.abort();
	await assert.rejects(contextRuntime.waitForFeedback(alreadyAborted.signal), /Abort/);
	assert.equal((await contextRuntime.waitForFeedback()).type, "feedback", "an already-cancelled wait does not consume queued feedback");
	const abort = new AbortController();
	const waiting = contextRuntime.waitForFeedback(abort.signal);
	abort.abort();
	await assert.rejects(waiting, /Abort/);
	assert.equal(client.isStopped, false);
	assert.equal(server.isVerified, true);

	await Effect.runPromise(client.shutdown());
	await Effect.runPromise(server.shutdown());
	fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
});

test("controller persists only final attempts, transitions completed reports, and exposes late native waits", async () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage5-controller-project-"));
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage5-controller-agent-"));
	const handle = {
		runId: "run-stage5", workItemId: "worker-tools", serverSocketPath: "/tmp/tmux.sock", sessionId: "$1", sessionName: "main",
		windowId: "@1", paneId: "%1", displayName: "tf-05-worker-tools", socketPath: "placeholder",
	};
	const tmux = {
		createWorkerWindow: (input: { socketPath: string }) => Effect.succeed({ ...handle, socketPath: input.socketPath }),
		closeWindow: () => Effect.succeed({ forced: false, alreadyExited: false }),
		detect: () => Effect.void,
		capturePane: () => Effect.succeed(""),
	};
	let tools = ["read", "bash"];
	const controller = new WorkflowController({ getActiveTools: () => [...tools], setActiveTools: (next) => { tools = [...next]; } }, () => new Date("2026-01-01T00:00:00.000Z"), () => "run-stage5", tmux as never);
	await Effect.runPromise(controller.startRun({ cwd: project, prompt: "stage 5", agentDir: agent }));
	await Effect.runPromise(controller.savePlan({ summary: "stage 5", auditProfile: profile, workItems: [{ ...workItem(), status: "planned" }], userResolutions: [], finalized: false }));
	await Effect.runPromise(controller.finalizePlan());
	const started = await Effect.runPromise(controller.startWorker("worker-tools"));
	const resolved = await Effect.runPromise(pathsForProject(project, "run-stage5", agent));
	const token = await Effect.runPromise(readWorkflowToken(resolved.paths.runDir));
	const client = new ProtocolClient({ socketPath: started.workflowSocketPath!, identity, token, onDelegate: () => undefined, onFeedback: () => undefined, onShutdown: () => undefined, retryDelaysMs: [10] });
	await Effect.runPromise(client.start());
	await eventually(() => client.authoritativeContext !== undefined);
	const reports = new WorkerReportRuntime(client);
	await reports.submit({ status: "progress", summary: "halfway" }, client.authoritativeContext!);
	assert.equal(controller.activeRun?.plan.workItems[0]?.status, "running");
	assert.deepEqual(fs.readdirSync(resolved.paths.reportsDir), []);
	await reports.submit(completedReport(), client.authoritativeContext!);
	assert.equal(controller.activeRun?.plan.workItems[0]?.status, "report-review");
	assert.deepEqual(fs.readdirSync(resolved.paths.reportsDir), ["worker-tools-attempt-1.json"]);
	assert.match(await Effect.runPromise(controller.waitWorker("worker-tools", "report", undefined, 500)), /worker-report/);
	await Effect.runPromise(client.shutdown());
	await Effect.runPromise(controller.shutdown());
	fs.rmSync(project, { recursive: true, force: true });
	fs.rmSync(agent, { recursive: true, force: true });
});

test("blocked reports persist an attempt and pause automatic progression", async () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage5-blocked-project-"));
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage5-blocked-agent-"));
	const runId = "run-stage5-blocked";
	const blockedIdentity = { ...identity, runId };
	const tmux = {
		createWorkerWindow: (input: { socketPath: string }) => Effect.succeed({
			runId, workItemId: "worker-tools", serverSocketPath: "/tmp/tmux.sock", sessionId: "$1", sessionName: "main",
			windowId: "@2", paneId: "%2", displayName: "tf-05-worker-tools", socketPath: input.socketPath,
		}),
		closeWindow: () => Effect.succeed({ forced: false, alreadyExited: false }),
		detect: () => Effect.void,
		capturePane: () => Effect.succeed(""),
	};
	let tools = ["read"];
	const controller = new WorkflowController({ getActiveTools: () => [...tools], setActiveTools: (next) => { tools = [...next]; } }, undefined, () => runId, tmux as never);
	await Effect.runPromise(controller.startRun({ cwd: project, prompt: "blocked", agentDir: agent }));
	await Effect.runPromise(controller.savePlan({ summary: "blocked", auditProfile: profile, workItems: [{ ...workItem(), status: "planned" }], userResolutions: [], finalized: false }));
	await Effect.runPromise(controller.finalizePlan());
	const started = await Effect.runPromise(controller.startWorker("worker-tools"));
	const resolved = await Effect.runPromise(pathsForProject(project, runId, agent));
	const token = await Effect.runPromise(readWorkflowToken(resolved.paths.runDir));
	const client = new ProtocolClient({ socketPath: started.workflowSocketPath!, identity: blockedIdentity, token, onDelegate: () => undefined, onFeedback: () => undefined, onShutdown: () => undefined, retryDelaysMs: [10] });
	await Effect.runPromise(client.start());
	await eventually(() => client.authoritativeContext !== undefined);
	await new WorkerReportRuntime(client).submit({ status: "blocked", summary: "A product choice is required", blockers: ["Choose the API behavior"], userInterventionRequired: true }, client.authoritativeContext!);
	assert.equal(controller.activeRun?.phase, "paused");
	assert.equal(controller.activeRun?.plan.workItems[0]?.status, "blocked");
	assert.deepEqual(fs.readdirSync(resolved.paths.reportsDir), ["worker-tools-attempt-1.json"]);
	await Effect.runPromise(client.shutdown());
	await Effect.runPromise(controller.shutdown());
	fs.rmSync(project, { recursive: true, force: true });
	fs.rmSync(agent, { recursive: true, force: true });
});

test("failed reports fail the run and satisfy final-report waits", async () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage5-failed-project-"));
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage5-failed-agent-"));
	const runId = "run-stage5-failed";
	const failedIdentity = { ...identity, runId };
	const tmux = {
		createWorkerWindow: (input: { socketPath: string }) => Effect.succeed({
			runId, workItemId: "worker-tools", serverSocketPath: "/tmp/tmux.sock", sessionId: "$1", sessionName: "main",
			windowId: "@3", paneId: "%3", displayName: "tf-05-worker-tools", socketPath: input.socketPath,
		}),
		closeWindow: () => Effect.succeed({ forced: false, alreadyExited: false }), detect: () => Effect.void, capturePane: () => Effect.succeed(""),
	};
	let tools = ["read"];
	const controller = new WorkflowController({ getActiveTools: () => [...tools], setActiveTools: (next) => { tools = [...next]; } }, undefined, () => runId, tmux as never);
	await Effect.runPromise(controller.startRun({ cwd: project, prompt: "failed", agentDir: agent }));
	await Effect.runPromise(controller.savePlan({ summary: "failed", auditProfile: profile, workItems: [{ ...workItem(), status: "planned" }], userResolutions: [], finalized: false }));
	await Effect.runPromise(controller.finalizePlan());
	const started = await Effect.runPromise(controller.startWorker("worker-tools"));
	const resolved = await Effect.runPromise(pathsForProject(project, runId, agent));
	const client = new ProtocolClient({ socketPath: started.workflowSocketPath!, identity: failedIdentity, token: await Effect.runPromise(readWorkflowToken(resolved.paths.runDir)), onDelegate: () => undefined, onFeedback: () => undefined, onShutdown: () => undefined, retryDelaysMs: [10] });
	await Effect.runPromise(client.start());
	await eventually(() => client.authoritativeContext !== undefined);
	await new WorkerReportRuntime(client).submit({ status: "failed", summary: "Typechecking could not continue" }, client.authoritativeContext!);
	assert.equal(controller.activeRun?.phase, "failed");
	assert.match(await Effect.runPromise(controller.waitWorker("worker-tools", "report", undefined, 500)), /worker-failed/);
	await Effect.runPromise(client.shutdown());
	await Effect.runPromise(controller.shutdown());
	fs.rmSync(project, { recursive: true, force: true });
	fs.rmSync(agent, { recursive: true, force: true });
});

test("transport failures are thrown by workflow_worker submit", async () => {
	const calls: string[] = [];
	type CapturedTool = { readonly name: string; readonly execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> };
	const tools = new Map<string, CapturedTool>();
	registerWorkerTools({ registerTool: (definition: CapturedTool) => tools.set(definition.name, definition) } as unknown as ExtensionAPI, () => ({
		getContext: () => context(),
		waitForFeedback: () => Promise.resolve({ type: "accepted" }),
		submitReport: async () => { calls.push("submit"); throw new Error("native transport unavailable"); },
	}));
	await assert.rejects(tools.get("workflow_worker")!.execute("id", { action: "submit", status: "progress", summary: "working" }), /native transport unavailable/);
	assert.deepEqual(calls, ["submit"]);
});
