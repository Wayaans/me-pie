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

export interface SendRequest {
	readonly targetId: string;
	readonly input: "prompt" | "command";
	readonly text: string;
	readonly submit?: boolean;
}

export interface WaitRequest {
	readonly targetId: string;
	readonly afterSequence?: number;
	readonly timeoutMs?: number;
}

export interface CloseRequest {
	readonly targetId: string;
}

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

export interface SpawnResult {
	readonly action: "spawn";
	readonly target: TerminalTarget;
}

export interface RunResult {
	readonly action: "run";
	readonly target: TerminalTarget;
	readonly agent: CodingAgent;
	readonly executable: string;
	readonly spawnedTarget: boolean;
}

export interface SendResult {
	readonly action: "send";
	readonly target: TerminalTarget;
	readonly sourcePaneId: string;
	readonly deliveryId: string;
	readonly sequence: number;
	readonly replyAfterSequence: number;
	readonly bytes: number;
	readonly input: SendRequest["input"];
}

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

export type WaitResult = SignaledWaitResult | TimedOutWaitResult;

export interface CloseResult {
	readonly action: "close";
	readonly kind: CloseTargetKind;
	readonly target: TerminalTarget;
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
	close(targetId: string): Effect.Effect<TerminalTarget, TerminalEnvironmentError>;
	send(target: TerminalTarget, text: string, submit: boolean): Effect.Effect<void, TerminalEnvironmentError>;
}
