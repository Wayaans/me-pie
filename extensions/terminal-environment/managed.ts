import { MANAGED_TEXT_MAX_BYTES, hashLaunchToken, isLaunchToken, isUuid, type ManagedWorkRecord, type ManagedWorkState } from "./coordination.ts";
import type {
	AgentModelMetadata,
	CodingAgent,
	RunReadiness,
	TargetIdentity,
	TerminalTarget,
	ThinkingLevel,
} from "./model.ts";

export const MANAGED_CONTEXT_ENV = "MEPIE_WORKSPACE_LAUNCH_CONTEXT";
export const MANAGED_SNAPSHOT_TYPE = "mepie-terminal-environment-workspace";
const MAX_CONTEXT_BYTES = 8 * 1_024;
const MAX_SNAPSHOT_BYTES = 16 * 1_024;
const MANAGED_INPUT_PREFIX = "mepie-work-v1:";
const MAX_MANAGED_INPUT_BYTES = 32 * 1_024;

export interface ManagedLaunchContext {
	readonly runId: string;
	readonly token: string;
	readonly tokenHash: string;
	readonly agent: CodingAgent;
	readonly instanceId: string;
	readonly controllerPaneId: string;
	readonly target: TargetIdentity;
	readonly coordinationRoot?: string;
	readonly signalStoreRoot?: string;
}

export interface ManagedReadinessSnapshot {
	readonly runId: string;
	readonly readiness: RunReadiness;
	readonly effectiveModel?: AgentModelMetadata;
	readonly effectiveThinking?: ThinkingLevel;
	readonly sessionId?: string;
	readonly sessionFile?: string;
}

/**
 * A bounded, branch-local diagnostic record. The coordination ledger remains
 * the runtime authority; this entry is never used to authorize a task/result.
 */
export interface ManagedSessionSnapshot extends ManagedReadinessSnapshot {
	readonly version: 1;
	readonly workId?: string;
	readonly workState?: ManagedWorkState;
	readonly resultReceived?: boolean;
	readonly workFinished?: boolean;
	readonly outcome?: "completed" | "blocked" | "failed";
}

export interface ManagedTaskInput {
	readonly workId: string;
	readonly text: string;
}

/** Wrap task input so Pi's TUI cannot trim it or intercept it as a command. */
export function encodeManagedTaskInput(input: ManagedTaskInput): string {
	if (!isUuid(input.workId) || typeof input.text !== "string" || input.text.trim().length === 0
		|| Buffer.byteLength(input.text, "utf8") > MANAGED_TEXT_MAX_BYTES) {
		throw new Error("Managed task input is invalid.");
	}
	const payload = Buffer.from(JSON.stringify({ v: 1, workId: input.workId, text: input.text }), "utf8").toString("base64url");
	const encoded = `${MANAGED_INPUT_PREFIX}${payload}`;
	if (Buffer.byteLength(encoded, "utf8") > MAX_MANAGED_INPUT_BYTES) throw new Error("Managed task input exceeds its transport limit.");
	return encoded;
}

/** Decode only private managed envelopes; ordinary Pi input remains untouched. */
export function decodeManagedTaskInput(value: string): ManagedTaskInput | undefined {
	if (!value.startsWith(MANAGED_INPUT_PREFIX)) return undefined;
	if (Buffer.byteLength(value, "utf8") > MAX_MANAGED_INPUT_BYTES) throw new Error("Managed task input exceeds its transport limit.");
	try {
		const parsed = JSON.parse(Buffer.from(value.slice(MANAGED_INPUT_PREFIX.length), "base64url").toString("utf8")) as Record<string, unknown>;
		if (Object.keys(parsed).some((key) => key !== "v" && key !== "workId" && key !== "text")
			|| parsed.v !== 1 || typeof parsed.workId !== "string" || !isUuid(parsed.workId)
			|| typeof parsed.text !== "string" || parsed.text.trim().length === 0
			|| Buffer.byteLength(parsed.text, "utf8") > MANAGED_TEXT_MAX_BYTES) {
			throw new Error("Managed task input is malformed.");
		}
		return { workId: parsed.workId, text: parsed.text };
	} catch (cause) {
		if (cause instanceof Error && cause.message.startsWith("Managed task input")) throw cause;
		throw new Error("Managed task input is malformed.");
	}
}

export function createManagedLaunchContext(input: {
	readonly runId: string;
	readonly token: string;
	readonly agent: CodingAgent;
	readonly instanceId: string;
	readonly controllerPaneId: string;
	readonly target: TerminalTarget;
	readonly coordinationRoot?: string;
	readonly signalStoreRoot?: string;
}): ManagedLaunchContext {
	return {
		runId: input.runId,
		token: input.token,
		tokenHash: hashLaunchToken(input.token),
		agent: input.agent,
		instanceId: input.instanceId,
		controllerPaneId: input.controllerPaneId,
		target: {
			instanceId: input.instanceId,
			sessionId: input.target.sessionId,
			windowId: input.target.windowId,
			paneId: input.target.paneId,
		},
		...(input.coordinationRoot === undefined ? {} : { coordinationRoot: input.coordinationRoot }),
		...(input.signalStoreRoot === undefined ? {} : { signalStoreRoot: input.signalStoreRoot }),
	};
}

/** Encode private launch data for the child process without putting it in a prompt. */
export function managedLaunchEnvironment(context: ManagedLaunchContext): Readonly<Record<string, string>> {
	const payload = JSON.stringify({
		v: 1,
		runId: context.runId,
		token: context.token,
		agent: context.agent,
		instanceId: context.instanceId,
		controllerPaneId: context.controllerPaneId,
		target: context.target,
		...(context.coordinationRoot === undefined ? {} : { coordinationRoot: context.coordinationRoot }),
		...(context.signalStoreRoot === undefined ? {} : { signalStoreRoot: context.signalStoreRoot }),
	});
	const encoded = Buffer.from(payload, "utf8").toString("base64url");
	if (Buffer.byteLength(encoded, "utf8") > MAX_CONTEXT_BYTES) throw new Error("Managed launch context exceeds its size limit.");
	return { [MANAGED_CONTEXT_ENV]: encoded };
}

/** Parse child launch context. Invalid or absent context is never treated as verified. */
export function readManagedLaunchContext(environment: NodeJS.ProcessEnv): ManagedLaunchContext | undefined {
	const encoded = environment[MANAGED_CONTEXT_ENV]?.trim();
	if (!encoded || Buffer.byteLength(encoded, "utf8") > MAX_CONTEXT_BYTES) return undefined;
	try {
		const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
			readonly v?: unknown;
			readonly runId?: unknown;
			readonly token?: unknown;
			readonly agent?: unknown;
			readonly instanceId?: unknown;
			readonly controllerPaneId?: unknown;
			readonly coordinationRoot?: unknown;
			readonly signalStoreRoot?: unknown;
			readonly target?: Partial<TargetIdentity>;
		};
		if (parsed.v !== 1 || typeof parsed.runId !== "string" || !isUuid(parsed.runId)
			|| typeof parsed.token !== "string" || !isLaunchToken(parsed.token)
			|| (parsed.agent !== "pi" && parsed.agent !== "codex" && parsed.agent !== "claude" && parsed.agent !== "opencode")
			|| typeof parsed.instanceId !== "string" || parsed.instanceId.length < 1 || parsed.instanceId.length > 4_096
			|| (parsed.coordinationRoot !== undefined && !validPath(parsed.coordinationRoot))
			|| (parsed.signalStoreRoot !== undefined && !validPath(parsed.signalStoreRoot))
			|| typeof parsed.controllerPaneId !== "string" || !/^%[0-9]+$/.test(parsed.controllerPaneId)
			|| !parsed.target || parsed.target.instanceId !== parsed.instanceId
			|| typeof parsed.target.sessionId !== "string" || !/^\$[0-9]+$/.test(parsed.target.sessionId)
			|| typeof parsed.target.windowId !== "string" || !/^@[0-9]+$/.test(parsed.target.windowId)
			|| typeof parsed.target.paneId !== "string" || !/^%[0-9]+$/.test(parsed.target.paneId)) return undefined;
		return {
			runId: parsed.runId,
			token: parsed.token,
			tokenHash: hashLaunchToken(parsed.token),
			agent: parsed.agent,
			instanceId: parsed.instanceId,
			controllerPaneId: parsed.controllerPaneId,
			target: {
				instanceId: parsed.instanceId,
				sessionId: parsed.target.sessionId,
				windowId: parsed.target.windowId,
				paneId: parsed.target.paneId,
			},
			...(typeof parsed.coordinationRoot === "string" ? { coordinationRoot: parsed.coordinationRoot } : {}),
			...(typeof parsed.signalStoreRoot === "string" ? { signalStoreRoot: parsed.signalStoreRoot } : {}),
		};
	} catch {
		return undefined;
	}
}

function validPath(value: unknown): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= 4_096 && !/[\0\r\n]/.test(value);
}

export function managedPromptGuidance(): string {
	return [
		"Private managed Agent Run guidance (not part of the task text):",
		"You are the worker for the currently bound managed Work Cycle.",
		"When the task is complete, blocked, or has failed, use the existing workspace tool send action exactly once with kind=result, the explicit outcome completed, blocked, or failed, and a concise result in text.",
		"Do not provide a targetId, runId, or workId for that result; the private turn binding correlates it.",
		"After sending the result, stop this turn. The lifecycle keeps the Pi process and tmux target open for the next Work Cycle.",
	].join("\n");
}

export function snapshotFromWork(
	readiness: ManagedReadinessSnapshot,
	work: ManagedWorkRecord | undefined,
): ManagedSessionSnapshot {
	const snapshot: ManagedSessionSnapshot = {
		version: 1,
		runId: readiness.runId,
		readiness: readiness.readiness,
		...(readiness.effectiveModel === undefined ? {} : { effectiveModel: readiness.effectiveModel }),
		...(readiness.effectiveThinking === undefined ? {} : { effectiveThinking: readiness.effectiveThinking }),
		...(readiness.sessionId === undefined ? {} : { sessionId: readiness.sessionId }),
		...(readiness.sessionFile === undefined ? {} : { sessionFile: readiness.sessionFile }),
		...(work === undefined ? {} : {
			workId: work.workId,
			workState: work.state,
			resultReceived: work.resultReceivedAt !== undefined,
			workFinished: work.workFinishedAt !== undefined,
			...(work.outcome === undefined ? {} : { outcome: work.outcome }),
		}),
	};
	if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= MAX_SNAPSHOT_BYTES) return snapshot;
	const { outcome: _outcome, ...withoutOutcome } = snapshot;
	return withoutOutcome;
}

/** Validate a branch-local snapshot without treating it as runtime authority. */
export function validateManagedSnapshot(value: unknown): ManagedSessionSnapshot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<ManagedSessionSnapshot>;
	const allowedKeys = new Set(["version", "runId", "readiness", "effectiveModel", "effectiveThinking", "sessionId", "sessionFile", "workId", "workState", "resultReceived", "workFinished", "outcome"]);
	if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) return undefined;
	if (candidate.version !== 1 || typeof candidate.runId !== "string" || !isUuid(candidate.runId)
		|| (candidate.readiness !== "verified" && candidate.readiness !== "process_started" && candidate.readiness !== "unverified")
		|| (candidate.workId !== undefined && (typeof candidate.workId !== "string" || !isUuid(candidate.workId)))
		|| (candidate.workState !== undefined && candidate.workState !== "active" && candidate.workState !== "finished")
		|| (candidate.resultReceived !== undefined && typeof candidate.resultReceived !== "boolean")
		|| (candidate.workFinished !== undefined && typeof candidate.workFinished !== "boolean")
		|| (candidate.outcome !== undefined && candidate.outcome !== "completed" && candidate.outcome !== "blocked" && candidate.outcome !== "failed")
		|| !validModel(candidate.effectiveModel)
		|| !validThinking(candidate.effectiveThinking)
		|| !optionalPath(candidate.sessionId)
		|| !optionalPath(candidate.sessionFile)) return undefined;
	const hasWork = candidate.workId !== undefined;
	if (!hasWork && (candidate.workState !== undefined || candidate.resultReceived !== undefined || candidate.workFinished !== undefined || candidate.outcome !== undefined)) return undefined;
	if (hasWork && (candidate.workState === undefined || candidate.resultReceived === undefined || candidate.workFinished === undefined)) return undefined;
	if (candidate.workState === "finished" && candidate.workFinished !== true) return undefined;
	if (candidate.workState === "active" && candidate.workFinished === true) return undefined;
	if (candidate.resultReceived === true && candidate.outcome === undefined) return undefined;
	if (candidate.resultReceived === false && candidate.outcome !== undefined) return undefined;
	return candidate as ManagedSessionSnapshot;
}

function validModel(value: AgentModelMetadata | undefined): boolean {
	if (value === undefined) return true;
	if (typeof value !== "object" || value === null) return false;
	const record = value as unknown as Record<string, unknown>;
	return Object.keys(record).every((key) => key === "provider" || key === "id")
		&& typeof value.provider === "string" && value.provider.length > 0 && value.provider.length <= 256
		&& typeof value.id === "string" && value.id.length > 0 && value.id.length <= 512;
}

function validThinking(value: ThinkingLevel | undefined): boolean {
	return value === undefined || value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function optionalPath(value: string | undefined): boolean {
	return value === undefined || (typeof value === "string" && value.length <= 4_096 && !/[\0\r\n]/.test(value));
}
