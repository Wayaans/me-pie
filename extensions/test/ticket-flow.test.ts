import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect, Result } from "effect";
import type { WorkflowPlan, WorkflowRun, WorkItem } from "../ticket-flow/domain.ts";
import { appendEvent, makeWorkflowEvent, replayEvents } from "../ticket-flow/event-store.ts";
import { acquireProjectLock } from "../ticket-flow/lock.ts";
import { pathsForProject, projectIdFromCanonicalPath, resolveWorkflowPaths } from "../ticket-flow/paths.ts";
import { decodeStateDocument, SCHEMA_VERSION } from "../ticket-flow/schemas.ts";
import { atomicWriteJson, loadRun, saveRun } from "../ticket-flow/state-store.ts";
import { transitionRun, transitionWorkItem, validatePlan } from "../ticket-flow/state-machine.ts";

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
	return { summary: "Implement domain", workItems, userResolutions: [], finalized: true };
}

function run(projectPath: string, workflowPlan = plan()): WorkflowRun {
	return {
		id: "run-1",
		projectId: projectIdFromCanonicalPath(projectPath),
		projectPath,
		originalPrompt: "Implement the ticket",
		phase: "ready",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		plan: workflowPlan,
	};
}

test("project IDs are stable for canonical paths and differ between projects", async () => {
	const projectA = temporaryDirectory("ticket-flow-project-a-");
	const projectB = temporaryDirectory("ticket-flow-project-b-");
	const alias = path.join(projectA, "alias");
	fs.symlinkSync(projectA, alias);
	const agentDir = temporaryDirectory("ticket-flow-agent-");
	const first = await Effect.runPromise(pathsForProject(projectA, "run", agentDir));
	const second = await Effect.runPromise(pathsForProject(alias, "run", agentDir));
	const other = await Effect.runPromise(pathsForProject(projectB, "run", agentDir));
	assert.equal(first.paths.projectDir, second.paths.projectDir);
	assert.notEqual(first.paths.projectDir, other.paths.projectDir);
});

test("workflow paths and writes remain outside the project", async () => {
	const project = temporaryDirectory("ticket-flow-project-");
	const agentDir = temporaryDirectory("ticket-flow-agent-");
	const { canonicalProjectPath, paths } = await Effect.runPromise(pathsForProject(project, "run-1", agentDir));
	await Effect.runPromise(saveRun(paths, run(canonicalProjectPath)));
	assert.equal(fs.readdirSync(project).length, 0);
	assert.equal(path.relative(project, paths.runDir).startsWith(".."), true);
});

test("workflow paths support a configured agent directory that does not exist yet", async () => {
	const project = temporaryDirectory("ticket-flow-project-");
	const parent = temporaryDirectory("ticket-flow-agent-parent-");
	const agentDir = path.join(parent, "new", "agent");
	const { paths } = await Effect.runPromise(pathsForProject(project, "run-1", agentDir));
	assert.equal(paths.agentDir.endsWith("/new/agent"), true);
	assert.equal(fs.existsSync(agentDir), false);
});

test("workflow paths reject direct and symlinked agent directories inside the project", async () => {
	const project = temporaryDirectory("ticket-flow-project-");
	fs.mkdirSync(path.join(project, ".agent"));
	await assert.rejects(
		Effect.runPromise(resolveWorkflowPaths(project, "run-1", path.join(project, ".agent"))),
		(error: unknown) => (error as { _tag?: string })._tag === "ValidationError",
	);
	const linkParent = temporaryDirectory("ticket-flow-agent-link-");
	const agentLink = path.join(linkParent, "agent");
	fs.symlinkSync(path.join(project, ".agent"), agentLink);
	await assert.rejects(
		Effect.runPromise(resolveWorkflowPaths(project, "run-1", agentLink)),
		(error: unknown) => (error as { _tag?: string })._tag === "ValidationError",
	);
});

test("state persistence binds run project metadata to its storage paths", async () => {
	const project = temporaryDirectory("ticket-flow-project-");
	const agentDir = temporaryDirectory("ticket-flow-agent-");
	const { canonicalProjectPath, paths } = await Effect.runPromise(pathsForProject(project, "run-1", agentDir));
	await assert.rejects(Effect.runPromise(saveRun(paths, {
		...run(canonicalProjectPath),
		projectId: "0".repeat(64),
	})));
});

test("state schema saves, loads, replaces atomically, and uses secure modes", async () => {
	const project = temporaryDirectory("ticket-flow-project-");
	const agentDir = temporaryDirectory("ticket-flow-agent-");
	const { canonicalProjectPath, paths } = await Effect.runPromise(pathsForProject(project, "run-1", agentDir));
	const original = run(canonicalProjectPath);
	await Effect.runPromise(saveRun(paths, original));
	const replacement = { ...original, phase: "executing" as const, updatedAt: "2026-01-02T00:00:00.000Z" };
	await Effect.runPromise(saveRun(paths, replacement));
	assert.deepEqual(await Effect.runPromise(loadRun(paths)), replacement);
	assert.equal(fs.statSync(paths.runDir).mode & 0o777, 0o700);
	assert.equal(fs.statSync(paths.reportsDir).mode & 0o777, 0o700);
	assert.equal(fs.statSync(paths.stateFile).mode & 0o777, 0o600);
	assert.equal(fs.statSync(paths.planFile).mode & 0o777, 0o600);
	assert.deepEqual(fs.readdirSync(paths.runDir).filter((name) => name.endsWith(".tmp")), []);
});

test("atomic write preserves the previous file when rename fails and cleans the temporary file", async () => {
	const directory = temporaryDirectory("ticket-flow-atomic-");
	const filePath = path.join(directory, "state.json");
	fs.writeFileSync(filePath, "previous\n", { mode: 0o600 });
	const failingFs = {
		mkdir: async () => undefined,
		chmod: async (target: string, mode: number) => fs.promises.chmod(target, mode),
		openExclusive: async (target: string, mode: number) => fs.promises.open(target, "wx", mode),
		rename: async () => { throw new Error("simulated rename failure"); },
		remove: async (target: string) => fs.promises.rm(target, { force: true }),
		readText: async (target: string) => fs.promises.readFile(target, "utf8"),
	};
	await assert.rejects(Effect.runPromise(atomicWriteJson(filePath, { next: true }, failingFs)));
	assert.equal(fs.readFileSync(filePath, "utf8"), "previous\n");
	assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
});

test("state decoding reports unsupported versions and corrupt data", async () => {
	const validRun = run("/canonical/project");
	await assert.rejects(
		Effect.runPromise(decodeStateDocument({ version: 99, run: validRun })),
		(error: unknown) => (error as { _tag?: string })._tag === "UnsupportedVersionError",
	);
	await assert.rejects(
		Effect.runPromise(decodeStateDocument({ version: SCHEMA_VERSION, run: { nope: true } })),
		(error: unknown) => (error as { _tag?: string })._tag === "CorruptDataError",
	);
	await assert.rejects(
		Effect.runPromise(decodeStateDocument({ run: validRun })),
		(error: unknown) => (error as { _tag?: string })._tag === "CorruptDataError",
	);
});

test("loading syntactically corrupt JSON returns a typed corruption error", async () => {
	const project = temporaryDirectory("ticket-flow-project-");
	const agentDir = temporaryDirectory("ticket-flow-agent-");
	const { paths } = await Effect.runPromise(pathsForProject(project, "run-1", agentDir));
	fs.mkdirSync(paths.runDir, { recursive: true });
	fs.writeFileSync(paths.stateFile, "{not-json", { mode: 0o600 });
	await assert.rejects(
		Effect.runPromise(loadRun(paths)),
		(error: unknown) => (error as { _tag?: string })._tag === "CorruptDataError",
	);
});

test("events append one JSON object per line and replay in order", async () => {
	const directory = temporaryDirectory("ticket-flow-events-");
	const filePath = path.join(directory, "events.jsonl");
	const clock = {
		now: () => new Date("2026-01-01T00:00:00.000Z"),
		randomId: () => "event-1",
	};
	const first = await Effect.runPromise(makeWorkflowEvent("run-1", "run-ready", { from: "analyzing", to: "ready" }, clock));
	const second = { ...first, id: "event-2", type: "run-executing" };
	await Effect.runPromise(appendEvent(filePath, first));
	await Effect.runPromise(appendEvent(filePath, second));
	assert.deepEqual(await Effect.runPromise(replayEvents(filePath)), [first, second]);
	assert.equal(fs.readFileSync(filePath, "utf8").trim().split("\n").length, 2);
	assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("events reject credentials and non-JSON data", async () => {
	for (const data of [{ apiKey: "raw-secret" }, { OPENAI_API_KEY: "raw-secret" }, { accessToken: "raw-secret" }, undefined]) {
		await assert.rejects(
			Effect.runPromise(makeWorkflowEvent("run-1", "unsafe", data)),
			(error: unknown) => (error as { _tag?: string })._tag === "ValidationError",
		);
	}
});

test("state rejects credentials and non-JSON completion values before writing", async () => {
	const project = temporaryDirectory("ticket-flow-project-");
	const agentDir = temporaryDirectory("ticket-flow-agent-");
	const { canonicalProjectPath, paths } = await Effect.runPromise(pathsForProject(project, "run-1", agentDir));
	await assert.rejects(Effect.runPromise(saveRun(paths, {
		...run(canonicalProjectPath),
		originalPrompt: "OPENAI_API_KEY=raw-secret",
	})));
	await assert.rejects(Effect.runPromise(saveRun(paths, run(canonicalProjectPath, plan([
		item({ completionStrategy: { type: "frontmatter", path: "ticket.md", field: "done", value: undefined } }),
	])))));
	assert.equal(fs.existsSync(paths.stateFile), false);
});

test("plan validation rejects duplicate IDs, missing dependencies, cycles, and multiple active workers", async () => {
	const invalidPlans = [
		plan([item(), item({ order: 2 })]),
		plan([item({ dependsOn: ["missing"] })]),
		plan([item({ id: "a", order: 1, dependsOn: ["b"] }), item({ id: "b", order: 2, dependsOn: ["a"] })]),
		plan([item({ id: "a", status: "running" }), item({ id: "b", order: 2, status: "blocked" })]),
	];
	for (const invalid of invalidPlans) {
		await assert.rejects(
			Effect.runPromise(validatePlan(invalid)),
			(error: unknown) => (error as { _tag?: string })._tag === "ValidationError",
		);
	}
});

test("ready items require completed dependencies and finalized items require explicit profiles", async () => {
	await assert.rejects(Effect.runPromise(validatePlan(plan([
		item({ id: "first", order: 1 }),
		item({ id: "second", order: 2, dependsOn: ["first"], status: "ready" }),
	]))));
	await assert.rejects(Effect.runPromise(validatePlan(plan([item({ launchProfile: { model: "missing-provider", thinking: "high" } })]))));
});

test("run persistence rejects inconsistent active worker identity", async () => {
	const project = temporaryDirectory("ticket-flow-project-");
	const agentDir = temporaryDirectory("ticket-flow-agent-");
	const { canonicalProjectPath, paths } = await Effect.runPromise(pathsForProject(project, "run-1", agentDir));
	await assert.rejects(Effect.runPromise(saveRun(paths, {
		...run(canonicalProjectPath),
		activeWorkItemId: "missing",
	})));
	await assert.rejects(Effect.runPromise(saveRun(paths, {
		...run(canonicalProjectPath),
		activeWorkItemId: "domain",
		worker: {
			runId: "different-run",
			workItemId: "domain",
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			thinking: "medium",
		},
	})));
});

test("state transitions reject illegal moves and accept idempotent retries", async () => {
	assert.equal(await Effect.runPromise(transitionRun("ready", "ready")), "ready");
	assert.equal(await Effect.runPromise(transitionWorkItem("running", "running")), "running");
	assert.equal(await Effect.runPromise(transitionWorkItem("report-review", "report-revision")), "report-revision");
	await assert.rejects(
		Effect.runPromise(transitionRun("completed", "executing")),
		(error: unknown) => (error as { _tag?: string })._tag === "IllegalTransitionError",
	);
	await assert.rejects(Effect.runPromise(transitionWorkItem("planned", "completed")));
});

test("project lock rejects path traversal IDs", async () => {
	const root = temporaryDirectory("ticket-flow-lock-traversal-");
	await assert.rejects(Effect.runPromise(Effect.scoped(acquireProjectLock(root, "../outside", "run-1"))));
	assert.equal(fs.existsSync(path.join(path.dirname(root), "outside.lock")), false);
});

test("project lock detects contention and releases only at scope exit", async () => {
	const root = temporaryDirectory("ticket-flow-lock-");
	const projectId = "a".repeat(64);
	await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
		const first = yield* acquireProjectLock(root, projectId, "run-1", { sessionId: "session-1" });
		const second = yield* Effect.scoped(acquireProjectLock(root, projectId, "run-2")).pipe(Effect.result);
		assert.equal(Result.isFailure(second), true);
		if (Result.isFailure(second)) assert.equal(second.failure._tag, "LockContentionError");
		assert.equal(first.owner.sessionId, "session-1");
		assert.equal(fs.statSync(first.path).mode & 0o777, 0o700);
		assert.equal(fs.statSync(path.join(first.path, "owner.json")).mode & 0o777, 0o600);
	})));
	await Effect.runPromise(Effect.scoped(acquireProjectLock(root, projectId, "run-2")));
});

test("an old lock holder does not remove a replacement acquisition for the same run", async () => {
	const root = temporaryDirectory("ticket-flow-lock-owner-");
	const projectId = "b".repeat(64);
	await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
		const lock = yield* acquireProjectLock(root, projectId, "run-1");
		const ownerPath = path.join(lock.path, "owner.json");
		const replacement = { ...lock.owner, acquisitionId: "replacement-acquisition" };
		fs.writeFileSync(ownerPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
		yield* lock.release();
		assert.equal(fs.existsSync(lock.path), true);
	})));
	fs.rmSync(path.join(root, `${projectId}.lock`), { recursive: true, force: true });
});
