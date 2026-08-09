import type { Effect } from "effect";
import type { TerminalEnvironmentError } from "./errors.ts";

export const WORKSPACE_ACTIONS = ["spawn", "run", "send", "wait", "close"] as const;
export type WorkspaceAction = (typeof WORKSPACE_ACTIONS)[number];

export const TARGET_KINDS = ["session", "window", "pane"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];
export type CloseTargetKind = Exclude<TargetKind, "session">;

export function closeTargetKindFromId(targetId: string): CloseTargetKind {
	return targetId.startsWith("@") ? "window" : "pane";
}

export const CODING_AGENTS = ["pi", "codex", "claude", "opencode"] as const;
export type CodingAgent = (typeof CODING_AGENTS)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const WORK_OUTCOMES = ["completed", "blocked", "failed"] as const;
export type WorkOutcome = (typeof WORK_OUTCOMES)[number];

export const RUN_READINESS = ["verified", "process_started", "unverified"] as const;
export type RunReadiness = (typeof RUN_READINESS)[number];

export interface SpawnRequest {
	readonly kind?: TargetKind;
	readonly targetId?: string;
	readonly cwd?: string;
	readonly title?: string;
	readonly direction?: "right" | "down";
	readonly focus?: boolean;
}

export interface RunRequest {
	readonly targetId?: string;
	readonly agent?: CodingAgent;
	readonly model?: string;
	readonly thinking?: ThinkingLevel;
	readonly cwd?: string;
	readonly replace?: boolean;
}

export interface RawSendRequest {
	readonly targetId: string;
	readonly input: "prompt" | "command";
	readonly text: string;
	readonly submit?: boolean;
}

/** A controller-created Work Cycle. The target is resolved from the Agent Run. */
export interface ManagedTaskSendRequest {
	readonly kind: "task";
	readonly runId: string;
	readonly input: "prompt" | "command";
	readonly text: string;
	readonly submit?: boolean;
}

/** A Pi worker result. The private child turn binding supplies runId, workId, and controller. */
export interface ManagedResultSendRequest {
	readonly kind: "result";
	readonly outcome: WorkOutcome;
	readonly text: string;
}

export type SendRequest = RawSendRequest | ManagedTaskSendRequest | ManagedResultSendRequest;

export interface RawWaitRequest {
	readonly targetId: string;
	readonly afterSequence?: number;
	readonly timeoutMs?: number;
}

/** Wait for the durable result and Work Finished facts for one Work Cycle. */
export interface ManagedWaitRequest {
	readonly runId: string;
	readonly workId?: string;
	readonly timeoutMs?: number;
}

export type WaitRequest = RawWaitRequest | ManagedWaitRequest;

export interface RawCloseRequest {
	readonly targetId: string;
}

/** Close a successfully launched Agent Run, resolving its tmux target internally. */
export interface ManagedCloseRequest {
	readonly runId: string;
}

export type CloseRequest = RawCloseRequest | ManagedCloseRequest;

export type WorkspaceRequest =
	| { readonly action: "spawn"; readonly request: SpawnRequest }
	| { readonly action: "run"; readonly request: RunRequest }
	| { readonly action: "send"; readonly request: SendRequest }
	| { readonly action: "wait"; readonly request: WaitRequest }
	| { readonly action: "close"; readonly request: CloseRequest };

export interface TerminalTarget {
	readonly environment: "tmux";
	readonly sessionId: string;
	readonly sessionName: string;
	readonly windowId: string;
	readonly windowName: string;
	readonly paneId: string;
	readonly cwd: string;
	readonly currentCommand: string;
	readonly dead: boolean;
}

/** Stable target identity kept in the coordination ledger. */
export interface TargetIdentity {
	readonly instanceId: string;
	readonly sessionId: string;
	readonly windowId: string;
	readonly paneId: string;
}

export function targetIdentity(instanceId: string, target: TerminalTarget): TargetIdentity {
	return {
		instanceId,
		sessionId: target.sessionId,
		windowId: target.windowId,
		paneId: target.paneId,
	};
}

export interface AgentModelMetadata {
	readonly provider: string;
	readonly id: string;
}

export interface RunCapabilities {
	/** The run record and Work Cycles are persisted in the coordination ledger. */
	readonly persistence: "durable";
	/** The launch command was accepted by tmux. */
	readonly processStarted: boolean;
	/** Pi readiness and Work Finished are verified only for Pi runs. */
	readonly verifiedWorkFinished: boolean;
}

export interface RunResult {
	readonly action: "run";
	readonly target: TerminalTarget;
	readonly agent: CodingAgent;
	readonly executable: string;
	readonly spawnedTarget: boolean;
	/** Every runtime RunResult has this authoritative UUID. */
	readonly runId: string;
	readonly readiness?: RunReadiness;
	readonly capability?: "verified" | "unverified";
	readonly lifecycle?: "verified" | "unverified";
	readonly persistence?: "durable";
	readonly processStarted?: boolean;
	readonly verifiedWorkFinished?: boolean;
	readonly capabilities?: RunCapabilities;
	readonly effectiveModel?: AgentModelMetadata;
	readonly effectiveThinking?: ThinkingLevel;
	readonly sessionId?: string;
	readonly sessionFile?: string;
}

export interface SpawnResult {
	readonly action: "spawn";
	readonly target: TerminalTarget;
}

interface SendResultBase {
	readonly action: "send";
	readonly target: TerminalTarget;
	readonly sourcePaneId: string;
	readonly deliveryId: string;
	readonly bytes: number;
}

/** Raw target-based sends retain their complete inbox sequencing guarantees. */
export interface RawSendResult extends SendResultBase {
	readonly input: RawSendRequest["input"];
	/** Omitted for the v1 target-based send action. */
	readonly kind?: "raw";
	readonly sequence: number;
	readonly replyAfterSequence: number;
}

export interface ManagedTaskSendResult extends SendResultBase {
	readonly kind: "task";
	readonly runId: string;
	readonly workId: string;
	readonly input: RawSendRequest["input"];
}

export interface ManagedResultSendResult extends SendResultBase {
	readonly kind: "result";
	readonly runId: string;
	readonly workId: string;
	readonly input: "prompt";
	readonly outcome: WorkOutcome;
	readonly resultReceived: true;
	readonly workFinished: boolean;
	readonly text: string;
}

export type SendResult = RawSendResult | ManagedTaskSendResult | ManagedResultSendResult;

interface WaitResultBase {
	readonly action: "wait";
	readonly target: TerminalTarget;
	readonly sequence: number;
	readonly elapsedMs: number;
}

export interface SignaledWaitResult extends WaitResultBase {
	readonly reason: "signaled";
	readonly sourcePaneId: string;
}

export interface TimedOutWaitResult extends WaitResultBase {
	readonly reason: "timeout";
}

export interface ManagedWorkMetadata {
	readonly controllerPaneId?: string;
	readonly workerPaneId?: string;
	readonly deliveryId: string;
	readonly resultDeliveryId?: string;
	readonly resultReceivedAt?: number;
	readonly workFinishedAt?: number;
	readonly effectiveModel?: AgentModelMetadata;
	readonly effectiveThinking?: ThinkingLevel;
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly truncated?: boolean;
}

export interface ManagedWaitResult {
	readonly action: "wait";
	readonly mode: "managed";
	readonly reason: "work_finished" | "protocol_failure" | "timeout";
	readonly target: TerminalTarget;
	readonly runId: string;
	readonly workId: string;
	/** Present only for a worker-supplied result, not for protocol_failure. */
	readonly outcome?: WorkOutcome;
	/** A protocol_failure text is generated by the controller and does not imply Result Received. */
	readonly text?: string;
	readonly metadata?: ManagedWorkMetadata;
	readonly protocolFailure?: true;
	readonly resultReceived: boolean;
	readonly workFinished: boolean;
	readonly sequence: number;
	readonly elapsedMs: number;
}

export type RawWaitResult = SignaledWaitResult | TimedOutWaitResult;
export type WaitResult = RawWaitResult | ManagedWaitResult;

export interface CloseResult {
	readonly action: "close";
	readonly kind: CloseTargetKind;
	readonly target: TerminalTarget;
	readonly runId?: string;
}

export type WorkspaceResult = SpawnResult | RunResult | SendResult | WaitResult | CloseResult;

export interface TerminalAdapter {
	readonly environment: "tmux";
	readonly socketPath: string;
	readonly instanceId: string;
	readonly currentTarget: TerminalTarget;
	spawn(request: SpawnRequest, defaultCwd: string): Effect.Effect<TerminalTarget, TerminalEnvironmentError>;
	resolve(targetId: string): Effect.Effect<TerminalTarget, TerminalEnvironmentError>;
	launch(target: TerminalTarget, launcherPath: string, cwd: string, replace: boolean, ownedByOperation: boolean): Effect.Effect<void, TerminalEnvironmentError>;
	closeSpawnedWindow(target: TerminalTarget): Effect.Effect<void, TerminalEnvironmentError>;
	close(targetId: string, expected?: TerminalTarget): Effect.Effect<TerminalTarget, TerminalEnvironmentError>;
	send(target: TerminalTarget, text: string, submit: boolean): Effect.Effect<void, TerminalEnvironmentError>;
}
