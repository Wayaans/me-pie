import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { MANAGED_TEXT_MAX_BYTES } from "./coordination.ts";
import { environmentError } from "./errors.ts";
import {
	CODING_AGENTS,
	TARGET_KINDS,
	THINKING_LEVELS,
	WORKSPACE_ACTIONS,
	WORK_OUTCOMES,
	type WorkspaceRequest,
} from "./model.ts";

const StrictObject = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

const Uuid = Type.String({
	minLength: 36,
	maxLength: 36,
	pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
	description: "Authoritative Agent Run or Work Cycle correlation UUID.",
});
const TargetId = Type.String({
	minLength: 2,
	maxLength: 64,
	pattern: "^[%@$][0-9]+$",
	description: "Native tmux target ID: $session, @window, or %pane.",
});
const WaitTargetId = Type.String({
	minLength: 2,
	maxLength: 64,
	pattern: "^[%@$][0-9]+$",
	description: "Recipient tmux target whose inbox should be observed by raw wait.",
});
const CloseTargetId = Type.String({
	minLength: 2,
	maxLength: 64,
	pattern: "^[%@][0-9]+$",
	description: "Native tmux pane (%pane) or window (@window) ID.",
});
const Cwd = Type.String({ minLength: 1, maxLength: 4_096 });
const RawText = Type.String({ minLength: 1, maxLength: 48 * 1_024 });

export const SpawnParametersSchema = StrictObject({
	kind: Type.Optional(StringEnum(TARGET_KINDS, { default: "window", description: "Target kind. Defaults to window." })),
	targetId: Type.Optional(TargetId),
	cwd: Type.Optional(Cwd),
	title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	direction: Type.Optional(StringEnum(["right", "down"] as const, { default: "right" })),
	focus: Type.Optional(Type.Boolean({ default: false })),
});

export const RunParametersSchema = StrictObject({
	targetId: Type.Optional(TargetId),
	agent: Type.Optional(StringEnum(CODING_AGENTS, { default: "pi" })),
	model: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
	thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
	cwd: Type.Optional(Cwd),
	replace: Type.Optional(Type.Boolean({ default: false })),
});

/**
 * Keep one Google-compatible object schema per action. Normalization below
 * enforces the strict raw/task/result variants and rejects mixed fields.
 */
export const SendParametersSchema = StrictObject({
	targetId: Type.Optional(TargetId),
	runId: Type.Optional(Uuid),
	kind: Type.Optional(StringEnum(["task", "result"] as const)),
	input: Type.Optional(StringEnum(["prompt", "command"] as const)),
	outcome: Type.Optional(StringEnum(WORK_OUTCOMES)),
	text: RawText,
	submit: Type.Optional(Type.Boolean({ default: true })),
});

export const WaitParametersSchema = StrictObject({
	targetId: Type.Optional(WaitTargetId),
	runId: Type.Optional(Uuid),
	workId: Type.Optional(Uuid),
	afterSequence: Type.Optional(Type.Integer({
		minimum: 0,
		description: "Raw inbox baseline. Managed waits correlate by runId/workId.",
	})),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 * 60_000, default: 120_000 })),
});

export const CloseParametersSchema = StrictObject({
	targetId: Type.Optional(CloseTargetId),
	runId: Type.Optional(Uuid),
});

export const WorkspaceParametersSchema = StrictObject({
	action: StringEnum(WORKSPACE_ACTIONS),
	spawn: Type.Optional(SpawnParametersSchema),
	run: Type.Optional(RunParametersSchema),
	send: Type.Optional(SendParametersSchema),
	wait: Type.Optional(WaitParametersSchema),
	close: Type.Optional(CloseParametersSchema),
});

export type WorkspaceParameters = Static<typeof WorkspaceParametersSchema>;

const payloadSchemas = {
	spawn: SpawnParametersSchema,
	run: RunParametersSchema,
	send: SendParametersSchema,
	wait: WaitParametersSchema,
	close: CloseParametersSchema,
} as const;

export function normalizeWorkspaceParameters(params: WorkspaceParameters): WorkspaceRequest {
	const supplied = WORKSPACE_ACTIONS.filter((action) => params[action] !== undefined);
	if (supplied.length !== 1 || supplied[0] !== params.action) {
		throw environmentError("validate workspace request", `action=${params.action} requires exactly one matching ${params.action} payload.`);
	}
	const payload = params[params.action];
	if (!Value.Check(payloadSchemas[params.action], payload)) {
		throw environmentError("validate workspace request", `${params.action} payload is invalid.`);
	}
	switch (params.action) {
		case "spawn": return { action: "spawn", request: params.spawn! };
		case "run": return { action: "run", request: params.run! };
		case "send": return normalizeSend(params.send!);
		case "wait": return normalizeWait(params.wait!);
		case "close": return normalizeClose(params.close!);
	}
}

function normalizeSend(payload: NonNullable<WorkspaceParameters["send"]>): WorkspaceRequest {
	if (payload.kind === "task") {
		if (payload.runId === undefined || payload.targetId !== undefined || payload.input === undefined
			|| payload.outcome !== undefined || payload.submit === false || payload.text.trim().length === 0
			|| Buffer.byteLength(payload.text, "utf8") > MANAGED_TEXT_MAX_BYTES) return invalid("send payload is invalid.");
		return {
			action: "send",
			request: {
				kind: "task",
				runId: payload.runId,
				input: payload.input,
				text: payload.text,
				...(payload.submit === undefined ? {} : { submit: payload.submit }),
			},
		};
	}
	if (payload.kind === "result") {
		if (payload.targetId !== undefined || payload.runId !== undefined || payload.input !== undefined
			|| payload.submit !== undefined || payload.outcome === undefined || payload.text.trim().length === 0
			|| Buffer.byteLength(payload.text, "utf8") > MANAGED_TEXT_MAX_BYTES) return invalid("send payload is invalid.");
		return { action: "send", request: { kind: "result", outcome: payload.outcome, text: payload.text } };
	}
	if (payload.targetId === undefined || payload.input === undefined || payload.runId !== undefined || payload.outcome !== undefined) {
		return invalid("send payload is invalid.");
	}
	return {
		action: "send",
		request: {
			targetId: payload.targetId,
			input: payload.input,
			text: payload.text,
			...(payload.submit === undefined ? {} : { submit: payload.submit }),
		},
	};
}

function normalizeWait(payload: NonNullable<WorkspaceParameters["wait"]>): WorkspaceRequest {
	if (payload.runId !== undefined) {
		if (payload.targetId !== undefined || payload.afterSequence !== undefined) return invalid("wait payload is invalid.");
		return {
			action: "wait",
			request: {
				runId: payload.runId,
				...(payload.workId === undefined ? {} : { workId: payload.workId }),
				...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs }),
			},
		};
	}
	if (payload.targetId === undefined || payload.workId !== undefined) return invalid("wait payload is invalid.");
	return {
		action: "wait",
		request: {
			targetId: payload.targetId,
			...(payload.afterSequence === undefined ? {} : { afterSequence: payload.afterSequence }),
			...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs }),
		},
	};
}

function normalizeClose(payload: NonNullable<WorkspaceParameters["close"]>): WorkspaceRequest {
	if ((payload.targetId === undefined) === (payload.runId === undefined)) return invalid("close payload is invalid.");
	return payload.runId === undefined
		? { action: "close", request: { targetId: payload.targetId! } }
		: { action: "close", request: { runId: payload.runId } };
}

function invalid(message: string): never {
	throw environmentError("validate workspace request", message);
}
