import { Effect, Schema } from "effect";
import type { WorkflowPlan, WorkflowRun } from "./domain.ts";
import { CorruptDataError, UnsupportedVersionError } from "./errors.ts";

export const SCHEMA_VERSION = 3 as const;

const ThinkingLevelSchema = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const RunPhaseSchema = Schema.Literals([
	"analyzing", "awaiting-user", "ready", "executing", "paused", "completed", "failed", "stopped",
]);
const WorkItemStatusSchema = Schema.Literals([
	"planned", "ready", "spawning", "verifying-worker", "running", "report-pending", "report-review",
	"report-revision", "blocked", "completed", "failed", "interrupted",
]);

export const PiLaunchProfileSchema = Schema.Struct({
	model: Schema.optionalKey(Schema.String),
	thinking: Schema.optionalKey(ThinkingLevelSchema),
});

export const CompletionStrategySchema = Schema.Union([
	Schema.Struct({ type: Schema.Literal("ledger-only") }),
	Schema.Struct({ type: Schema.Literal("append-markdown"), path: Schema.String }),
	Schema.Struct({ type: Schema.Literal("frontmatter"), path: Schema.String, field: Schema.String, value: Schema.Unknown }),
	Schema.Struct({ type: Schema.Literal("rename-file"), from: Schema.String, to: Schema.String }),
	Schema.Struct({ type: Schema.Literal("move-file"), from: Schema.String, to: Schema.String }),
]);

export const UserResolutionSchema = Schema.Struct({
	id: Schema.String,
	question: Schema.String,
	answer: Schema.String,
	resolvedAt: Schema.String,
});

export const WorkItemSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	sourcePaths: Schema.Array(Schema.String),
	specificationPaths: Schema.Array(Schema.String),
	requirements: Schema.Array(Schema.String),
	order: Schema.Number,
	orderReason: Schema.String,
	dependsOn: Schema.Array(Schema.String),
	delegationPrompt: Schema.String,
	launchProfile: Schema.optionalKey(PiLaunchProfileSchema),
	completionStrategy: Schema.optionalKey(CompletionStrategySchema),
	status: WorkItemStatusSchema,
});

export const WorkflowPlanSchema = Schema.Struct({
	summary: Schema.String,
	workItems: Schema.Array(WorkItemSchema),
	userResolutions: Schema.Array(UserResolutionSchema),
	finalized: Schema.Boolean,
});

export const RequirementResultSchema = Schema.Struct({
	requirement: Schema.String,
	result: Schema.Literals(["satisfied", "unsatisfied", "not-applicable"]),
	evidence: Schema.String,
});

export const CheckResultSchema = Schema.Struct({
	command: Schema.String,
	result: Schema.Literals(["passed", "failed", "skipped"]),
	output: Schema.optionalKey(Schema.String),
});

export const WorkerReportSchema = Schema.Struct({
	status: Schema.Literals(["progress", "completed", "blocked", "failed"]),
	summary: Schema.String,
	requirements: Schema.optionalKey(Schema.Array(RequirementResultSchema)),
	filesChanged: Schema.optionalKey(Schema.Array(Schema.String)),
	checks: Schema.optionalKey(Schema.Array(CheckResultSchema)),
	caveats: Schema.optionalKey(Schema.Array(Schema.String)),
	blockers: Schema.optionalKey(Schema.Array(Schema.String)),
	questions: Schema.optionalKey(Schema.Array(Schema.String)),
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

export const WorkerIdentitySchema = Schema.Struct({
	runId: Schema.String,
	workItemId: Schema.String,
	provider: Schema.String,
	model: Schema.String,
	thinking: ThinkingLevelSchema,
	sessionId: Schema.optionalKey(Schema.String),
	sessionFile: Schema.optionalKey(Schema.String),
});

const PlanChangeSchema = Schema.Union([
	Schema.Struct({ type: Schema.Literal("set-summary"), summary: Schema.String }),
	Schema.Struct({ type: Schema.Literal("upsert-work-item"), workItem: WorkItemSchema }),
	Schema.Struct({ type: Schema.Literal("remove-work-item"), workItemId: Schema.String }),
	Schema.Struct({ type: Schema.Literal("set-user-resolutions"), userResolutions: Schema.Array(UserResolutionSchema) }),
	Schema.Struct({ type: Schema.Literal("set-unresolved-questions"), questions: Schema.Array(Schema.String) }),
]);

const PlanningDetailsSchema = Schema.Struct({
	unresolvedQuestions: Schema.Array(Schema.String),
	changes: Schema.Array(Schema.Struct({ timestamp: Schema.String, change: PlanChangeSchema })),
	previousActiveTools: Schema.optionalKey(Schema.Array(Schema.String)),
	restrictedActiveTools: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const WorkflowRunSchema = Schema.Struct({
	id: Schema.String,
	projectId: Schema.String,
	projectPath: Schema.String,
	originalPrompt: Schema.String,
	phase: RunPhaseSchema,
	createdAt: Schema.String,
	updatedAt: Schema.String,
	plan: WorkflowPlanSchema,
	planning: PlanningDetailsSchema,
	activeWorkItemId: Schema.optionalKey(Schema.String),
	requestedLaunchProfile: Schema.optionalKey(Schema.Struct({ model: Schema.String, thinking: ThinkingLevelSchema })),
	tmux: Schema.optionalKey(TmuxWindowStateSchema),
	worker: Schema.optionalKey(WorkerIdentitySchema),
});

export const StateDocumentSchema = Schema.Struct({ version: Schema.Literal(SCHEMA_VERSION), run: WorkflowRunSchema });
export const PlanDocumentSchema = Schema.Struct({ version: Schema.Literal(SCHEMA_VERSION), plan: WorkflowPlanSchema });
export const WorkflowEventSchema = Schema.Struct({
	version: Schema.Literal(SCHEMA_VERSION),
	id: Schema.String,
	timestamp: Schema.String,
	runId: Schema.String,
	type: Schema.String,
	data: Schema.Unknown,
});

export interface StateDocument { readonly version: typeof SCHEMA_VERSION; readonly run: WorkflowRun }
export interface PlanDocument { readonly version: typeof SCHEMA_VERSION; readonly plan: WorkflowPlan }
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

function decodeVersioned<A>(
	schema: Schema.Codec<A, unknown>,
	input: unknown,
	path: string,
): Effect.Effect<A, UnsupportedVersionError | CorruptDataError> {
	const actual = versionOf(input);
	if (actual === undefined) {
		return Effect.fail(new CorruptDataError({ path, message: "missing schema version" }));
	}
	if (actual !== SCHEMA_VERSION) {
		return Effect.fail(new UnsupportedVersionError({ path, expected: SCHEMA_VERSION, actual }));
	}
	return Schema.decodeUnknownEffect(schema, { errors: "all", onExcessProperty: "error" })(input).pipe(
		Effect.mapError((cause) => new CorruptDataError({ path, message: String(cause), cause })),
	);
}

export function decodeStateDocument(input: unknown, path = "state.json") {
	return decodeVersioned(StateDocumentSchema, input, path) as Effect.Effect<StateDocument, UnsupportedVersionError | CorruptDataError>;
}

export function decodePlanDocument(input: unknown, path = "plan.json") {
	return decodeVersioned(PlanDocumentSchema, input, path) as Effect.Effect<PlanDocument, UnsupportedVersionError | CorruptDataError>;
}

export function decodeWorkflowEvent(input: unknown, path = "events.jsonl") {
	return decodeVersioned(WorkflowEventSchema, input, path) as Effect.Effect<WorkflowEvent, UnsupportedVersionError | CorruptDataError>;
}
