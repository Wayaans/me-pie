import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { environmentError } from "./errors.ts";
import {
	CODING_AGENTS,
	TARGET_KINDS,
	THINKING_LEVELS,
	WORKSPACE_ACTIONS,
	type WorkspaceRequest,
} from "./model.ts";

const StrictObject = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

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
	description: "Recipient tmux target whose inbox should be observed. Use the current pane ID to wait for worker reports.",
});
const CloseTargetId = Type.String({
	minLength: 2,
	maxLength: 64,
	pattern: "^[%@][0-9]+$",
	description: "Native tmux pane (%pane) or window (@window) ID.",
});
const Cwd = Type.String({ minLength: 1, maxLength: 4_096 });

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

export const SendParametersSchema = StrictObject({
	targetId: TargetId,
	input: StringEnum(["prompt", "command"] as const),
	text: Type.String({ minLength: 1, maxLength: 48 * 1_024 }),
	submit: Type.Optional(Type.Boolean({ default: true })),
});

export const WaitParametersSchema = StrictObject({
	targetId: WaitTargetId,
	afterSequence: Type.Optional(Type.Integer({
		minimum: 0,
		description: "Ignore inbox signals through this sequence. Use replyAfterSequence returned by the task send.",
	})),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 * 60_000, default: 120_000 })),
});

export const CloseParametersSchema = StrictObject({
	targetId: CloseTargetId,
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
		case "send": return { action: "send", request: params.send! };
		case "wait": return { action: "wait", request: params.wait! };
		case "close": return { action: "close", request: params.close! };
	}
}
