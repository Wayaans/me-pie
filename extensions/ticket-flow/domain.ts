export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const RUN_PHASES = [
	"analyzing",
	"awaiting-user",
	"ready",
	"executing",
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
	| { readonly type: "frontmatter"; readonly path: string; readonly field: string; readonly value: unknown }
	| { readonly type: "rename-file"; readonly from: string; readonly to: string }
	| { readonly type: "move-file"; readonly from: string; readonly to: string };

export interface UserResolution {
	readonly id: string;
	readonly question: string;
	readonly answer: string;
	readonly resolvedAt: string;
}

/** Durable metadata written when an orchestrator accepts a worker report. */
export interface CompletionRecord {
	readonly acceptedAttempt: number;
	readonly acceptedReportPath: string;
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
	readonly operation: "accept" | "block" | "revision" | "close";
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
	readonly reportedAt: string;
	readonly resolvedAt?: string;
}

export interface WorkItem {
	readonly id: string;
	readonly title: string;
	readonly sourcePaths: readonly string[];
	readonly specificationPaths: readonly string[];
	readonly requirements: readonly string[];
	readonly order: number;
	readonly orderReason: string;
	readonly dependsOn: readonly string[];
	readonly delegationPrompt: string;
	readonly launchProfile?: Partial<PiLaunchProfile>;
	readonly completionStrategy?: CompletionStrategy;
	/** Present for accepted items; absent while the item is still in progress. */
	readonly completion?: CompletionRecord;
	readonly status: WorkItemStatus;
}

export interface WorkflowPlan {
	readonly summary: string;
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
	readonly requirements?: readonly RequirementResult[];
	readonly filesChanged?: readonly string[];
	readonly filesChangedExplanation?: string;
	readonly checks?: readonly CheckResult[];
	readonly caveats?: readonly string[];
	readonly blockers?: readonly string[];
	readonly questions?: readonly string[];
	readonly userInterventionRequired?: boolean;
}

export interface ExpectedReportContract {
	readonly schemaVersion: number;
	readonly statuses: readonly WorkerReport["status"][];
	readonly commonFields: readonly string[];
	readonly completedRequirements: readonly string[];
}

export interface AuthoritativeWorkerContext {
	readonly runId: string;
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

export interface PlanningDetails {
	readonly unresolvedQuestions: readonly string[];
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

export interface WorkflowRun {
	readonly id: string;
	readonly projectId: string;
	readonly projectPath: string;
	readonly originalPrompt: string;
	/** Pi session that most recently acquired or recovered orchestration ownership. */
	readonly orchestratorSessionId?: string;
	readonly phase: RunPhase;
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
}

export function createRunId(): string {
	return crypto.randomUUID();
}
