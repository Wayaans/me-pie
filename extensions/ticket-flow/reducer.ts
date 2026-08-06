import type {
	Assignment,
	AuditFinding,
	AuditRound,
	ReportReference,
	RunPhase,
	TicketflowRun,
	WorkerState,
} from "./model.ts";
import { TicketflowTransitionError } from "./errors.ts";

function failure(message: string): TicketflowTransitionError {
	return new TicketflowTransitionError({ message });
}

type RunChanges = { [Key in keyof TicketflowRun]?: TicketflowRun[Key] | undefined };

function revised(run: TicketflowRun, changes: RunChanges, now: string): TicketflowRun {
	const next = { ...run, ...changes, revision: run.revision + 1, updatedAt: now } as unknown as Record<string, unknown>;
	for (const [key, value] of Object.entries(changes)) if (value === undefined) delete next[key];
	return next as unknown as TicketflowRun;
}

export function installAssignment(run: TicketflowRun, assignment: Assignment, now: string): TicketflowRun {
	if (run.phase === "paused" || run.phase === "completed" || run.phase === "cancelled") throw failure(`Cannot delegate while run is ${run.phase}.`);
	if (run.assignment || run.worker) throw failure("Exactly one assignment and worker may be active.");
	if (assignment.kind !== run.phase) throw failure(`Assignment kind ${assignment.kind} does not match run phase ${run.phase}.`);
	if (assignment.kind === "implementation" && assignment.ticketIndex !== run.currentTicket) throw failure("Implementation assignments must follow the durable ticket cursor.");
	const tickets = assignment.kind === "implementation"
		? run.tickets.map((ticket, index) => index === run.currentTicket ? { ...ticket, status: "running" as const } : ticket)
		: run.tickets;
	return revised(run, { assignment, tickets, report: undefined }, now);
}

export function attachWorker(run: TicketflowRun, worker: WorkerState, now: string): TicketflowRun {
	if (!run.assignment || run.worker) throw failure("A launching assignment without a worker is required.");
	if (worker.handle.assignmentId !== run.assignment.id || worker.handle.runId !== run.id) throw failure("Worker ownership does not match the active assignment.");
	return revised(run, { worker }, now);
}

export function verifyWorker(run: TicketflowRun, identity: NonNullable<WorkerState["identity"]>, now: string): TicketflowRun {
	if (!run.assignment || !run.worker) throw failure("Worker readiness requires an active assignment and owned handle.");
	const clearsCheckpoint = run.checkpoint?.step === "authenticate" || run.checkpoint?.step === "resume";
	return revised(run, {
		assignment: { ...run.assignment, stage: run.assignment.stage === "launching" ? "ready" : run.assignment.stage },
		worker: { ...run.worker, identity, connectedAt: now },
		...(clearsCheckpoint ? { checkpoint: undefined } : {}),
	}, now);
}

export function markDelivery(run: TicketflowRun, input: { readonly requestId: string; readonly delivery: "task" | "steer" | "follow-up"; readonly messageHash: string }, now: string): TicketflowRun {
	const assignment = run.assignment;
	if (!assignment || !run.worker?.identity) throw failure("A verified worker is required before sending work.");
	if (input.delivery === "task" && (assignment.turn !== 0 || assignment.stage !== "ready")) throw failure("The initial task may be sent exactly once to a ready assignment.");
	if (input.delivery !== "task" && assignment.turn === 0) throw failure("The initial task must be sent before follow-up work.");
	if (input.delivery === "steer" && (assignment.stage !== "running" || run.report !== undefined)) throw failure("Steering is allowed only during an active unreported worker turn.");
	const reportedFollowUp = assignment.stage === "settled" && (
		run.report?.status === "blocked"
		|| run.report?.status === "failed"
		|| (assignment.kind === "audit" && run.report?.status === "audit")
	);
	const resumedInterruptedFollowUp = assignment.stage === "ready" && assignment.turn > 0 && run.report === undefined;
	if (input.delivery === "follow-up" && !reportedFollowUp && !resumedInterruptedFollowUp) throw failure("Follow-up is allowed only after a durable blocked/failed report, a settled audit report, or an explicitly resumed interrupted turn.");
	const turn = assignment.turn + 1;
	const { lastSettledAt: _lastSettledAt, lastSettledTurn: _lastSettledTurn, ...unsettledWorker } = run.worker;
	return revised(run, {
		assignment: { ...assignment, stage: "running", turn, lastDelivery: { ...input, turn, acknowledgedAt: now } },
		worker: unsettledWorker,
		report: undefined,
		checkpoint: undefined,
	}, now);
}

export function interruptAmbiguousDelivery(run: TicketflowRun, input: { readonly requestId: string; readonly delivery: "task" | "steer" | "follow-up"; readonly messageHash: string }, now: string): TicketflowRun {
	const delivered = markDelivery(run, input, now);
	return revised(delivered, { assignment: { ...delivered.assignment!, stage: "interrupted" }, report: undefined, checkpoint: undefined }, now);
}

export function recordReport(run: TicketflowRun, reference: ReportReference, now: string): TicketflowRun {
	if (!run.assignment || reference.assignmentId !== run.assignment.id || reference.turn !== run.assignment.turn) throw failure("Report does not belong to the active assignment turn.");
	if (run.report) {
		if (run.report.assignmentId === reference.assignmentId && run.report.turn === reference.turn && run.report.hash === reference.hash && run.report.status === reference.status) return run;
		throw failure("A different immutable report already exists for this assignment turn.");
	}
	return revised(run, { report: reference }, now);
}

export function recordSettlement(run: TicketflowRun, turn: number, now: string): TicketflowRun {
	if (!run.assignment || !run.worker || turn !== run.assignment.turn || turn < 1) throw failure("Settlement does not belong to the active worker turn.");
	return revised(run, {
		assignment: { ...run.assignment, stage: "settled" },
		worker: { ...run.worker, lastSettledTurn: turn, lastSettledAt: now },
	}, now);
}

export function interruptAssignment(run: TicketflowRun, now: string): TicketflowRun {
	if (!run.assignment || !run.worker || run.assignment.stage !== "settled") throw failure("An aborted worker turn must durably settle before it becomes interrupted.");
	return revised(run, { assignment: { ...run.assignment, stage: "interrupted" }, checkpoint: undefined }, now);
}

export function resumeInterrupted(run: TicketflowRun, now: string): TicketflowRun {
	if (!run.assignment || !run.worker || run.assignment.stage !== "interrupted") throw failure("Only an interrupted assignment can become resumable.");
	const { lastSettledAt: _lastSettledAt, lastSettledTurn: _lastSettledTurn, ...worker } = run.worker;
	return revised(run, { assignment: { ...run.assignment, stage: "ready" }, worker, report: undefined, checkpoint: undefined }, now);
}

function assertSettledClose(run: TicketflowRun, kind: Assignment["kind"]): Assignment {
	const assignment = run.assignment;
	if (!assignment || assignment.kind !== kind) throw failure(`Close requires an active ${kind} assignment.`);
	if (assignment.stage !== "settled") throw failure(`A ${assignment.stage} ${kind} assignment cannot close; report and agent_settled are separate prerequisites.`);
	if (!run.worker || run.worker.lastSettledTurn !== assignment.turn || !run.report || run.report.assignmentId !== assignment.id || run.report.turn !== assignment.turn) {
		throw failure("Close requires the active turn's durable report and worker settlement.");
	}
	return assignment;
}

export function closeImplementation(run: TicketflowRun, acceptedCommitIds: readonly string[], acceptedHead: string, now: string): TicketflowRun {
	const assignment = assertSettledClose(run, "implementation");
	if (assignment.ticketIndex !== run.currentTicket || run.report?.status !== "completed") throw failure("The cursor can advance only through its completed active implementation assignment.");
	const tickets = run.tickets.map((ticket, index) => index === run.currentTicket
		? { ...ticket, status: "completed" as const, acceptedCommitIds }
		: ticket);
	const currentTicket = run.currentTicket + 1;
	const phase: RunPhase = currentTicket === tickets.length ? "audit" : "implementation";
	return revised(run, {
		phase,
		tickets,
		currentTicket,
		assignment: undefined,
		worker: undefined,
		report: undefined,
		checkpoint: undefined,
		git: { ...run.git, acceptedCommitIds: [...run.git.acceptedCommitIds, ...acceptedCommitIds], acceptedHead },
	}, now);
}

export function closeFix(run: TicketflowRun, acceptedCommitIds: readonly string[], acceptedHead: string, now: string): TicketflowRun {
	assertSettledClose(run, "fix");
	if (run.report?.status !== "completed") throw failure("A fixer requires a completed report before close.");
	return revised(run, {
		phase: "audit",
		assignment: undefined,
		worker: undefined,
		report: undefined,
		checkpoint: undefined,
		git: { ...run.git, acceptedCommitIds: [...run.git.acceptedCommitIds, ...acceptedCommitIds], acceptedHead },
	}, now);
}

export function closeAudit(run: TicketflowRun, round: AuditRound, now: string): TicketflowRun {
	const assignment = assertSettledClose(run, "audit");
	if (assignment.auditRound !== round.round || run.report?.status !== "audit") throw failure("Audit close does not match the active audit round/report.");
	const auditRounds = [...run.auditRounds.filter((candidate) => candidate.round !== round.round), round]
		.sort((left, right) => left.round - right.round);
	if (round.status === "clean") {
		return revised(run, { phase: "completed", auditRounds, findings: [], assignment: undefined, worker: undefined, report: undefined, checkpoint: undefined }, now);
	}
	return revised(run, { phase: "fix", auditRounds, findings: round.findings, assignment: undefined, worker: undefined, report: undefined, checkpoint: undefined }, now);
}

export function pauseRun(run: TicketflowRun, reason: TicketflowRun["pause"] extends infer _ ? "user" | "worker-failed" | "audit-no-progress" | "recovery" : never, message: string, now: string): TicketflowRun {
	if (run.phase === "completed" || run.phase === "cancelled") throw failure(`Cannot pause a ${run.phase} run.`);
	if (run.phase === "paused") return run;
	return revised(run, { phase: "paused", pause: { previousPhase: run.phase, reason, message, afterCurrentWorker: run.assignment?.stage === "running" } }, now);
}

export function resumeRun(run: TicketflowRun, now: string): TicketflowRun {
	if (run.phase !== "paused" || !run.pause) throw failure("Only a paused run can resume.");
	return revised(run, { phase: run.pause.previousPhase, pause: undefined }, now);
}

export function cancelRun(run: TicketflowRun, now: string): TicketflowRun {
	if (run.phase === "completed") throw failure("A completed run cannot be cancelled.");
	return revised(run, { phase: "cancelled", assignment: undefined, worker: undefined, report: undefined, checkpoint: undefined, pause: undefined }, now);
}

export function failTicket(run: TicketflowRun, message: string, now: string): TicketflowRun {
	const tickets = run.assignment?.kind === "implementation"
		? run.tickets.map((ticket, index) => index === run.currentTicket ? { ...ticket, status: "failed" as const } : ticket)
		: run.tickets;
	return pauseRun({ ...run, tickets }, "worker-failed", message, now);
}

export function sameFindingsWithoutNewCommits(run: TicketflowRun, hash: string): boolean {
	const previous = [...run.auditRounds].reverse().find((round) => round.status === "findings");
	return previous?.findingsHash === hash
		&& previous.acceptedHead === run.git.acceptedHead;
}

export function findingIds(findings: readonly AuditFinding[]): readonly string[] {
	return findings.map((finding) => finding.id);
}
