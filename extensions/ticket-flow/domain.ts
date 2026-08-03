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

export interface RequirementResult {
	readonly requirement: string;
	readonly result: "satisfied" | "unsatisfied" | "not-applicable";
	readonly evidence: string;
}

export interface CheckResult {
	readonly command: string;
	readonly result: "passed" | "failed" | "skipped";
	readonly output?: string;
}

export interface WorkerReport {
	readonly status: "progress" | "completed" | "blocked" | "failed";
	readonly summary: string;
	readonly requirements?: readonly RequirementResult[];
	readonly filesChanged?: readonly string[];
	readonly checks?: readonly CheckResult[];
	readonly caveats?: readonly string[];
	readonly blockers?: readonly string[];
	readonly questions?: readonly string[];
}

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

export interface WorkflowRun {
	readonly id: string;
	readonly projectId: string;
	readonly projectPath: string;
	readonly originalPrompt: string;
	readonly phase: RunPhase;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly plan: WorkflowPlan;
	readonly planning: PlanningDetails;
	readonly activeWorkItemId?: string;
	readonly worker?: WorkerIdentity;
}

export function createRunId(): string {
	return crypto.randomUUID();
}
