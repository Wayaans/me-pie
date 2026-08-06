import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { StoredReport, Ticket, TicketflowRun } from "../ticket-flow/model.ts";
import {
	DIRECTORY_MODE,
	FILE_MODE,
	acquireProjectLock,
	assertNoLegacyRun,
	atomicWriteJson,
	loadRun,
	readStoredReport,
	resolvePaths,
	projectId,
	saveRun,
	writeReport,
} from "../ticket-flow/store.ts";
import {
	assertCleanWorktree,
	assertExactAuditScope,
	gitHead,
	gitPreflight,
	gitStatus,
	nodeGitRunner,
	verifyWorkerCommits,
} from "../ticket-flow/git.ts";

async function temp(prefix: string): Promise<string> {
	return (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), prefix));
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await nodeGitRunner.run(args, cwd);
	assert.equal(result.code, 0, `${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

async function repository(): Promise<string> {
	const directory = await temp("ticketflow-git-");
	await git(directory, "init", "-b", "main");
	await git(directory, "config", "user.email", "ticketflow-tests@example.invalid");
	await git(directory, "config", "user.name", "Ticket Flow Tests");
	await writeFile(path.join(directory, "README.md"), "baseline\n");
	await git(directory, "add", "README.md");
	await git(directory, "commit", "-m", "baseline");
	return directory;
}

const profile = { model: "provider/model", thinking: "medium" as const };
function ticket(index: number): Ticket {
	return { index, order: index + 1, name: `${index + 1}-ticket.md`, path: `/project/${index + 1}.md`, delegationPrompt: "prompt", status: "queued", acceptedCommitIds: [] };
}
function run(projectPath: string, paths: Awaited<ReturnType<typeof resolvePaths>>): TicketflowRun {
	return {
		version: 1,
		revision: 0,
		id: path.basename(paths.runDir),
		projectId: paths.projectId,
		projectPath,
		backend: "tmux",
		orchestratorSessionId: "main-session",
		phase: "implementation",
		setup: { ticketsDirectory: path.join(projectPath, "tickets"), referencePaths: [], workerProfile: profile, delegationTemplate: "prompt", completionConvention: "all-markdown-checkboxes" },
		tickets: [ticket(0)],
		currentTicket: 0,
		git: { baselineCommit: "base", branch: "main", acceptedCommitIds: [], acceptedHead: "base" },
		auditRounds: [],
		findings: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function storedReport(paths: Awaited<ReturnType<typeof resolvePaths>>): StoredReport {
	return {
		version: 1,
		runId: path.basename(paths.runDir),
		assignmentId: "assignment-1",
		worker: { sessionId: "worker-session", sessionFile: "/tmp/session.jsonl", provider: "provider", model: "model", thinking: "medium" },
		turn: 1,
		report: { status: "completed", summary: "done", commitIds: ["abc123"] },
		submittedAt: "2026-01-01T00:00:00.000Z",
	};
}

test("durable state is outside the project and contains only run.json plus the reports directory", async () => {
	const project = await temp("ticketflow-store-project-");
	const agent = await temp("ticketflow-store-agent-");
	const paths = await resolvePaths(project, "run-1", agent);
	await saveRun(paths, run(paths.projectPath, paths));
	assert.deepEqual(await readdir(project), []);
	assert.deepEqual((await readdir(paths.runDir)).sort(), ["reports", "run.json"]);
	assert.equal((await stat(paths.rootDir)).mode & 0o777, DIRECTORY_MODE);
	assert.equal((await stat(paths.projectDir)).mode & 0o777, DIRECTORY_MODE);
	assert.equal((await stat(paths.runDir)).mode & 0o777, DIRECTORY_MODE);
	assert.equal((await stat(paths.reportsDir)).mode & 0o777, DIRECTORY_MODE);
	assert.equal((await stat(paths.runFile)).mode & 0o777, FILE_MODE);
	assert.deepEqual(await loadRun(paths), run(paths.projectPath, paths));
});

test("reports are immutable owner-only content-addressed files and tampering is detected", async () => {
	const project = await temp("ticketflow-store-report-project-");
	const agent = await temp("ticketflow-store-report-agent-");
	const paths = await resolvePaths(project, "run-1", agent);
	const report = storedReport(paths);
	const written = await writeReport(paths, report);
	assert.equal((await stat(written.path)).mode & 0o777, FILE_MODE);
	assert.equal((await stat(written.path)).nlink, 1);
	const loaded = await readStoredReport(written.path, written.hash, paths.reportsDir);
	assert.deepEqual(loaded, report);
	await assert.rejects(readStoredReport(written.path, `${"0".repeat(64)}`, paths.reportsDir), /hash does not match/);
	await writeFile(written.path, `${JSON.stringify({ ...report, submittedAt: "tampered" })}\n`);
	await assert.rejects(readStoredReport(written.path, written.hash, paths.reportsDir), /hash does not match/);
	await chmod(written.path, 0o644);
	await assert.rejects(readStoredReport(written.path, undefined, paths.reportsDir), /owner-only immutable/);
});

test("durable writers reject credentials and non-plain/cyclic values", async () => {
	const project = await temp("ticketflow-store-secret-project-");
	const agent = await temp("ticketflow-store-secret-agent-");
	const paths = await resolvePaths(project, "run-1", agent);
	await mkdir(paths.runDir, { recursive: true });
	await assert.rejects(atomicWriteJson(paths.runFile, { apiKey: "should-never-persist" }), /must not contain credentials/);
	await assert.rejects(atomicWriteJson(paths.runFile, { nested: { authorization: "Bearer secret" } }), /must not contain credentials/);
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	await assert.rejects(atomicWriteJson(paths.runFile, cyclic), /cyclic/);
	await assert.rejects(atomicWriteJson(paths.runFile, new Date()), /plain objects/);
});

test("project lock is exclusive, owner-only, idempotently released, and recovers only a verified stale owner", async () => {
	const project = await temp("ticketflow-store-lock-project-");
	const agent = await temp("ticketflow-store-lock-agent-");
	const paths = await resolvePaths(project, "run-1", agent);
	const first = await acquireProjectLock(paths, "run-1", "session-a");
	assert.equal((await stat(path.join(paths.lockDir, "owner.json"))).mode & 0o777, FILE_MODE);
	await assert.rejects(acquireProjectLock(paths, "run-1", "session-b"), /locked by run run-1/);
	await first.release();
	await first.release();
	const second = await acquireProjectLock(paths, "run-1", "session-b");
	await second.release();
	assert.rejects(stat(paths.lockDir));

	await mkdir(paths.lockDir, { mode: DIRECTORY_MODE });
	const stale = { version: 1, runId: "run-1", acquisitionId: "old", pid: 99_999_999, sessionId: "old-session", createdAt: "2026-01-01T00:00:00.000Z" };
	await writeFile(path.join(paths.lockDir, "owner.json"), `${JSON.stringify(stale, null, 2)}\n`, { mode: FILE_MODE });
	await chmod(path.join(paths.lockDir, "owner.json"), FILE_MODE);
	const recovered = await acquireProjectLock(paths, "run-1", "new-session", "old-session");
	assert.notEqual(JSON.parse(await readFile(path.join(paths.lockDir, "owner.json"), "utf8")).acquisitionId, "old");
	await recovered.release();
});

test("breaking redesign refuses both legacy run directories and legacy project locks", async () => {
	const project = await temp("ticketflow-legacy-project-");
	const agent = await temp("ticketflow-legacy-agent-");
	const id = projectId(await realpath(project));
	const legacyProject = path.join(agent, "state", "ticket-flow", id, "old-run");
	await mkdir(legacyProject, { recursive: true });
	await writeFile(path.join(legacyProject, "plan.json"), "{}\n");
	await assert.rejects(assertNoLegacyRun(project, agent), /unfinished legacy Ticket Flow run/);
	await (await import("node:fs/promises")).rm(path.join(agent, "state", "ticket-flow", id), { recursive: true, force: true });
	await mkdir(path.join(agent, "state", "ticket-flow", `${id}.lock`), { recursive: true });
	await assert.rejects(assertNoLegacyRun(project, agent), /unfinished legacy Ticket Flow run/);
});

test("real Git preflight and worker verification require clean history and exact current HEAD", async () => {
	const project = await repository();
	const baseline = await gitPreflight(project);
	assert.equal(baseline.branch, "main");
	assert.deepEqual(await gitStatus(project), []);
	await writeFile(path.join(project, "implementation.txt"), "one\n");
	await git(project, "add", "implementation.txt");
	await git(project, "commit", "-m", "implementation one");
	const first = await gitHead(project);
	const verifiedFirst = await verifyWorkerCommits({ cwd: project, state: baseline, attemptBaseCommit: baseline.baselineCommit, reportedCommitIds: [first] });
	assert.deepEqual(verifiedFirst, { commitIds: [first], head: first });
	const accepted = { ...baseline, acceptedCommitIds: [first], acceptedHead: first };

	await writeFile(path.join(project, "implementation.txt"), "two\n");
	await git(project, "add", "implementation.txt");
	await git(project, "commit", "-m", "implementation two");
	const second = await gitHead(project);
	const verifiedSecond = await verifyWorkerCommits({ cwd: project, state: accepted, attemptBaseCommit: first, reportedCommitIds: [second] });
	assert.equal(verifiedSecond.head, second);
	await writeFile(path.join(project, "implementation.txt"), "three\n");
	await git(project, "add", "implementation.txt");
	await git(project, "commit", "-m", "implementation three");
	const third = await gitHead(project);
	await assert.rejects(verifyWorkerCommits({ cwd: project, state: accepted, attemptBaseCommit: first, reportedCommitIds: [third] }), /exactly equal every commit/);
	const corruptAuditState = { ...accepted, acceptedCommitIds: [third], acceptedHead: third };
	await assert.rejects(assertExactAuditScope({ cwd: project, state: corruptAuditState, acceptedCommitIds: [third], acceptedHead: third }), /complete implementation\/fix history/);
	await assert.rejects(verifyWorkerCommits({ cwd: project, state: accepted, attemptBaseCommit: first, reportedCommitIds: [first] }), /not new|current HEAD/);
	await assert.rejects(assertExactAuditScope({ cwd: project, state: accepted, acceptedCommitIds: [first], acceptedHead: first }), /exactly match/);
	await git(project, "reset", "--hard", first);
	await assertExactAuditScope({ cwd: project, state: accepted, acceptedCommitIds: [first], acceptedHead: first });
	await writeFile(path.join(project, "uncommitted.txt"), "dirty\n");
	await assert.rejects(assertCleanWorktree(project), /clean worktree/);
});
