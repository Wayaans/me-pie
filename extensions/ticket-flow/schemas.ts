import { Effect, Schema } from "effect";
import type { WorkflowPlan, WorkflowRun } from "./domain.ts";
import { questionIdFor } from "./planning.ts";
import { CorruptDataError, UnsupportedVersionError } from "./errors.ts";

export const SCHEMA_VERSION = 4 as const;

const ThinkingLevelSchema = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const RunPhaseSchema = Schema.Literals([
	"analyzing", "awaiting-user", "ready", "executing", "auditing", "fixing", "paused", "completed", "failed", "stopped",
]);
const WorkItemStatusSchema = Schema.Literals([
	"planned", "ready", "spawning", "verifying-worker", "running", "report-pending", "report-review",
	"report-revision", "blocked", "completed", "failed", "interrupted",
]);
const WorkItemKindSchema = Schema.Literals(["implementation", "audit", "fix"]);
const AuditVerdictSchema = Schema.Struct({
	requirement: Schema.String,
	verdict: Schema.Literals(["pass", "fail", "not-applicable"]),
	evidence: Schema.String,
	fixes: Schema.optionalKey(Schema.Array(Schema.String)),
});
const AuditFindingSchema = Schema.Struct({
	id: Schema.String,
	severity: Schema.Literals(["critical", "high", "medium", "low"]),
	finding: Schema.String,
	evidence: Schema.String,
	fixLink: Schema.optionalKey(Schema.String),
	resolved: Schema.optionalKey(Schema.Boolean),
});
const AuditRoundSchema = Schema.Struct({
	round: Schema.Number,
	workerItemId: Schema.String,
	prompt: Schema.String,
	acceptedCommitIds: Schema.Array(Schema.String),
	reportPath: Schema.optionalKey(Schema.String),
	verdicts: Schema.optionalKey(Schema.Array(AuditVerdictSchema)),
	findings: Schema.optionalKey(Schema.Array(AuditFindingSchema)),
	fixWorkItemId: Schema.optionalKey(Schema.String),
	status: Schema.Literals(["pending", "findings", "clean"]),
	createdAt: Schema.String,
	completedAt: Schema.optionalKey(Schema.String),
});

export const PiLaunchProfileSchema = Schema.Struct({
	model: Schema.optionalKey(Schema.String),
	thinking: Schema.optionalKey(ThinkingLevelSchema),
});

export const CompletionStrategySchema = Schema.Union([
	Schema.Struct({ type: Schema.Literal("ledger-only") }),
	Schema.Struct({ type: Schema.Literal("append-markdown"), path: Schema.String }),
	Schema.Struct({ type: Schema.Literal("append"), path: Schema.String }),
	Schema.Struct({ type: Schema.Literal("text-replacement"), path: Schema.String, oldText: Schema.String, newText: Schema.String }),
	Schema.Struct({ type: Schema.Literal("markdown-checkbox"), path: Schema.String, text: Schema.String, checked: Schema.optionalKey(Schema.Boolean) }),
	Schema.Struct({ type: Schema.Literal("frontmatter"), path: Schema.String, field: Schema.String, value: Schema.Unknown }),
	Schema.Struct({ type: Schema.Literal("rename-file"), from: Schema.String, to: Schema.String }),
	Schema.Struct({ type: Schema.Literal("move-file"), from: Schema.String, to: Schema.String }),
]);

export const WorkerIdentitySchema = Schema.Struct({
	runId: Schema.String,
	workItemId: Schema.String,
	provider: Schema.String,
	model: Schema.String,
	thinking: ThinkingLevelSchema,
	sessionId: Schema.optionalKey(Schema.String),
	sessionFile: Schema.optionalKey(Schema.String),
});

export const CompletionRecordSchema = Schema.Struct({
	acceptedAttempt: Schema.Number,
	acceptedReportPath: Schema.String,
	commitIds: Schema.optionalKey(Schema.Array(Schema.String)),
	comment: Schema.String,
	completedAt: Schema.String,
	strategy: CompletionStrategySchema,
	worker: Schema.optionalKey(WorkerIdentitySchema),
	requestedLaunchProfile: Schema.optionalKey(Schema.Struct({ model: Schema.String, thinking: ThinkingLevelSchema })),
});

export const UserResolutionSchema = Schema.Struct({
	id: Schema.String,
	question: Schema.String,
	answer: Schema.String,
	resolvedAt: Schema.String,
});

export const WorkItemSchema = Schema.Struct({
	id: Schema.String,
	kind: Schema.optionalKey(WorkItemKindSchema),
	title: Schema.String,
	sourcePaths: Schema.Array(Schema.String),
	specificationPaths: Schema.Array(Schema.String),
	requirements: Schema.Array(Schema.String),
	order: Schema.Number,
	orderReason: Schema.String,
	dependsOn: Schema.Array(Schema.String),
	delegationPrompt: Schema.String,
	launchProfile: Schema.optionalKey(PiLaunchProfileSchema),
	readOnly: Schema.optionalKey(Schema.Boolean),
	completionStrategy: Schema.optionalKey(CompletionStrategySchema),
	completionTargets: Schema.optionalKey(Schema.Array(Schema.String)),
	auditFindingIds: Schema.optionalKey(Schema.Array(Schema.String)),
	completion: Schema.optionalKey(CompletionRecordSchema),
	status: WorkItemStatusSchema,
});

export const WorkflowPlanSchema = Schema.Struct({
	summary: Schema.String,
	auditProfile: Schema.optionalKey(Schema.Struct({ model: Schema.String, thinking: ThinkingLevelSchema })),
	workItems: Schema.Array(WorkItemSchema),
	userResolutions: Schema.Array(UserResolutionSchema),
	finalized: Schema.Boolean,
});

export const RequirementResultSchema = Schema.Struct({
	requirementId: Schema.optionalKey(Schema.String),
	requirement: Schema.optionalKey(Schema.String),
	result: Schema.Literals(["satisfied", "not-satisfied", "not-applicable"]),
	evidence: Schema.String,
});

export const CheckResultSchema = Schema.Struct({
	command: Schema.String,
	result: Schema.Literals(["passed", "failed", "not-run"]),
	output: Schema.optionalKey(Schema.String),
	reason: Schema.optionalKey(Schema.String),
});

export const WorkerReportSchema = Schema.Struct({
	status: Schema.Literals(["progress", "completed", "blocked", "failed"]),
	summary: Schema.String,
	commitIds: Schema.optionalKey(Schema.Array(Schema.String)),
	auditVerdicts: Schema.optionalKey(Schema.Array(AuditVerdictSchema)),
	auditFindings: Schema.optionalKey(Schema.Array(AuditFindingSchema)),
	requirements: Schema.optionalKey(Schema.Array(RequirementResultSchema)),
	filesChanged: Schema.optionalKey(Schema.Array(Schema.String)),
	filesChangedExplanation: Schema.optionalKey(Schema.String),
	checks: Schema.optionalKey(Schema.Array(CheckResultSchema)),
	caveats: Schema.optionalKey(Schema.Array(Schema.String)),
	blockers: Schema.optionalKey(Schema.Array(Schema.String)),
	questions: Schema.optionalKey(Schema.Array(Schema.String)),
	userInterventionRequired: Schema.optionalKey(Schema.Boolean),
});

export const TmuxWindowStateSchema = Schema.Struct({
	runId: Schema.String,
	workItemId: Schema.String,
	serverSocketPath: Schema.String,
	sessionId: Schema.String,
	sessionName: Schema.String,
	windowId: Schema.String,
	paneId: Schema.String,
	displayName: Schema.String,
	socketPath: Schema.String,
});

const PlanChangeSchema = Schema.Union([
	Schema.Struct({ type: Schema.Literal("set-summary"), summary: Schema.String }),
	Schema.Struct({ type: Schema.Literal("upsert-work-item"), workItem: WorkItemSchema }),
	Schema.Struct({ type: Schema.Literal("remove-work-item"), workItemId: Schema.String }),
	Schema.Struct({ type: Schema.Literal("set-user-resolutions"), userResolutions: Schema.Array(UserResolutionSchema) }),
	Schema.Struct({ type: Schema.Literal("set-unresolved-questions"), questions: Schema.Array(Schema.String) }),
]);

const ProgressionCheckpointSchema = Schema.Struct({
	operation: Schema.Literals(["delegate", "accept", "block", "revision", "close"]),
	stage: Schema.String,
	workItemId: Schema.String,
	updatedAt: Schema.String,
	reportAttempt: Schema.optionalKey(Schema.Number),
	comment: Schema.optionalKey(Schema.String),
	completion: Schema.optionalKey(CompletionRecordSchema),
});

const WorkflowBlockerSchema = Schema.Struct({
	workItemId: Schema.String,
	message: Schema.String,
	questions: Schema.Array(Schema.String),
	userInterventionRequired: Schema.optionalKey(Schema.Boolean),
	reportedAt: Schema.String,
	resolvedAt: Schema.optionalKey(Schema.String),
});

const PlanningQuestionSchema = Schema.Struct({
	id: Schema.String,
	question: Schema.String,
	askedAt: Schema.String,
});

const PlanningDetailsSchema = Schema.Struct({
	unresolvedQuestions: Schema.Array(Schema.String),
	questionLedger: Schema.optionalKey(Schema.Array(PlanningQuestionSchema)),
	changes: Schema.Array(Schema.Struct({ timestamp: Schema.String, change: PlanChangeSchema })),
	previousActiveTools: Schema.optionalKey(Schema.Array(Schema.String)),
	restrictedActiveTools: Schema.optionalKey(Schema.Array(Schema.String)),
});
const GitRunStateSchema = Schema.Struct({
	repository: Schema.String,
	baselineCommit: Schema.String,
	baselineBranch: Schema.String,
	workflowBranch: Schema.String,
	acceptedCommitIds: Schema.Array(Schema.String),
	attemptBaseCommit: Schema.optionalKey(Schema.String),
	currentHead: Schema.optionalKey(Schema.String),
	cleanPreflight: Schema.Boolean,
});
const AuditRunStateSchema = Schema.Struct({
	featureName: Schema.String,
	ticketPath: Schema.String,
	specPath: Schema.String,
	template: Schema.String,
	model: Schema.String,
	thinking: ThinkingLevelSchema,
	rounds: Schema.Array(AuditRoundSchema),
	activeRound: Schema.optionalKey(Schema.Number),
	noProgress: Schema.optionalKey(Schema.Struct({
		findingId: Schema.String,
		occurrences: Schema.Number,
		evidenceHash: Schema.String,
	})),
});

export const WorkflowRunSchema = Schema.Struct({
	id: Schema.String,
	projectId: Schema.String,
	projectPath: Schema.String,
	originalPrompt: Schema.String,
	orchestratorSessionId: Schema.optionalKey(Schema.String),
	phase: RunPhaseSchema,
	pauseReason: Schema.optionalKey(Schema.Literals(["user", "blocker", "recovery"])),
	recoveryIssue: Schema.optionalKey(Schema.Struct({ kind: Schema.String, message: Schema.String })),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	plan: WorkflowPlanSchema,
	planning: PlanningDetailsSchema,
	activeWorkItemId: Schema.optionalKey(Schema.String),
	requestedLaunchProfile: Schema.optionalKey(Schema.Struct({ model: Schema.String, thinking: ThinkingLevelSchema })),
	workflowSocketPath: Schema.optionalKey(Schema.String),
	protocolCommands: Schema.optionalKey(Schema.Array(Schema.Struct({
		type: Schema.Literals(["delegate", "feedback", "shutdown"]),
		requestId: Schema.String,
		messageId: Schema.String,
		acknowledged: Schema.Boolean,
	}))),
	tmux: Schema.optionalKey(TmuxWindowStateSchema),
	worker: Schema.optionalKey(WorkerIdentitySchema),
	progression: Schema.optionalKey(ProgressionCheckpointSchema),
	blockers: Schema.optionalKey(Schema.Array(WorkflowBlockerSchema)),
	git: Schema.optionalKey(GitRunStateSchema),
	audit: Schema.optionalKey(AuditRunStateSchema),
	reportReferences: Schema.optionalKey(Schema.Array(Schema.Struct({
		workItemId: Schema.String,
		attempt: Schema.Number,
		path: Schema.String,
		submittedAt: Schema.String,
	}))),
	finalSummary: Schema.optionalKey(Schema.String),
});

export const StateDocumentSchema = Schema.Struct({ version: Schema.Literal(SCHEMA_VERSION), run: WorkflowRunSchema });
/** plan.json is the single authoritative run snapshot; state.json is legacy input only. */
export const PlanDocumentSchema = Schema.Struct({ version: Schema.Literal(SCHEMA_VERSION), run: WorkflowRunSchema });
export const WorkflowEventSchema = Schema.Struct({
	version: Schema.Literal(SCHEMA_VERSION),
	id: Schema.String,
	timestamp: Schema.String,
	runId: Schema.String,
	type: Schema.String,
	data: Schema.Unknown,
});

export interface StateDocument { readonly version: typeof SCHEMA_VERSION; readonly run: WorkflowRun }
export interface PlanDocument { readonly version: typeof SCHEMA_VERSION; readonly run: WorkflowRun }
export interface WorkflowEvent {
	readonly version: typeof SCHEMA_VERSION;
	readonly id: string;
	readonly timestamp: string;
	readonly runId: string;
	readonly type: string;
	readonly data: unknown;
}

function versionOf(input: unknown): unknown {
	return typeof input === "object" && input !== null && "version" in input
		? (input as { readonly version: unknown }).version
		: undefined;
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} is not an object`);
	return value as Record<string, unknown>;
}

/** Safe v3 -> v4 migration. New audit/git fields are intentionally absent. */
function migrateV3State(input: unknown): unknown {
	const document = record(input, "v3 state document");
	const sourceRun = record(document.run, "v3 state run");
	const sourcePlan = record(sourceRun.plan, "v3 state plan");
	const sourcePlanning = record(sourceRun.planning, "v3 planning details");
	const unresolved = Array.isArray(sourcePlanning.unresolvedQuestions) ? sourcePlanning.unresolvedQuestions.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [];
	const sourceResolutions = Array.isArray(sourcePlan.userResolutions) ? sourcePlan.userResolutions : [];
	const resolutionQuestions = sourceResolutions.flatMap((resolution) => {
		if (resolution !== null && typeof resolution === "object" && typeof (resolution as { readonly question?: unknown }).question === "string") return [(resolution as { readonly question: string }).question];
		return [];
	});
	const questionLedger = [...new Set([...unresolved, ...resolutionQuestions].map((question) => question.trim()).filter(Boolean))].map((question) => ({ id: questionIdFor(question), question, askedAt: String(sourceRun.updatedAt ?? sourceRun.createdAt ?? new Date(0).toISOString()) }));
	const hadFinalizedWithoutAuditProfile = sourcePlan.finalized === true && sourcePlan.auditProfile === undefined;
	const migratedPlan = {
		...sourcePlan,
		...(hadFinalizedWithoutAuditProfile ? { finalized: false } : {}),
	};
	const migratedRun = {
		...sourceRun,
		plan: migratedPlan,
		planning: { ...sourcePlanning, unresolvedQuestions: unresolved, questionLedger },
		...(Array.isArray(sourceRun.blockers) ? { blockers: sourceRun.blockers.map((blocker) => ({ ...record(blocker, "v3 blocker"), userInterventionRequired: false })) } : {}),
		...(hadFinalizedWithoutAuditProfile ? {
			phase: "paused",
			pauseReason: "recovery",
			recoveryIssue: { kind: "audit-profile-required", message: "This v3 run was finalized without an explicit audit profile. It was migrated to an editable paused draft; set plan.auditProfile before finalizing." },
		} : {}),
	};
	return { version: SCHEMA_VERSION, run: migratedRun };
}

function migrateV3Event(input: unknown): unknown {
	const event = record(input, "v3 workflow event");
	return { ...event, version: SCHEMA_VERSION };
}

function decodeVersioned<A>(
	schema: Schema.Codec<A, unknown>,
	input: unknown,
	path: string,
	migrate?: (input: unknown) => unknown,
): Effect.Effect<A, UnsupportedVersionError | CorruptDataError> {
	const actual = versionOf(input);
	if (actual === undefined) {
		return Effect.fail(new CorruptDataError({ path, message: "missing schema version" }));
	}
	let migrated = input;
	if (actual === 3 && migrate !== undefined) {
		try { migrated = migrate(input); } catch (cause) { return Effect.fail(new CorruptDataError({ path, message: `schema v3 migration failed: ${String(cause)}`, cause })); }
	} else if (actual !== SCHEMA_VERSION) {
		return Effect.fail(new UnsupportedVersionError({ path, expected: SCHEMA_VERSION, actual }));
	}
	return Schema.decodeUnknownEffect(schema, { errors: "all", onExcessProperty: "error" })(migrated).pipe(
		Effect.mapError((cause) => new CorruptDataError({ path, message: String(cause), cause })),
	);
}

export function decodeStateDocument(input: unknown, path = "state.json") {
	return decodeVersioned(StateDocumentSchema, input, path, migrateV3State) as Effect.Effect<StateDocument, UnsupportedVersionError | CorruptDataError>;
}

export function decodePlanDocument(input: unknown, path = "plan.json") {
	return decodeVersioned(PlanDocumentSchema, input, path) as Effect.Effect<PlanDocument, UnsupportedVersionError | CorruptDataError>;
}

export function decodeWorkflowEvent(input: unknown, path = "events.jsonl") {
	return decodeVersioned(WorkflowEventSchema, input, path, migrateV3Event) as Effect.Effect<WorkflowEvent, UnsupportedVersionError | CorruptDataError>;
}
