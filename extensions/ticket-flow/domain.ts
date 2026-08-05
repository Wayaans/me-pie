export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const RUN_PHASES = [
	"analyzing",
	"awaiting-user",
	"ready",
	"executing",
	"auditing",
	"fixing",
	"paused",
	"completed",
	"failed",
	"stopped",
] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

export const WORK_ITEM_STATUSES = [
	"planned",
	"ready",
	"spawning",
	"verifying-worker",
	"running",
	"report-pending",
	"report-review",
	"report-revision",
	"blocked",
	"completed",
	"failed",
	"interrupted",
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export interface PiLaunchProfile {
	readonly model: string;
	readonly thinking: ThinkingLevel;
}

export type CompletionStrategy =
	| { readonly type: "ledger-only" }
	| { readonly type: "append-markdown"; readonly path: string }
	/** Public shorthand for append-markdown. */
	| { readonly type: "append"; readonly path: string }
	| { readonly type: "text-replacement"; readonly path: string; readonly oldText: string; readonly newText: string }
	| { readonly type: "markdown-checkbox"; readonly path: string; readonly text: string; readonly checked?: boolean }
	| { readonly type: "frontmatter"; readonly path: string; readonly field: string; readonly value: unknown }
	| { readonly type: "rename-file"; readonly from: string; readonly to: string }
	| { readonly type: "move-file"; readonly from: string; readonly to: string };

export interface UserResolution {
	/** Stable question identifier. Older state may omit this and is linked by question text. */
	readonly id: string;
	readonly question: string;
	readonly answer: string;
	readonly resolvedAt: string;
}

/** Durable metadata written when an orchestrator accepts a worker report. */
export interface CompletionRecord {
	readonly acceptedAttempt: number;
	readonly acceptedReportPath: string;
	/** Exact commit refs accepted with this report attempt. */
	readonly commitIds?: readonly string[];
	readonly comment: string;
	readonly completedAt: string;
	readonly strategy: CompletionStrategy;
	readonly worker?: WorkerIdentity;
	readonly requestedLaunchProfile?: PiLaunchProfile;
}

/**
 * A durable boundary around progression side effects. Reports and terminal
 * captures stay in their own files and are not copied into the run snapshot.
 */
export interface ProgressionCheckpoint {
	readonly operation: "delegate" | "accept" | "block" | "revision" | "close";
	readonly stage: string;
	readonly workItemId: string;
	readonly updatedAt: string;
	readonly reportAttempt?: number;
	readonly comment?: string;
	readonly completion?: CompletionRecord;
}

export interface WorkflowBlocker {
	readonly workItemId: string;
	readonly message: string;
	readonly questions: readonly string[];
	/** Whether the worker explicitly said that a user decision is required. */
	readonly userInterventionRequired?: boolean;
	readonly reportedAt: string;
	readonly resolvedAt?: string;
}

export interface WorkItem {
	readonly id: string;
	/** Implementation items are planned by the user; audit/fix items are generated durably by Ticket Flow. */
	readonly kind?: "implementation" | "audit" | "fix";
	readonly title: string;
	readonly sourcePaths: readonly string[];
	readonly specificationPaths: readonly string[];
	readonly requirements: readonly string[];
	readonly order: number;
	readonly orderReason: string;
	readonly dependsOn: readonly string[];
	readonly delegationPrompt: string;
	readonly launchProfile?: Partial<PiLaunchProfile>;
	/** Audit workers are read-only and must not receive write tools. */
	readonly readOnly?: boolean;
	readonly completionStrategy?: CompletionStrategy;
	/** Additional plan-approved paths that a completion mutation may touch. */
	readonly completionTargets?: readonly string[];
	/** Finding IDs this generated fix item is responsible for resolving. */
	readonly auditFindingIds?: readonly string[];
	/** Present for accepted items; absent while the item is still in progress. */
	readonly completion?: CompletionRecord;
	readonly status: WorkItemStatus;
}

export interface WorkflowPlan {
	readonly summary: string;
	/** Explicit read-only audit profile persisted with the plan; never inferred. */
	readonly auditProfile?: PiLaunchProfile;
	readonly workItems: readonly WorkItem[];
	readonly userResolutions: readonly UserResolution[];
	readonly finalized: boolean;
}

export interface WorkerIdentity {
	readonly runId: string;
	readonly workItemId: string;
	readonly provider: string;
	readonly model: string;
	readonly thinking: ThinkingLevel;
	readonly sessionId?: string;
	readonly sessionFile?: string;
}

export interface PlannedRequirement {
	readonly id: string;
	readonly requirement: string;
}

export interface RequirementResult {
	readonly requirementId?: string;
	readonly requirement?: string;
	readonly result: "satisfied" | "not-satisfied" | "not-applicable";
	readonly evidence: string;
}

export interface CheckResult {
	readonly command: string;
	readonly result: "passed" | "failed" | "not-run";
	readonly output?: string;
	readonly reason?: string;
}

export interface WorkerReport {
	readonly status: "progress" | "completed" | "blocked" | "failed";
	readonly summary: string;
	/** Commit IDs made for this item. Reports may never claim uncommitted work was audited. */
	readonly commitIds?: readonly string[];
	/** Requirement verdicts are mandatory for audit reports and persisted as immutable evidence. */
	readonly auditVerdicts?: readonly AuditRequirementVerdict[];
	readonly auditFindings?: readonly AuditFinding[];
	readonly requirements?: readonly RequirementResult[];
	readonly filesChanged?: readonly string[];
	readonly filesChangedExplanation?: string;
	readonly checks?: readonly CheckResult[];
	readonly caveats?: readonly string[];
	readonly blockers?: readonly string[];
	readonly questions?: readonly string[];
	readonly userInterventionRequired?: boolean;
}

export interface AuditRequirementVerdict {
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
	readonly fixLink?: string;
	readonly resolved?: boolean;
}

export interface AuditRound {
	readonly round: number;
	readonly workerItemId: string;
	readonly prompt: string;
	readonly acceptedCommitIds: readonly string[];
	readonly reportPath?: string;
	readonly verdicts?: readonly AuditRequirementVerdict[];
	readonly findings?: readonly AuditFinding[];
	/** Durable link from a finding round to the fix worker created for it. */
	readonly fixWorkItemId?: string;
	readonly status: "pending" | "findings" | "clean";
	readonly createdAt: string;
	readonly completedAt?: string;
}

export interface GitRunState {
	readonly repository: string;
	readonly baselineCommit: string;
	readonly baselineBranch: string;
	readonly workflowBranch: string;
	readonly acceptedCommitIds: readonly string[];
	/** HEAD captured when the active implementation/fix attempt was launched. */
	readonly attemptBaseCommit?: string;
	readonly currentHead?: string;
	readonly cleanPreflight: boolean;
}

export interface AuditRunState {
	readonly featureName: string;
	readonly ticketPath: string;
	readonly specPath: string;
	readonly template: string;
	readonly model: string;
	readonly thinking: ThinkingLevel;
	readonly rounds: readonly AuditRound[];
	readonly activeRound?: number;
	readonly noProgress?: {
		readonly findingId: string;
		readonly occurrences: number;
		readonly evidenceHash: string;
	};
}

export interface ExpectedReportContract {
	readonly schemaVersion: number;
	readonly statuses: readonly WorkerReport["status"][];
	readonly commonFields: readonly string[];
	readonly completedRequirements: readonly string[];
}

export interface AuthoritativeWorkerContext {
	readonly runId: string;
	readonly workItemKind?: "implementation" | "audit" | "fix";
	readonly readOnly?: boolean;
	readonly workItemId: string;
	readonly workItemTitle: string;
	readonly sourcePaths: readonly string[];
	readonly specificationPaths: readonly string[];
	readonly requirements: readonly PlannedRequirement[];
	readonly userResolutions: readonly UserResolution[];
	readonly delegationPrompt: string;
	readonly requestedLaunchProfile: PiLaunchProfile;
	readonly actualLaunchProfile: PiLaunchProfile & { readonly provider: string };
	readonly expectedReport: ExpectedReportContract;
	readonly truncated: boolean;
}

export type WorkerFeedback =
	| { readonly type: "accepted" }
	| { readonly type: "feedback"; readonly kind: "message" | "revision" | "user-answer"; readonly message: string; readonly missingRequirements?: readonly string[]; readonly questions?: readonly string[] }
	| { readonly type: "shutdown" };

export type PlanChange =
	| { readonly type: "set-summary"; readonly summary: string }
	| { readonly type: "upsert-work-item"; readonly workItem: WorkItem }
	| { readonly type: "remove-work-item"; readonly workItemId: string }
	| { readonly type: "set-user-resolutions"; readonly userResolutions: readonly UserResolution[] }
	| { readonly type: "set-unresolved-questions"; readonly questions: readonly string[] };

export interface PlanChangeRecord {
	readonly timestamp: string;
	readonly change: PlanChange;
}

export interface PlanningQuestion {
	readonly id: string;
	readonly question: string;
	readonly askedAt: string;
}

export interface PlanningDetails {
	readonly unresolvedQuestions: readonly string[];
	/** Append-only question ledger; unresolvedQuestions is a derived blocking view. */
	readonly questionLedger?: readonly PlanningQuestion[];
	readonly changes: readonly PlanChangeRecord[];
	readonly previousActiveTools?: readonly string[];
	readonly restrictedActiveTools?: readonly string[];
}

export interface ProtocolCommandState {
	readonly type: "delegate" | "feedback" | "shutdown";
	readonly requestId: string;
	readonly messageId: string;
	readonly acknowledged: boolean;
}

export interface TmuxWindowState {
	readonly runId: string;
	readonly workItemId: string;
	readonly serverSocketPath: string;
	readonly sessionId: string;
	readonly sessionName: string;
	readonly windowId: string;
	readonly paneId: string;
	readonly displayName: string;
	readonly socketPath: string;
}

export interface RecoveryIssue {
	readonly kind: string;
	readonly message: string;
}

export interface WorkflowRun {
	readonly id: string;
	readonly projectId: string;
	readonly projectPath: string;
	readonly originalPrompt: string;
	/** Pi session that most recently acquired or recovered orchestration ownership. */
	readonly orchestratorSessionId?: string;
	/** Explicit read-only audit profile. It is never inferred from implementation workers. */
	readonly auditProfile?: PiLaunchProfile;
	readonly phase: RunPhase;
	readonly pauseReason?: "user" | "blocker" | "recovery";
	readonly recoveryIssue?: RecoveryIssue;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly plan: WorkflowPlan;
	readonly planning: PlanningDetails;
	readonly activeWorkItemId?: string;
	readonly requestedLaunchProfile?: PiLaunchProfile;
	/** Intended native protocol path; never a project-local path. */
	readonly workflowSocketPath?: string;
	/** Safe delivery IDs only; prompts and connection tokens are never persisted here. */
	readonly protocolCommands?: readonly ProtocolCommandState[];
	readonly tmux?: TmuxWindowState;
	readonly worker?: WorkerIdentity;
	/** Last durable progression boundary, used to make external steps recoverable. */
	readonly progression?: ProgressionCheckpoint;
	readonly blockers?: readonly WorkflowBlocker[];
	/** Canonical durable runtime data lives in plan.json, including git and audit state. */
	readonly git?: GitRunState;
	readonly audit?: AuditRunState;
	readonly reportReferences?: readonly {
		readonly workItemId: string;
		readonly attempt: number;
		readonly path: string;
		readonly submittedAt: string;
	}[];
	/** Bounded, durable references used to render the final audit summary. */
	readonly finalSummary?: string;
}

export function createRunId(): string {
	return crypto.randomUUID();
}
