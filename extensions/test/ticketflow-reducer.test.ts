import assert from "node:assert/strict";
import test from "node:test";
import type {
	Assignment,
	AuditFinding,
	AuditRound,
	ReportReference,
	Ticket,
	TicketflowRun,
	WorkerState,
} from "../ticket-flow/model.ts";
import {
	attachWorker,
	closeAudit,
	closeFix,
	closeImplementation,
	installAssignment,
	interruptAmbiguousDelivery,
	interruptAssignment,
	markDelivery,
	pauseRun,
	recordReport,
	recordSettlement,
	resumeInterrupted,
	resumeRun,
	sameFindingsWithoutNewCommits,
	verifyWorker,
} from "../ticket-flow/reducer.ts";

const now = "2026-01-01T00:00:00.000Z";
const later = "2026-01-01T00:00:01.000Z";
const profile = { model: "provider/model", thinking: "medium" as const };
const handle = {
	backend: "tmux" as const,
	serverSocketPath: "/tmp/tmux.sock",
	sessionId: "$0",
	sessionName: "main",
	windowId: "@1",
	paneId: "%1",
	runId: "run-1",
	assignmentId: "assignment-1",
	operationId: "operation-1",
	displayName: "worker",
};
const identity = {
	sessionId: "worker-session",
	sessionFile: "/tmp/worker-session.jsonl",
	provider: "provider",
	model: "model",
	thinking: "medium" as const,
};

function ticket(index: number): Ticket {
	return {
		index,
		order: index + 1,
		name: `${index + 1}-ticket.md`,
		path: `/project/${index + 1}-ticket.md`,
		delegationPrompt: `Implement ticket ${index + 1}`,
		status: "queued",
		acceptedCommitIds: [],
	};
}

function run(overrides: Partial<TicketflowRun> = {}): TicketflowRun {
	return {
		version: 1,
		revision: 0,
		id: "run-1",
		projectId: "project-1",
		projectPath: "/project",
		backend: "tmux",
		orchestratorSessionId: "main-session",
		phase: "implementation",
		setup: {
			ticketsDirectory: "/project/tickets",
			referencePaths: [],
			workerProfile: profile,
			delegationTemplate: "Implement {ticketPath}",
			completionConvention: "all-markdown-checkboxes",
		},
		tickets: [ticket(0), ticket(1)],
		currentTicket: 0,
		git: { baselineCommit: "base", branch: "main", acceptedCommitIds: [], acceptedHead: "base" },
		auditRounds: [],
		findings: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function assignment(kind: Assignment["kind"], overrides: Partial<Assignment> = {}): Assignment {
	return {
		id: `${kind}-1`,
		kind,
		title: kind,
		prompt: `${kind} prompt`,
		promptHash: `${kind}-hash`,
		promptSubstitutions: {},
		...(kind === "implementation" ? { ticketIndex: 0 } : { auditRound: 1 }),
		attemptBaseCommit: "base",
		stage: "launching",
		turn: 0,
		createdAt: now,
		...overrides,
	};
}

function worker(id = "worker-1", assignmentId = "implementation-1"): WorkerState {
	return {
		id,
		handle: { ...handle, assignmentId },
		requestedProfile: profile,
	};
}

function reportReference(assignmentId: string, turn: number, status: ReportReference["status"] = "completed"): ReportReference {
	return { id: `event-${assignmentId}-${turn}`, assignmentId, turn, status, path: `/state/reports/${assignmentId}-${turn}.json`, hash: `hash-${assignmentId}-${turn}`, createdAt: later };
}

function settleActive(current: TicketflowRun, status: ReportReference["status"]): TicketflowRun {
	const assignmentId = current.assignment!.id;
	let settled = attachWorker(current, worker(`worker-${assignmentId}`, assignmentId), now);
	settled = verifyWorker(settled, identity, now);
	settled = markDelivery(settled, { requestId: `request-${assignmentId}`, delivery: "task", messageHash: "hash" }, now);
	settled = recordReport(settled, reportReference(assignmentId, 1, status), now);
	return recordSettlement(settled, 1, later);
}

function finding(): AuditFinding {
	return { id: "finding-1", severity: "high", finding: "The requirement is incomplete.", evidence: "src/file.ts:1" };
}

function auditRound(status: AuditRound["status"], round = 1, findings: readonly AuditFinding[] = []): AuditRound {
	return {
		round,
		assignmentId: `audit-${round}`,
		template: "audit template",
		prompt: `audit ${round}`,
		promptHash: `audit-hash-${round}`,
		substitutions: {},
		acceptedCommitIds: ["commit-1"],
		acceptedHead: "commit-1",
		status,
		findings,
		...(findings.length > 0 ? { findingsHash: "findings-hash" } : {}),
		createdAt: now,
	};
}

test("reducer permits exactly one active assignment and worker and preserves the durable ticket cursor", () => {
	let current = installAssignment(run(), assignment("implementation"), now);
	assert.equal(current.tickets[0]!.status, "running");
	assert.throws(() => installAssignment(current, assignment("implementation", { id: "other" }), now), /Exactly one assignment/);
	current = attachWorker(current, worker(), now);
	assert.throws(() => attachWorker(current, worker("worker-2"), now), /launching assignment without a worker/);
	assert.throws(() => installAssignment(current, assignment("implementation", { id: "other" }), now), /Exactly one assignment/);
	current = verifyWorker(current, identity, later);
	assert.equal(current.assignment?.stage, "ready");
	current = markDelivery(current, { requestId: "request-1", delivery: "task", messageHash: "prompt-hash" }, later);
	assert.equal(current.assignment?.turn, 1);
	assert.equal(current.assignment?.stage, "running");
	current = recordReport(current, reportReference("implementation-1", 1), later);
	current = recordSettlement(current, 1, later);
	current = closeImplementation(current, ["commit-1"], "commit-1", later);
	assert.equal(current.currentTicket, 1);
	assert.equal(current.tickets[0]!.status, "completed");
	assert.equal(current.phase, "implementation");
	assert.equal(current.tickets[1]!.status, "queued");
});

test("report and settlement are separate monotonic facts and follow-up turns cannot be sent before the task", () => {
	let current = verifyWorker(attachWorker(installAssignment(run(), assignment("implementation"), now), worker(), now), identity, now);
	assert.throws(() => markDelivery(current, { requestId: "follow-up-before-task", delivery: "follow-up", messageHash: "x" }, now), /initial task/);
	current = markDelivery(current, { requestId: "request-1", delivery: "task", messageHash: "hash" }, now);
	current = recordReport(current, reportReference("implementation-1", 1, "blocked"), now);
	assert.equal(current.report?.turn, 1);
	assert.equal(current.assignment?.stage, "running", "a report must not imply agent_settled");
	assert.throws(() => recordSettlement(current, 2, later), /does not belong/);
	current = recordSettlement(current, 1, later);
	assert.equal(current.assignment?.stage, "settled");
	assert.equal(current.worker?.lastSettledTurn, 1);
	current = markDelivery(current, { requestId: "request-2", delivery: "follow-up", messageHash: "follow-up" }, later);
	assert.equal(current.assignment?.turn, 2);
	assert.equal(current.report, undefined);
	assert.equal(current.worker?.lastSettledTurn, undefined, "starting a new turn clears the prior settlement marker");
});

test("interrupted assignments are not valid close inputs", () => {
	let current = verifyWorker(attachWorker(installAssignment(run(), assignment("implementation"), now), worker(), now), identity, now);
	current = markDelivery(current, { requestId: "request-1", delivery: "task", messageHash: "hash" }, now);
	current = recordSettlement(current, 1, later);
	current = interruptAssignment(current, later);
	assert.equal(current.assignment?.stage, "interrupted");
	assert.throws(
		() => closeImplementation(current, ["commit-1"], "commit-1", later),
		/interrupted/,
		"an interrupted turn must require an explicit follow-up/resume rather than advancing the cursor",
	);
	current = resumeInterrupted(current, later);
	current = markDelivery(current, { requestId: "retry", delivery: "follow-up", messageHash: "retry-hash" }, later);
	assert.equal(current.assignment?.stage, "running");
	assert.equal(current.assignment?.turn, 2);
});

test("ambiguous recovered delivery advances once, interrupts safely, and requires explicit resume/follow-up", () => {
	let current = verifyWorker(attachWorker(installAssignment(run(), assignment("implementation"), now), worker(), now), identity, now);
	current = interruptAmbiguousDelivery(current, { requestId: "ambiguous", delivery: "task", messageHash: "hash" }, later);
	assert.equal(current.assignment?.turn, 1);
	assert.equal(current.assignment?.stage, "interrupted");
	assert.equal(current.checkpoint, undefined);
	current = resumeInterrupted(current, later);
	current = markDelivery(current, { requestId: "follow-up", delivery: "follow-up", messageHash: "continue" }, later);
	assert.equal(current.assignment?.turn, 2);
	assert.equal(current.assignment?.stage, "running");
});

test("audit findings transition to fix and then to a fresh audit, while a clean audit is terminal", () => {
	const findingOne = finding();
	let current = run({ phase: "audit", git: { baselineCommit: "base", branch: "main", acceptedCommitIds: ["commit-1"], acceptedHead: "commit-1" } });
	current = installAssignment(current, assignment("audit", { id: "audit-1", auditRound: 1 }), now);
	current = settleActive(current, "audit");
	const withFindings = auditRound("findings", 1, [findingOne]);
	current = closeAudit(current, withFindings, later);
	assert.equal(current.phase, "fix");
	assert.deepEqual(current.findings, [findingOne]);
	assert.equal(current.auditRounds.length, 1);

	current = installAssignment(current, assignment("fix", { id: "fix-1", auditRound: 1 }), later);
	current = settleActive(current, "completed");
	current = closeFix(current, ["fix-commit"], "fix-commit", later);
	assert.equal(current.phase, "audit");
	assert.deepEqual(current.git.acceptedCommitIds, ["commit-1", "fix-commit"]);
	assert.equal(current.assignment, undefined);

	current = installAssignment(current, assignment("audit", { id: "audit-2", auditRound: 2 }), later);
	current = settleActive(current, "audit");
	const clean = auditRound("clean", 2, []);
	current = closeAudit(current, clean, later);
	assert.equal(current.phase, "completed");
	assert.equal(current.assignment, undefined);
	assert.equal(current.worker, undefined);
	assert.equal(current.findings.length, 0);
	assert.throws(() => installAssignment(current, assignment("audit", { id: "late" }), later), /completed/);
});

test("same findings without a new accepted head is detected for no-progress handling", () => {
	const findingOne = finding();
	const current = run({
		phase: "fix",
		git: { baselineCommit: "base", branch: "main", acceptedCommitIds: ["commit-1"], acceptedHead: "commit-1" },
		auditRounds: [auditRound("findings", 1, [findingOne])],
	});
	assert.equal(sameFindingsWithoutNewCommits(current, "findings-hash"), true);
	assert.equal(sameFindingsWithoutNewCommits(current, "different-hash"), false);
	const paused = pauseRun(current, "audit-no-progress", "same findings", later);
	assert.equal(paused.phase, "paused");
	assert.equal(paused.pause?.reason, "audit-no-progress");
	assert.equal(resumeRun(paused, later).phase, "fix");
});
