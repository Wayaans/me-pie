export const TICKETFLOW_VERSION = 1 as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type RunPhase =
	| "implementation"
	| "audit"
	| "fix"
	| "paused"
	| "completed"
	| "failed"
	| "cancelled";

export type AssignmentKind = "implementation" | "audit" | "fix";
export type AssignmentStage = "launching" | "ready" | "running" | "settled" | "interrupted";
export type TicketStatus = "queued" | "running" | "completed" | "blocked" | "failed";

export interface WorkerProfile {
	readonly model: string;
	readonly thinking: ThinkingLevel;
}

export interface SkippedTicket {
	readonly order: number;
	readonly name: string;
	readonly path: string;
	readonly requirements: readonly string[];
	readonly reason: "already-complete";
}

export interface TicketflowSetup {
	readonly ticketsDirectory: string;
	readonly referencePaths: readonly string[];
	readonly workerProfile: WorkerProfile;
	readonly delegationTemplate: string;
	readonly completionConvention: "all-markdown-checkboxes";
	/** Optional for compatibility with runs created before completed-ticket filtering. */
	readonly skippedTickets?: readonly SkippedTicket[];
}

export interface Ticket {
	readonly index: number;
	readonly order: number;
	readonly name: string;
	readonly path: string;
	readonly delegationPrompt: string;
	readonly requirements?: readonly string[];
	readonly status: TicketStatus;
	readonly acceptedCommitIds: readonly string[];
}

export interface RequirementVerdict {
	readonly requirement: string;
	readonly verdict: "pass" | "fail" | "not-applicable";
	readonly evidence: string;
	readonly fixes?: readonly string[];
}

export interface AuditFinding {
	readonly id: string;
	readonly severity: "critical" | "high" | "medium" | "low";
	readonly finding: string;
	readonly evidence: string;
	readonly requirement?: string;
	readonly fix?: string;
}

export type WorkerReport =
	| { readonly status: "completed"; readonly summary: string; readonly commitIds: readonly string[] }
	| { readonly status: "blocked"; readonly summary: string; readonly questions: readonly string[] }
	| { readonly status: "failed"; readonly summary: string }
	| {
		readonly status: "audit";
		readonly summary: string;
		readonly verdicts: readonly RequirementVerdict[];
		readonly findings: readonly AuditFinding[];
		readonly auditedCommitIds: readonly string[];
	};

export interface ReportReference {
	readonly id: string;
	readonly assignmentId: string;
	readonly turn: number;
	readonly status: WorkerReport["status"];
	readonly path: string;
	readonly hash: string;
	readonly createdAt: string;
}

export interface WorkerIdentity {
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly provider: string;
	readonly model: string;
	readonly thinking: ThinkingLevel;
	/** False only before Pi has materialized the future session file with its header. */
	readonly sessionMaterialized?: boolean;
}

export interface TmuxHandle {
	readonly backend: "tmux";
	readonly serverSocketPath: string;
	readonly sessionId: string;
	readonly sessionName: string;
	readonly windowId: string;
	readonly paneId: string;
	readonly runId: string;
	readonly assignmentId: string;
	readonly operationId: string;
	readonly displayName: string;
}

export type SerializedWorkerHandle = TmuxHandle;

export interface WorkerState {
	readonly id: string;
	readonly handle: SerializedWorkerHandle;
	readonly requestedProfile: WorkerProfile;
	readonly identity?: WorkerIdentity;
	readonly connectedAt?: string;
	readonly lastSettledTurn?: number;
	readonly lastSettledAt?: string;
}

export interface DeliveryRecord {
	readonly requestId: string;
	readonly delivery: "task" | "steer" | "follow-up";
	readonly messageHash: string;
	readonly turn: number;
	readonly acknowledgedAt: string;
}

export interface Assignment {
	readonly id: string;
	readonly kind: AssignmentKind;
	readonly title: string;
	readonly prompt: string;
	readonly promptHash: string;
	readonly promptSubstitutions: Readonly<Record<string, string>>;
	readonly ticketIndex?: number;
	readonly auditRound?: number;
	readonly findingIds?: readonly string[];
	readonly auditCommitIds?: readonly string[];
	readonly auditRequirements?: readonly string[];
	readonly attemptBaseCommit: string;
	readonly stage: AssignmentStage;
	readonly turn: number;
	readonly createdAt: string;
	readonly lastDelivery?: DeliveryRecord;
}

export interface AuditRound {
	readonly round: number;
	readonly assignmentId: string;
	readonly template: string;
	readonly prompt: string;
	readonly promptHash: string;
	readonly substitutions: Readonly<Record<string, string>>;
	readonly acceptedCommitIds: readonly string[];
	readonly acceptedHead: string;
	readonly status: "pending" | "findings" | "clean";
	readonly report?: ReportReference;
	readonly findings: readonly AuditFinding[];
	readonly findingsHash?: string;
	readonly createdAt: string;
	readonly completedAt?: string;
}

export interface GitState {
	readonly baselineCommit: string;
	readonly branch: string;
	readonly acceptedCommitIds: readonly string[];
	readonly acceptedHead: string;
}

export interface OperationCheckpoint {
	readonly operationId: string;
	readonly step: "launch" | "authenticate" | "send" | "wait" | "verify" | "close" | "resume" | "abort";
	readonly assignmentId?: string;
	readonly launchOperationId?: string;
	readonly backendIdentity?: {
		readonly serverSocketPath: string;
		readonly sessionId: string;
		readonly sessionName: string;
	};
	readonly requestId?: string;
	readonly delivery?: "task" | "steer" | "follow-up";
	readonly messageHash?: string;
	readonly updatedAt: string;
}

export interface ClosedAssignmentRecord {
	readonly workerId: string;
	readonly assignmentId: string;
	readonly kind: AssignmentKind;
	readonly closedAt: string;
	readonly resultingPhase: RunPhase;
}

export interface PauseState {
	readonly previousPhase: Exclude<RunPhase, "paused" | "completed" | "cancelled">;
	readonly reason: "user" | "worker-failed" | "audit-no-progress" | "recovery";
	readonly message: string;
	readonly afterCurrentWorker: boolean;
}

export interface TicketflowRun {
	readonly version: typeof TICKETFLOW_VERSION;
	readonly revision: number;
	readonly id: string;
	readonly projectId: string;
	readonly projectPath: string;
	readonly backend: "tmux";
	readonly orchestratorSessionId: string;
	readonly phase: RunPhase;
	readonly setup: TicketflowSetup;
	readonly tickets: readonly Ticket[];
	readonly currentTicket: number;
	readonly assignment?: Assignment;
	readonly worker?: WorkerState;
	readonly report?: ReportReference;
	readonly git: GitState;
	readonly auditRounds: readonly AuditRound[];
	readonly findings: readonly AuditFinding[];
	readonly pause?: PauseState;
	readonly checkpoint?: OperationCheckpoint;
	readonly lastClosed?: ClosedAssignmentRecord;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface StoredReport {
	readonly version: typeof TICKETFLOW_VERSION;
	readonly runId: string;
	readonly assignmentId: string;
	readonly worker: WorkerIdentity;
	readonly turn: number;
	readonly report: WorkerReport;
	readonly submittedAt: string;
}

export function exactModelParts(model: string): { readonly provider: string; readonly model: string } {
	const match = /^([^/\s]+)\/(\S+)$/.exec(model);
	if (!match) throw new Error("Worker model must be an exact provider/model identifier.");
	return { provider: match[1]!, model: match[2]! };
}

export function isTerminalPhase(phase: RunPhase): boolean {
	return phase === "completed" || phase === "cancelled";
}
