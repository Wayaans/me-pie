import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { WorkflowController } from "../ticket-flow/controller.ts";
import type { PiLaunchProfile, ThinkingLevel, WorkItem, WorkerIdentity, WorkerReport } from "../ticket-flow/domain.ts";
import { replayEvents } from "../ticket-flow/event-store.ts";
import { pathsForProject } from "../ticket-flow/paths.ts";
import { ProtocolClient } from "../ticket-flow/protocol/client.ts";
import { readWorkflowToken } from "../ticket-flow/protocol/runtime.ts";
import { loadRun } from "../ticket-flow/state-store.ts";
import { WorkerReportRuntime } from "../ticket-flow/worker/report.ts";

const defaultProfile: PiLaunchProfile = { model: "openai-codex/gpt-5.6-sol", thinking: "high" };
let harnessSequence = 0;

function workItem(id: string, order: number, overrides: Partial<WorkItem> = {}): WorkItem {
	return {
		id,
		title: id.replaceAll("-", " "),
		sourcePaths: [`tickets/${id}.md`],
		specificationPaths: ["specs/workflow.md"],
		requirements: [`Implement ${id}`],
		order,
		orderReason: `Content dependencies place ${id} at position ${order}`,
		dependsOn: [],
		delegationPrompt: `/implement tickets/${id}.md using specs/workflow.md`,
		launchProfile: defaultProfile,
		completionStrategy: { type: "ledger-only" },
		status: "planned",
		...overrides,
	};
}

function completedReport(item: WorkItem, summary = `Completed ${item.id}`): WorkerReport {
	return {
		status: "completed",
		summary,
		requirements: item.requirements.map((_requirement, index) => ({
			requirementId: `requirement-${index + 1}`,
			result: "satisfied" as const,
			evidence: `Evidence for requirement ${index + 1}`,
		})),
		filesChanged: [],
		filesChangedExplanation: "The deterministic integration worker does not edit the fixture project.",
		checks: [{ command: "bun run typecheck", result: "passed" }],
		caveats: [],
		blockers: [],
	};
}

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for Ticket Flow state");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

class DeterministicTmux {
	readonly created: Array<{ readonly workItemId: string; readonly profile: PiLaunchProfile; readonly windowId: string }> = [];
	readonly closed: string[] = [];
	inspection: "alive" | "exited" | "missing" | "foreign" | "ambiguous" = "alive";

	createWorkerWindow(input: { runId: string; workItemId: string; profile: PiLaunchProfile; socketPath: string }) {
		const number = this.created.length + 1;
		const windowId = `@${number}`;
		this.created.push({ workItemId: input.workItemId, profile: input.profile, windowId });
		this.inspection = "alive";
		return Effect.succeed({
			runId: input.runId,
			workItemId: input.workItemId,
			serverSocketPath: "/tmp/tmux.sock",
			sessionId: "$1",
			sessionName: "main",
			windowId,
			paneId: `%${number}`,
			displayName: `tf-${number}-${input.workItemId}`,
			socketPath: input.socketPath,
		});
	}

	inspectWindow() {
		return Effect.succeed({ state: this.inspection });
	}

	closeWindow(handle: { readonly windowId: string }) {
		if (this.inspection === "foreign" || this.inspection === "ambiguous") {
			return Effect.fail(new Error("Refusing to close an unverified tmux window"));
		}
		this.closed.push(handle.windowId);
		this.inspection = "missing";
		return Effect.succeed({ forced: false, alreadyExited: false });
	}

	detect() { return Effect.void; }
	capturePane() { return Effect.succeed(""); }
}

class IntegrationHarness {
	readonly project = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage8-project-"));
	readonly agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-flow-stage8-agent-"));
	readonly runId = `stage8-${++harnessSequence}`;
	readonly tmux = new DeterministicTmux();
	readonly clients: ProtocolClient[] = [];
	readonly initialTools = ["read", "bash", "edit", "ask_me"];
	private tools = [...this.initialTools];
	controller = this.makeController();

	private makeController(): WorkflowController {
		return new WorkflowController({
			getActiveTools: () => [...this.tools],
			setActiveTools: (names) => { this.tools = [...names]; },
		}, () => new Date("2026-01-01T00:00:00.000Z"), () => this.runId, this.tmux as never);
	}

	get activeTools(): readonly string[] { return this.tools; }

	async begin(items: readonly WorkItem[]): Promise<void> {
		await Effect.runPromise(this.controller.startRun({ cwd: this.project, prompt: "deterministic stage 8 integration", agentDir: this.agentDir, sessionId: "orchestrator-session" }));
		await Effect.runPromise(this.controller.savePlan({ summary: "Stage 8 integration", workItems: items, userResolutions: [], finalized: false }));
		await Effect.runPromise(this.controller.finalizePlan());
		await Effect.runPromise(this.controller.startWorker([...items].sort((left, right) => left.order - right.order)[0]!.id));
	}

	async connect(workItemId: string, overrides: Partial<WorkerIdentity> = {}): Promise<ProtocolClient> {
		const workflowPaths = await Effect.runPromise(pathsForProject(this.project, this.runId, this.agentDir));
		const item = this.controller.activeRun!.plan.workItems.find((candidate) => candidate.id === workItemId)!;
		const [provider, model] = item.launchProfile!.model!.split("/", 2) as [string, string];
		const identity: WorkerIdentity = {
			runId: this.runId,
			workItemId,
			provider,
			model,
			thinking: item.launchProfile!.thinking!,
			sessionId: `worker-${workItemId}`,
			...overrides,
		};
		const client = new ProtocolClient({
			socketPath: this.controller.activeRun!.workflowSocketPath!,
			identity,
			token: await Effect.runPromise(readWorkflowToken(workflowPaths.paths.runDir)),
			onDelegate: () => undefined,
			onFeedback: () => undefined,
			onShutdown: () => undefined,
			retryDelaysMs: [5, 10],
		});
		this.clients.push(client);
		await Effect.runPromise(client.start());
		return client;
	}

	async connectReady(workItemId: string): Promise<ProtocolClient> {
		const client = await this.connect(workItemId);
		await eventually(() => client.authoritativeContext !== undefined);
		return client;
	}

	async submitCompleted(client: ProtocolClient, summary?: string): Promise<void> {
		const item = this.controller.activeRun!.plan.workItems.find((candidate) => candidate.id === client.options.identity.workItemId)!;
		await new WorkerReportRuntime(client).submit(completedReport(item, summary), client.authoritativeContext!);
		await eventually(() => this.controller.activeRun?.plan.workItems.find((candidate) => candidate.id === item.id)?.status === "report-review");
	}

	async replaceController(): Promise<void> {
		this.controller = this.makeController();
		await Effect.runPromise(this.controller.recover({ cwd: this.project, agentDir: this.agentDir, runId: this.runId, sessionId: "orchestrator-session" }));
	}

	assertNoProjectMetadata(): void {
		assert.deepEqual(fs.readdirSync(this.project), [], "workflow metadata must stay outside the project");
	}

	async cleanup(): Promise<void> {
		for (const client of this.clients) await Effect.runPromise(client.shutdown()).catch(() => undefined);
		if (this.controller.activeRun) await Effect.runPromise(this.controller.stop()).catch(() => Effect.runPromise(this.controller.shutdown()));
		this.assertNoProjectMetadata();
		fs.rmSync(this.project, { recursive: true, force: true });
		fs.rmSync(this.agentDir, { recursive: true, force: true });
	}
}

async function withHarness(run: (harness: IntegrationHarness) => Promise<void>): Promise<void> {
	const harness = new IntegrationHarness();
	try { await run(harness); }
	finally { await harness.cleanup(); }
}

test("1. a three-item run delegates and completes strictly sequentially", async () => withHarness(async (harness) => {
	const items = [
		workItem("domain", 1),
		workItem("repository", 2, { dependsOn: ["domain"] }),
		workItem("api", 3, { dependsOn: ["repository"] }),
	];
	await harness.begin(items);
	for (const item of items) {
		assert.equal(harness.controller.activeRun?.activeWorkItemId, item.id);
		const client = await harness.connectReady(item.id);
		await harness.submitCompleted(client);
		await Effect.runPromise(harness.controller.acceptReport(item.id, `Accepted ${item.id}`));
	}
	assert.deepEqual(harness.tmux.created.map(({ workItemId }) => workItemId), ["domain", "repository", "api"]);
	assert.equal(harness.controller.activeRun, undefined);
	harness.assertNoProjectMetadata();
}));

test("2. normalized content order overrides ticket filename order", async () => withHarness(async (harness) => {
	const contentFirst = workItem("database", 1, { sourcePaths: ["tickets/03-database.md"] });
	const filenameFirst = workItem("api", 2, { sourcePaths: ["tickets/01-api.md"], dependsOn: ["database"] });
	await harness.begin([filenameFirst, contentFirst]);
	const firstClient = await harness.connectReady("database");
	assert.deepEqual(firstClient.authoritativeContext?.sourcePaths, ["tickets/03-database.md"]);
	await harness.submitCompleted(firstClient);
	await Effect.runPromise(harness.controller.acceptReport("database", "Content dependency accepted"));
	assert.equal(harness.controller.activeRun?.activeWorkItemId, "api");
	harness.assertNoProjectMetadata();
}));

test("3. default launch profiles and a per-item override are preserved exactly", async () => withHarness(async (harness) => {
	const override: PiLaunchProfile = { model: "openai-codex/gpt-5.6-terra", thinking: "medium" };
	const first = workItem("default", 1);
	const second = workItem("override", 2, { dependsOn: ["default"], launchProfile: override });
	await harness.begin([first, second]);
	const client = await harness.connectReady("default");
	await harness.submitCompleted(client);
	await Effect.runPromise(harness.controller.acceptReport("default", "Default profile accepted"));
	assert.deepEqual(harness.tmux.created.map(({ profile }) => profile), [defaultProfile, override]);
	harness.assertNoProjectMetadata();
}));

test("4. missing model or thinking prevents finalization and worker creation", async () => withHarness(async (harness) => {
	await Effect.runPromise(harness.controller.startRun({ cwd: harness.project, prompt: "missing profile", agentDir: harness.agentDir }));
	await Effect.runPromise(harness.controller.savePlan({
		summary: "Missing profile",
		workItems: [workItem("missing-model", 1, { launchProfile: { thinking: "high" } })],
		userResolutions: [],
		finalized: false,
	}));
	await assert.rejects(Effect.runPromise(harness.controller.finalizePlan()), /explicit model and thinking level/);
	await Effect.runPromise(harness.controller.savePlan({
		summary: "Missing thinking",
		workItems: [workItem("missing-thinking", 1, { launchProfile: { model: defaultProfile.model } })],
		userResolutions: [],
		finalized: false,
	}));
	await assert.rejects(Effect.runPromise(harness.controller.finalizePlan()), /explicit model and thinking level/);
	assert.equal(harness.tmux.created.length, 0);
	harness.assertNoProjectMetadata();
}));

test("5. an actual worker model mismatch pauses before delegation", async () => withHarness(async (harness) => {
	await harness.begin([workItem("model-mismatch", 1)]);
	const client = await harness.connect("model-mismatch", { model: "gpt-5.6-terra" });
	await eventually(() => client.isStopped && harness.controller.activeRun?.phase === "paused");
	assert.equal(client.authoritativeContext, undefined);
	assert.equal(harness.controller.activeRun?.recoveryIssue?.kind, "profile-model");
	harness.assertNoProjectMetadata();
}));

test("6. a clamped worker thinking level pauses before delegation", async () => withHarness(async (harness) => {
	await harness.begin([workItem("thinking-mismatch", 1)]);
	const client = await harness.connect("thinking-mismatch", { thinking: "medium" as ThinkingLevel });
	await eventually(() => client.isStopped && harness.controller.activeRun?.phase === "paused");
	assert.equal(client.authoritativeContext, undefined);
	assert.equal(harness.controller.activeRun?.recoveryIssue?.kind, "profile-thinking");
	harness.assertNoProjectMetadata();
}));

test("7. progress is recorded before a valid completion report", async () => withHarness(async (harness) => {
	const item = workItem("progress", 1);
	await harness.begin([item]);
	const client = await harness.connectReady(item.id);
	await new WorkerReportRuntime(client).submit({ status: "progress", summary: "Half complete", filesChanged: [] }, client.authoritativeContext!);
	await harness.submitCompleted(client);
	const workflowPaths = await Effect.runPromise(pathsForProject(harness.project, harness.runId, harness.agentDir));
	const events = await Effect.runPromise(replayEvents(workflowPaths.paths.eventsFile));
	assert.ok(events.findIndex(({ type }) => type === "worker-progress") < events.findIndex(({ type }) => type === "worker-report"));
	assert.equal(harness.controller.activeRun?.plan.workItems[0]?.status, "report-review");
	harness.assertNoProjectMetadata();
}));

test("8. an invalid-for-review report is revised and accepted in the same worker", async () => withHarness(async (harness) => {
	const item = workItem("revision", 1);
	await harness.begin([item]);
	const client = await harness.connectReady(item.id);
	await new WorkerReportRuntime(client).submit({
		...completedReport(item, "Initial report says the requirement is not satisfied"),
		requirements: [{ requirementId: "requirement-1", result: "not-satisfied", evidence: "Implementation evidence is missing" }],
	}, client.authoritativeContext!);
	await eventually(() => harness.controller.activeRun?.plan.workItems[0]?.status === "report-review");
	await Effect.runPromise(harness.controller.reviseReport(item.id, "Provide concrete evidence", ["requirement-1"]));
	assert.equal(harness.tmux.created.length, 1);
	await harness.submitCompleted(client, "Revised report with concrete evidence");
	const finished = await Effect.runPromise(harness.controller.acceptReport(item.id, "Revised evidence accepted"));
	assert.equal(finished.plan.workItems[0]?.completion?.acceptedAttempt, 2);
	assert.equal(harness.tmux.created.length, 1);
	harness.assertNoProjectMetadata();
}));

test("9. a runtime blocker resumes in the same worker after a user resolution", async () => withHarness(async (harness) => {
	const item = workItem("blocker", 1);
	await harness.begin([item]);
	const client = await harness.connectReady(item.id);
	await new WorkerReportRuntime(client).submit({
		status: "blocked",
		summary: "A product choice is required",
		blockers: ["Choose strict or permissive behavior"],
		questions: ["Which behavior should be used?"],
		userInterventionRequired: true,
	}, client.authoritativeContext!);
	await eventually(() => harness.controller.activeRun?.plan.workItems[0]?.status === "blocked");
	await Effect.runPromise(harness.controller.blockReport(item.id));
	await Effect.runPromise(harness.controller.resumeBlockedWorker(item.id, ["Which behavior should be used?"], ["Use strict behavior"]));
	assert.equal(harness.controller.activeRun?.worker?.sessionId, "worker-blocker");
	assert.equal(harness.controller.activeRun?.plan.workItems[0]?.status, "running");
	assert.equal(harness.tmux.created.length, 1);
	harness.assertNoProjectMetadata();
}));

test("10. a worker crash before reporting pauses recovery without spawning a duplicate", async () => withHarness(async (harness) => {
	const item = workItem("crash", 1);
	await harness.begin([item]);
	const client = await harness.connectReady(item.id);
	const transport = client as unknown as { socket?: { destroy(error?: Error): void } };
	transport.socket?.destroy(new Error("simulated abrupt worker crash"));
	harness.tmux.inspection = "exited";
	await Effect.runPromise(harness.controller.shutdown());
	await harness.replaceController();
	assert.equal(harness.controller.activeRun?.phase, "paused");
	assert.equal(harness.controller.activeRun?.recoveryIssue?.kind, "window-missing");
	assert.equal(harness.tmux.created.length, 1);
	harness.assertNoProjectMetadata();
}));

test("11. orchestrator restart reconnects a running worker without duplication", async () => withHarness(async (harness) => {
	const item = workItem("restart", 1);
	await harness.begin([item]);
	const client = await harness.connectReady(item.id);
	await Effect.runPromise(harness.controller.shutdown());
	await harness.replaceController();
	await eventually(() => client.isVerified && harness.controller.activeRun?.phase === "executing");
	assert.equal(harness.controller.activeRun?.worker?.sessionId, "worker-restart");
	assert.equal(harness.tmux.created.length, 1);
	harness.assertNoProjectMetadata();
}));

test("12. a final report is durable before orchestrator acceptance", async () => withHarness(async (harness) => {
	const item = workItem("durable-report", 1);
	await harness.begin([item]);
	const client = await harness.connectReady(item.id);
	await harness.submitCompleted(client);
	const workflowPaths = await Effect.runPromise(pathsForProject(harness.project, harness.runId, harness.agentDir));
	const reportPath = path.join(workflowPaths.paths.reportsDir, "durable-report-attempt-1.json");
	assert.equal(fs.existsSync(reportPath), true);
	assert.equal(fs.statSync(reportPath).mode & 0o777, 0o600);
	const persisted = await Effect.runPromise(loadRun(workflowPaths.paths));
	assert.equal(persisted.plan.workItems[0]?.status, "report-review");
	assert.equal(persisted.plan.workItems[0]?.completion, undefined);
	harness.assertNoProjectMetadata();
}));

test("13. stop during active implementation interrupts only the active worker", async () => withHarness(async (harness) => {
	const item = workItem("stop", 1);
	await harness.begin([item]);
	await harness.connectReady(item.id);
	const stopped = await Effect.runPromise(harness.controller.stop());
	assert.equal(stopped.phase, "stopped");
	assert.equal(stopped.plan.workItems[0]?.status, "interrupted");
	assert.deepEqual(harness.tmux.closed, ["@1"]);
	assert.deepEqual(harness.activeTools, harness.initialTools);
	harness.assertNoProjectMetadata();
}));

test("14. stop never closes a foreign tmux window", async () => withHarness(async (harness) => {
	const item = workItem("foreign", 1);
	await harness.begin([item]);
	await harness.connectReady(item.id);
	harness.tmux.inspection = "foreign";
	const stopped = await Effect.runPromise(harness.controller.stop());
	assert.equal(stopped.phase, "stopped");
	assert.deepEqual(harness.tmux.closed, []);
	harness.assertNoProjectMetadata();
}));

test("15. final completion restores the orchestrator's original tool set", async () => withHarness(async (harness) => {
	const item = workItem("tools", 1);
	await harness.begin([item]);
	assert.notDeepEqual(harness.activeTools, harness.initialTools);
	const client = await harness.connectReady(item.id);
	await harness.submitCompleted(client);
	const finished = await Effect.runPromise(harness.controller.acceptReport(item.id, "All checks accepted"));
	assert.equal(finished.phase, "completed");
	assert.deepEqual(harness.activeTools, harness.initialTools);
	harness.assertNoProjectMetadata();
}));
