import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Effect } from "effect";
import { environmentError, errorMessage, TerminalEnvironmentError } from "./errors.ts";
import { TERMINAL_ENVIRONMENT_RUNTIME_ROOT } from "./paths.ts";
import {
	targetIdentity,
	type AgentModelMetadata,
	type CodingAgent,
	type TargetIdentity,
	type TerminalTarget,
	type ThinkingLevel,
	type WorkOutcome,
} from "./model.ts";

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 10_000;
const MAX_RUNS = 128;
const MAX_WORKS = 128;
const RETAINED_HISTORICAL_RUNS = 32;
const RETAINED_EXTRA_FINISHED_WORKS = 32;
export const MANAGED_TEXT_MAX_BYTES = 16 * 1_024;
const MAX_TEXT_LINES = 2_000;
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;

interface LockOwner {
	readonly pid: number;
	readonly token: string;
}

export type ManagedRunState = "starting" | "idle" | "busy" | "closing" | "closed" | "lost";
export type ManagedWorkState = "active" | "finished";

export interface ManagedRunRecord {
	readonly runId: string;
	readonly agent: CodingAgent;
	readonly controllerPaneId: string;
	readonly controllerTargetIdentity: TargetIdentity;
	readonly target: TerminalTarget;
	readonly targetIdentity: TargetIdentity;
	readonly tokenHash: string;
	readonly state: ManagedRunState;
	readonly readiness: "starting" | "process_started" | "verified" | "unverified";
	readonly processStarted: boolean;
	readonly verifiedWorkFinished: boolean;
	readonly createdAt: number;
	readonly launchedAt?: number;
	readonly closingAt?: number;
	readonly closedAt?: number;
	readonly lostAt?: number;
	readonly effectiveModel?: AgentModelMetadata;
	readonly effectiveThinking?: ThinkingLevel;
	readonly sessionId?: string;
	readonly sessionFile?: string;
}

export interface ManagedWorkRecord {
	readonly workId: string;
	readonly runId: string;
	readonly controllerPaneId: string;
	readonly controllerTargetIdentity: TargetIdentity;
	readonly workerPaneId: string;
	/** Hash of the literal submitted task prompt used for private child binding. */
	readonly promptHash: string;
	readonly deliveryId: string;
	readonly state: ManagedWorkState;
	readonly input: "prompt" | "command";
	readonly createdAt: number;
	readonly resultDeliveryId?: string;
	readonly outcome?: WorkOutcome;
	readonly text?: string;
	readonly resultReceivedAt?: number;
	readonly workFinishedAt?: number;
	readonly protocolFailure?: string;
	readonly effectiveModel?: AgentModelMetadata;
	readonly effectiveThinking?: ThinkingLevel;
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly truncated?: boolean;
}

export interface CreateRunInput {
	readonly runId: string;
	readonly token: string;
	readonly agent: CodingAgent;
	readonly controllerPaneId: string;
	readonly controllerTarget: TargetIdentity;
	readonly target: TerminalTarget;
	readonly instanceId: string;
	readonly now?: number;
}

export interface ReadinessInput {
	readonly runId: string;
	readonly token: string;
	readonly target: TargetIdentity;
	readonly targetSnapshot?: TerminalTarget;
	readonly effectiveModel?: AgentModelMetadata;
	readonly effectiveThinking?: ThinkingLevel;
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly now?: number;
}

export interface UpdateTargetInput {
	readonly runId: string;
	readonly token: string;
	readonly target: TerminalTarget;
}

export interface BeginWorkInput {
	readonly runId: string;
	readonly controllerPaneId: string;
	readonly controllerTarget: TargetIdentity;
	readonly workerPaneId: string;
	readonly targetSnapshot?: TerminalTarget;
	readonly input: "prompt" | "command";
	readonly text: string;
	readonly now?: number;
}

export interface ResultInput {
	readonly runId: string;
	readonly workId: string;
	readonly token: string;
	readonly worker: TargetIdentity;
	readonly outcome: WorkOutcome;
	readonly text: string;
	readonly now?: number;
}

export interface FinishInput {
	readonly runId: string;
	readonly workId: string;
	readonly token: string;
	readonly worker: TargetIdentity;
	readonly now?: number;
}

export interface CloseInput {
	readonly runId: string;
	readonly controllerPaneId: string;
	readonly controllerTarget: TargetIdentity;
	readonly target: TargetIdentity;
	readonly now?: number;
}

interface LedgerState {
	readonly version: 1;
	readonly instanceId: string;
	readonly runs: readonly ManagedRunRecord[];
	readonly works: readonly ManagedWorkRecord[];
}

export interface CoordinationLedgerOptions {
	readonly rootDirectory?: string;
}

export interface ManagedText {
	readonly text: string;
	readonly bytes: number;
	readonly truncated: boolean;
}

/**
 * Bound result text before it enters either the cross-process ledger or a tool
 * result. The task itself is still delivered literally; only persisted result
 * output is bounded.
 */
export function boundManagedText(value: string): ManagedText {
	const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	const lines = normalized.split("\n");
	let bounded = lines.slice(0, MAX_TEXT_LINES).join("\n");
	let truncated = lines.length > MAX_TEXT_LINES;
	if (Buffer.byteLength(bounded, "utf8") > MANAGED_TEXT_MAX_BYTES) {
		let end = bounded.length;
		while (end > 0 && Buffer.byteLength(bounded.slice(0, end), "utf8") > MANAGED_TEXT_MAX_BYTES) end -= 1;
		bounded = bounded.slice(0, end);
		truncated = true;
	}
	return { text: bounded, bytes: Buffer.byteLength(bounded, "utf8"), truncated };
}

export function hashLaunchToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

export function hashManagedPrompt(value: string): string {
	const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isLaunchToken(value: string): boolean {
	return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !/[\0\r\n]/.test(value);
}

export class CoordinationLedger {
	private readonly rootDirectory: string;
	private readonly directory: string;
	private readonly instanceId: string;

	constructor(instanceId: string, options: CoordinationLedgerOptions = {}) {
		this.instanceId = instanceId;
		const serverId = createHash("sha256").update(instanceId).digest("hex").slice(0, 24);
		this.rootDirectory = path.resolve(options.rootDirectory ?? path.join(TERMINAL_ENVIRONMENT_RUNTIME_ROOT, "coordination"));
		this.directory = path.join(this.rootDirectory, serverId);
	}

	createRun(input: CreateRunInput): Effect.Effect<ManagedRunRecord, TerminalEnvironmentError> {
		return this.mutate("create managed Agent Run", (state, now) => {
			const compacted = pruneState(state);
			if (!isUuid(input.runId)) throw new Error(`Invalid run ID: ${input.runId}`);
			if (input.instanceId !== this.instanceId) throw new Error("Managed Agent Run belongs to a different tmux server instance.");
			if (!/^%[0-9]+$/.test(input.controllerPaneId) || input.controllerTarget.paneId !== input.controllerPaneId || input.controllerTarget.instanceId !== input.instanceId || !validTargetIdentity(input.controllerTarget) || !validTarget(input.target) || input.target.dead) throw new Error("Managed Agent Run target diagnostics are invalid.");
			if (!isLaunchToken(input.token)) throw new Error("Managed launch token is invalid.");
			const existing = compacted.runs.find((run) => run.runId === input.runId);
			if (existing) {
				if (existing.tokenHash !== hashLaunchToken(input.token)
					|| existing.controllerPaneId !== input.controllerPaneId
					|| !sameTargetIdentity(existing.controllerTargetIdentity, input.controllerTarget)
					|| !sameTargetIdentity(existing.targetIdentity, targetIdentity(input.instanceId, input.target))) {
					throw new Error(`Run ${input.runId} already belongs to a different launch.`);
				}
				return { state: compacted, value: existing };
			}
			const targetKey = targetIdentity(input.instanceId, input.target);
			const ownedTarget = compacted.runs.find((run) => run.state !== "closed" && run.state !== "lost" && sameTargetIdentity(run.targetIdentity, targetKey));
			if (ownedTarget) {
				throw new Error(`Target ${targetKey.paneId} is already owned by Agent Run ${ownedTarget.runId}; close or mark that run lost before replacement.`);
			}
			if (compacted.runs.length >= MAX_RUNS) throw new Error("The coordination ledger has reached its active Agent Run limit.");
			const createdAt = Math.max(input.now ?? now, ...compacted.runs.map((run) => run.createdAt + 1), 0);
			const record: ManagedRunRecord = {
				runId: input.runId,
				agent: input.agent,
				controllerPaneId: input.controllerPaneId,
				controllerTargetIdentity: input.controllerTarget,
				target: input.target,
				targetIdentity: targetKey,
				tokenHash: hashLaunchToken(input.token),
				state: "starting",
				readiness: "starting",
				processStarted: false,
				verifiedWorkFinished: false,
				createdAt,
			};
			return { state: { ...compacted, runs: [...compacted.runs, record] }, value: record };
		});
	}

	markLaunched(runId: string, now = Date.now()): Effect.Effect<ManagedRunRecord, TerminalEnvironmentError> {
		return this.mutate("record managed process start", (state) => {
			const run = this.requireRun(state, runId);
			if (run.state === "closed" || run.state === "lost" || run.state === "closing") throw new Error(`Run ${runId} is no longer launchable.`);
			const next: ManagedRunRecord = {
				...run,
				state: run.state === "busy" ? "busy" : "idle",
				readiness: run.readiness === "verified" ? "verified" : "process_started",
				processStarted: true,
				verifiedWorkFinished: run.verifiedWorkFinished,
				...(run.launchedAt === undefined ? { launchedAt: now } : {}),
			};
			return { state: replaceRun(state, next), value: next };
		});
	}

	updateTarget(input: UpdateTargetInput): Effect.Effect<ManagedRunRecord, TerminalEnvironmentError> {
		return this.mutate("refresh managed Agent Run target diagnostics", (state) => {
			const run = this.requireRun(state, input.runId);
			this.requireToken(run, input.token);
			if (run.state === "closed" || run.state === "lost" || run.state === "closing") throw new Error(`Run ${input.runId} is no longer accepting target updates.`);
			if (!validTarget(input.target) || input.target.dead || !sameTargetIdentity(run.targetIdentity, targetIdentity(this.instanceId, input.target))) throw new Error(`Run ${input.runId} target identity is stale or was reused.`);
			// The child readiness snapshot is newer than the controller's post-launch observation.
			if (run.readiness === "verified") return { state, value: run };
			const next: ManagedRunRecord = { ...run, target: input.target };
			return { state: replaceRun(state, next), value: next };
		});
	}

	recordReadiness(input: ReadinessInput): Effect.Effect<ManagedRunRecord, TerminalEnvironmentError> {
		return this.mutate("record managed Pi readiness", (state, now) => {
			const run = this.requireRun(state, input.runId);
			this.requireToken(run, input.token);
			if (run.state === "closed" || run.state === "lost" || run.state === "closing") throw new Error(`Run ${input.runId} is no longer accepting readiness.`);
			if (run.agent !== "pi") throw new Error("Only Pi Agent Runs can report verified readiness.");
			if (!sameTargetIdentity(run.targetIdentity, input.target)) throw new Error("Managed launch target identity does not match the Agent Run.");
			if (input.targetSnapshot !== undefined && (!validTarget(input.targetSnapshot) || input.targetSnapshot.dead || !sameTargetIdentity(run.targetIdentity, targetIdentity(this.instanceId, input.targetSnapshot)))) throw new Error("Managed readiness target diagnostics do not match the Agent Run.");
			const next: ManagedRunRecord = {
				...run,
				...(input.targetSnapshot === undefined ? {} : { target: input.targetSnapshot }),
				state: run.state === "busy" ? "busy" : "idle",
				readiness: "verified",
				processStarted: true,
				verifiedWorkFinished: true,
				...(input.effectiveModel === undefined ? {} : { effectiveModel: input.effectiveModel }),
				...(input.effectiveThinking === undefined ? {} : { effectiveThinking: input.effectiveThinking }),
				...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
				...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
				launchedAt: run.launchedAt ?? input.now ?? now,
			};
			return { state: replaceRun(state, next), value: next };
		});
	}

	revokeReadiness(input: Omit<FinishInput, "workId">, reason: string): Effect.Effect<void, TerminalEnvironmentError> {
		return this.mutate("revoke managed Pi readiness", (state, now) => {
			const run = this.requireRun(state, input.runId);
			this.requireToken(run, input.token);
			if (!sameTargetIdentity(run.targetIdentity, input.worker)) throw new Error("Managed readiness revocation source target is stale or was reused.");
			if (run.state === "closed" || run.state === "lost") return { state, value: undefined };
			const failure = boundManagedText(reason).text;
			const works = state.works.map((work) => work.runId === input.runId && work.state === "active"
				? { ...work, state: "finished" as const, workFinishedAt: input.now ?? now, protocolFailure: failure }
				: work);
			const next: ManagedRunRecord = {
				...run,
				state: run.state === "closing" ? "closing" : "idle",
				readiness: "unverified",
				verifiedWorkFinished: false,
			};
			return { state: { ...replaceRun(state, next), works }, value: undefined };
		});
	}

	getRun(runId: string): Effect.Effect<ManagedRunRecord | undefined, TerminalEnvironmentError> {
		return this.read("read managed Agent Run", (state) => state.runs.find((run) => run.runId === runId));
	}

	findOpenRunForTarget(target: TargetIdentity, includeWindow: boolean): Effect.Effect<ManagedRunRecord | undefined, TerminalEnvironmentError> {
		return this.read("find managed Agent Run target owner", (state) => state.runs.find((run) =>
			run.state !== "closed" && run.state !== "lost"
			&& run.targetIdentity.instanceId === target.instanceId
			&& (includeWindow
				? run.targetIdentity.sessionId === target.sessionId && run.targetIdentity.windowId === target.windowId
				: sameTargetIdentity(run.targetIdentity, target))));
	}

	assertController(
		runId: string,
		controllerPaneId: string,
		controllerTarget: TargetIdentity,
		target: TargetIdentity,
	): Effect.Effect<ManagedRunRecord, TerminalEnvironmentError> {
		return this.read("validate managed Agent Run ownership", (state) => {
			const run = this.requireRun(state, runId);
			if (run.controllerPaneId !== controllerPaneId || !sameTargetIdentity(run.controllerTargetIdentity, controllerTarget)) throw new Error(`Run ${runId} belongs to another controller target.`);
			if (!sameTargetIdentity(run.targetIdentity, target)) throw new Error(`Run ${runId} target identity is stale or was reused.`);
			if (run.state === "closed") throw new Error(`Run ${runId} is closed.`);
			if (run.state === "lost") throw new Error(`Run ${runId} is lost; refusing to use its target.`);
			if (run.state === "closing") throw new Error(`Run ${runId} is closing; refusing concurrent use.`);
			if (!run.processStarted) throw new Error(`Run ${runId} has not launched successfully.`);
			return run;
		});
	}

	beginWork(input: BeginWorkInput): Effect.Effect<ManagedWorkRecord, TerminalEnvironmentError> {
		return this.mutate("create managed Work Cycle", (state, now) => {
			const run = this.requireRun(state, input.runId);
			if (run.controllerPaneId !== input.controllerPaneId || !sameTargetIdentity(run.controllerTargetIdentity, input.controllerTarget)) throw new Error(`Run ${input.runId} belongs to another controller target.`);
			if (run.agent !== "pi" || run.readiness !== "verified" || !run.verifiedWorkFinished) {
				throw new Error(`Run ${input.runId} is not a verified Pi Agent Run and cannot accept managed tasks.`);
			}
			if (!run.processStarted || run.state !== "idle") throw new Error(`Run ${input.runId} is not idle for a Work Cycle.`);
			if (input.targetSnapshot !== undefined && (!validTarget(input.targetSnapshot) || !sameTargetIdentity(run.targetIdentity, targetIdentity(this.instanceId, input.targetSnapshot)) || !sameTargetRuntime(run.target, input.targetSnapshot))) throw new Error(`Run ${input.runId} target diagnostics changed before Work Cycle reservation.`);
			if (boundManagedText(input.text).truncated) throw new Error("Managed task text exceeds its bounded payload limit.");
			const active = state.works.find((work) => work.runId === input.runId && work.state === "active");
			if (active) throw new Error(`Run ${input.runId} already has an active Work Cycle (${active.workId}).`);
			const createdAt = Math.max(input.now ?? now, ...state.works.map((work) => work.createdAt + 1), 0);
			const work: ManagedWorkRecord = {
				workId: crypto.randomUUID(),
				runId: input.runId,
				controllerPaneId: input.controllerPaneId,
				controllerTargetIdentity: input.controllerTarget,
				workerPaneId: input.workerPaneId,
				promptHash: hashManagedPrompt(input.text),
				deliveryId: crypto.randomUUID(),
				state: "active",
				input: input.input,
				createdAt,
			};
			const nextRun: ManagedRunRecord = { ...run, state: "busy" };
			return {
				state: { ...replaceRun(state, nextRun), works: [...state.works, work] },
				value: work,
			};
		});
	}

	cancelWork(runId: string, workId: string): Effect.Effect<void, TerminalEnvironmentError> {
		return this.mutate("rollback managed Work Cycle", (state) => {
			const work = state.works.find((candidate) => candidate.runId === runId && candidate.workId === workId);
			if (!work || work.state !== "active" || work.resultReceivedAt !== undefined || work.workFinishedAt !== undefined) return { state, value: undefined };
			const run = this.requireRun(state, runId);
			const nextRun = run.state === "closed" || run.state === "lost" ? run : { ...run, state: "idle" as const };
			return {
				state: { ...replaceRun(state, nextRun), works: state.works.filter((candidate) => candidate.workId !== workId) },
				value: undefined,
			};
		});
	}

	rejectWork(input: FinishInput, reason: string): Effect.Effect<ManagedWorkRecord, TerminalEnvironmentError> {
		return this.mutate("reject managed Work Cycle input", (state, now) => {
			const run = this.requireRun(state, input.runId);
			this.requireManagedWorkerRun(run, input.worker, "Work Cycle rejection");
			this.requireToken(run, input.token);
			const work = this.findExactWork(state, input.runId, input.workId);
			if (!work || work.state !== "active") throw new Error(`Work Cycle ${input.workId} is not active for Agent Run ${input.runId}.`);
			const failure = boundManagedText(reason).text;
			const next: ManagedWorkRecord = { ...work, state: "finished", workFinishedAt: input.now ?? now, protocolFailure: failure };
			return {
				state: { ...replaceRun(state, { ...run, state: "idle" }), works: replaceWork(state, next) },
				value: next,
			};
		});
	}

	recordResult(input: ResultInput): Effect.Effect<ManagedWorkRecord, TerminalEnvironmentError> {
		return this.mutate("record managed Result Received", (state, now) => {
			const run = this.requireRun(state, input.runId);
			this.requireManagedWorkerRun(run, input.worker, "results");
			this.requireToken(run, input.token);
			const work = this.findExactWork(state, input.runId, input.workId);
			if (!work) throw new Error(`Work Cycle ${input.workId} does not belong to Agent Run ${input.runId}.`);
			const newerActive = state.works.find((candidate) => candidate.runId === input.runId && candidate.state === "active" && candidate.workId !== input.workId);
			if (newerActive) throw new Error(`Work Cycle ${input.workId} is stale; Work Cycle ${newerActive.workId} is active.`);
			if (work.workerPaneId !== input.worker.paneId) throw new Error(`Work Cycle ${work.workId} belongs to another worker pane.`);
			const bounded = boundManagedText(input.text);
			if (work.resultReceivedAt !== undefined) {
				if (work.outcome !== input.outcome || work.text !== bounded.text) throw new Error(`Work Cycle ${work.workId} already has a different result.`);
				return { state, value: work };
			}
			const resultDeliveryId = crypto.randomUUID();
			if (work.protocolFailure !== undefined) throw new Error(`Work Cycle ${work.workId} ended with a protocol failure.`);
			const next: ManagedWorkRecord = {
				...work,
				state: work.workFinishedAt === undefined ? "active" : "finished",
				resultDeliveryId,
				outcome: input.outcome,
				text: bounded.text,
				resultReceivedAt: input.now ?? now,
				...(bounded.truncated ? { truncated: true } : {}),
			};
			const nextRun: ManagedRunRecord = { ...run, state: next.workFinishedAt === undefined ? "busy" : "idle" };
			return { state: { ...replaceRun(state, nextRun), works: replaceWork(state, next) }, value: next };
		});
	}

	markWorkFinished(input: FinishInput): Effect.Effect<ManagedWorkRecord, TerminalEnvironmentError> {
		return this.mutate("record managed Work Finished", (state, now) => {
			const run = this.requireRun(state, input.runId);
			this.requireManagedWorkerRun(run, input.worker, "Work Finished");
			this.requireToken(run, input.token);
			const work = this.findExactWork(state, input.runId, input.workId);
			if (!work) throw new Error(`Work Cycle ${input.workId} does not belong to Agent Run ${input.runId}.`);
			const newerActive = state.works.find((candidate) => candidate.runId === input.runId && candidate.state === "active" && candidate.workId !== input.workId);
			if (newerActive) throw new Error(`Work Cycle ${input.workId} is stale; Work Cycle ${newerActive.workId} is active.`);
			if (work.workerPaneId !== input.worker.paneId) throw new Error(`Work Cycle ${work.workId} belongs to another worker pane.`);
			if (work.workFinishedAt !== undefined) return { state, value: work };
			const next: ManagedWorkRecord = { ...work, state: "finished", workFinishedAt: input.now ?? now };
			const nextRun: ManagedRunRecord = { ...run, state: "idle" };
			return { state: { ...replaceRun(state, nextRun), works: replaceWork(state, next) }, value: next };
		});
	}

	getWork(runId: string, workId?: string): Effect.Effect<ManagedWorkRecord | undefined, TerminalEnvironmentError> {
		return this.read("read managed Work Cycle", (state) => workId === undefined
			? this.findLatestWork(state, runId)
			: this.findExactWork(state, runId, workId));
	}

	getActiveWork(runId: string): Effect.Effect<ManagedWorkRecord | undefined, TerminalEnvironmentError> {
		return this.read("read active managed Work Cycle", (state) => state.works.find((work) => work.runId === runId && work.state === "active"));
	}

	markLost(runId: string, now = Date.now()): Effect.Effect<void, TerminalEnvironmentError> {
		return this.mutate("mark stale Agent Run lost", (state) => {
			const run = this.requireRun(state, runId);
			if (run.state === "closed" || run.state === "lost") return { state, value: undefined };
			const { closingAt: _closingAt, ...withoutClosing } = run;
			const next: ManagedRunRecord = { ...withoutClosing, state: "lost", readiness: "unverified", verifiedWorkFinished: false, lostAt: now };
			const works = state.works.map((work) => work.runId === runId && work.state === "active"
				? { ...work, state: "finished" as const, workFinishedAt: now, protocolFailure: "Agent Run target was lost before the Work Cycle completed." }
				: work);
			return { state: { ...replaceRun(state, next), works }, value: undefined };
		});
	}

	markClosing(input: CloseInput): Effect.Effect<ManagedRunRecord, TerminalEnvironmentError> {
		return this.mutate("reserve managed Agent Run close", (state, now) => {
			const run = this.requireRun(state, input.runId);
			if (run.controllerPaneId !== input.controllerPaneId || !sameTargetIdentity(run.controllerTargetIdentity, input.controllerTarget)) throw new Error(`Run ${input.runId} belongs to another controller target.`);
			if (!sameTargetIdentity(run.targetIdentity, input.target)) throw new Error(`Run ${input.runId} target identity is stale or was reused.`);
			if (run.state === "lost") throw new Error(`Run ${input.runId} is lost; it cannot be closed blindly.`);
			if (run.state === "closed") throw new Error(`Run ${input.runId} is already closed; refusing to touch a possibly reused target.`);
			if (run.state === "closing") throw new Error(`Run ${input.runId} is already closing.`);
			if (state.works.some((work) => work.runId === input.runId && work.state === "active")) {
				throw new Error(`Run ${input.runId} has an active Work Cycle; wait for Work Finished before closing it.`);
			}
			const next: ManagedRunRecord = { ...run, state: "closing", closingAt: input.now ?? now };
			return { state: replaceRun(state, next), value: next };
		});
	}

	markClosed(input: CloseInput): Effect.Effect<ManagedRunRecord, TerminalEnvironmentError> {
		return this.mutate("record closed Agent Run", (state, now) => {
			const run = this.requireRun(state, input.runId);
			if (run.controllerPaneId !== input.controllerPaneId || !sameTargetIdentity(run.controllerTargetIdentity, input.controllerTarget)) throw new Error(`Run ${input.runId} belongs to another controller target.`);
			if (!sameTargetIdentity(run.targetIdentity, input.target)) throw new Error(`Run ${input.runId} target identity is stale or was reused.`);
			if (run.state !== "closing") throw new Error(`Run ${input.runId} is not reserved for close.`);
			const { closingAt: _closingAt, ...withoutClosing } = run;
			const next: ManagedRunRecord = { ...withoutClosing, state: "closed", closedAt: input.now ?? now };
			return { state: replaceRun(state, next), value: next };
		});
	}

	restoreClosing(runId: string): Effect.Effect<void, TerminalEnvironmentError> {
		return this.mutate("restore managed Agent Run after failed close", (state) => {
			const run = this.requireRun(state, runId);
			if (run.state !== "closing") return { state, value: undefined };
			const { closingAt: _closingAt, ...withoutClosing } = run;
			const next: ManagedRunRecord = { ...withoutClosing, state: run.processStarted ? "idle" : "starting" };
			return { state: replaceRun(state, next), value: undefined };
		});
	}

	private findExactWork(state: LedgerState, runId: string, workId: string): ManagedWorkRecord | undefined {
		return state.works.find((work) => work.runId === runId && work.workId === workId);
	}

	private findLatestWork(state: LedgerState, runId: string): ManagedWorkRecord | undefined {
		return state.works
			.filter((work) => work.runId === runId)
			.reduce<ManagedWorkRecord | undefined>((latest, work) => latest === undefined || work.createdAt >= latest.createdAt ? work : latest, undefined);
	}

	private requireRun(state: LedgerState, runId: string): ManagedRunRecord {
		if (!isUuid(runId)) throw new Error(`Invalid run ID: ${runId}`);
		const run = state.runs.find((candidate) => candidate.runId === runId);
		if (!run) throw new Error(`Unknown Agent Run: ${runId}`);
		return run;
	}

	private requireToken(run: ManagedRunRecord, token: string): void {
		if (!isLaunchToken(token) || hashLaunchToken(token) !== run.tokenHash) throw new Error("Managed launch token is invalid.");
	}

	private requireManagedWorkerRun(run: ManagedRunRecord, worker: TargetIdentity, fact: string): void {
		if (run.state === "closed" || run.state === "lost" || run.state === "closing") throw new Error(`Run ${run.runId} is no longer accepting ${fact}.`);
		if (run.agent !== "pi" || run.readiness !== "verified" || !run.verifiedWorkFinished) throw new Error(`Run ${run.runId} is not a verified Pi Agent Run.`);
		if (!sameTargetIdentity(run.targetIdentity, worker)) throw new Error(`Managed ${fact} source target is stale or was reused.`);
	}

	private read<A>(operation: string, select: (state: LedgerState) => A): Effect.Effect<A, TerminalEnvironmentError> {
		return Effect.tryPromise({
			try: async (signal) => select(await this.readState(signal)),
			catch: (cause) => cause instanceof TerminalEnvironmentError ? cause : environmentError(operation, errorMessage(cause), cause),
		});
	}

	private mutate<A>(
		operation: string,
		change: (state: LedgerState, now: number) => { readonly state: LedgerState; readonly value: A },
	): Effect.Effect<A, TerminalEnvironmentError> {
		return Effect.tryPromise({
			try: async (signal) => {
				await this.ensureDirectory();
				const release = await this.acquireLock(signal);
				try {
					const current = await this.readState(signal);
					const changed = change(current, Date.now());
					const pruned = pruneState(changed.state);
					if (pruned !== current) await this.writeState(pruned, signal);
					return changed.value;
				} finally {
					await release();
				}
			},
			catch: (cause) => cause instanceof TerminalEnvironmentError ? cause : environmentError(operation, errorMessage(cause), cause),
		});
	}

	private async ensureDirectory(): Promise<void> {
		await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
		await chmod(this.rootDirectory, 0o700);
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await chmod(this.directory, 0o700);
	}

	private statePath(): string { return path.join(this.directory, "ledger.json"); }
	private lockPath(): string { return path.join(this.directory, "ledger.lock"); }

	private async readState(signal: AbortSignal): Promise<LedgerState> {
		signal.throwIfAborted();
		await this.ensureDirectory();
		try {
			const content = await readFile(this.statePath(), "utf8");
			if (Buffer.byteLength(content, "utf8") > MAX_LEDGER_BYTES) throw new Error("Coordination ledger exceeds its size limit.");
			const parsed = JSON.parse(content) as Partial<LedgerState>;
			if (parsed.version !== 1 || parsed.instanceId !== this.instanceId || !Array.isArray(parsed.runs) || !Array.isArray(parsed.works)
				|| parsed.runs.length > MAX_RUNS || parsed.works.length > MAX_WORKS) {
				throw new Error("Coordination ledger is malformed.");
			}
			const runs = parsed.runs as ManagedRunRecord[];
			const works = parsed.works as ManagedWorkRecord[];
			if (runs.some((run) => !validRunRecord(run) || run.targetIdentity.instanceId !== this.instanceId
				|| run.controllerTargetIdentity.instanceId !== this.instanceId
				|| run.controllerTargetIdentity.paneId !== run.controllerPaneId
				|| run.targetIdentity.sessionId !== run.target.sessionId
				|| run.targetIdentity.windowId !== run.target.windowId
				|| run.targetIdentity.paneId !== run.target.paneId)
				|| works.some((work) => !validWorkRecord(work))
				|| works.some((work) => {
					const run = runs.find((candidate) => candidate.runId === work.runId);
					return !run || run.controllerPaneId !== work.controllerPaneId || !sameTargetIdentity(run.controllerTargetIdentity, work.controllerTargetIdentity) || run.target.paneId !== work.workerPaneId;
				})
				|| runs.some((run) => run.state === "closed" || run.state === "lost" || run.state === "closing"
					? works.some((work) => work.runId === run.runId && work.state === "active")
					: false)
				|| runs.some((run) => (run.state === "closed" && run.closedAt === undefined) || (run.state === "lost" && run.lostAt === undefined) || (run.state === "closing" && run.closingAt === undefined))
				|| runs.some((run) => {
					const hasActiveWork = works.some((work) => work.runId === run.runId && work.state === "active");
					return (run.state === "busy") !== hasActiveWork;
				})
				|| runs.some((run) => (run.verifiedWorkFinished || run.readiness === "verified") && (run.agent !== "pi" || !run.processStarted || run.readiness !== "verified"))) {
				throw new Error("Coordination ledger is malformed.");
			}
			return { version: 1, instanceId: this.instanceId, runs, works };
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, instanceId: this.instanceId, runs: [], works: [] };
			throw cause;
		}
	}

	private async writeState(state: LedgerState, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		const destination = this.statePath();
		const serialized = `${JSON.stringify(state)}\n`;
		if (Buffer.byteLength(serialized, "utf8") > MAX_LEDGER_BYTES) throw new Error("Coordination ledger exceeds its size limit.");
		const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
		try {
			await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx", signal });
			await chmod(temporary, 0o600);
			await rename(temporary, destination);
		} finally {
			await rm(temporary, { force: true }).catch(() => undefined);
		}
	}

	private async acquireLock(signal: AbortSignal): Promise<() => Promise<void>> {
		const lock = this.lockPath();
		const ownerPath = path.join(lock, "owner.json");
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		for (;;) {
			signal.throwIfAborted();
			try {
				await mkdir(lock, { mode: 0o700 });
				await chmod(lock, 0o700);
				const owner: LockOwner = { pid: process.pid, token: crypto.randomUUID() };
				try {
					await writeFile(ownerPath, JSON.stringify(owner), { encoding: "utf8", mode: 0o600, flag: "wx", signal });
					await chmod(ownerPath, 0o600);
				} catch (cause) {
					await rm(lock, { recursive: true, force: true });
					throw cause;
				}
				return async () => {
					try {
						const current = JSON.parse(await readFile(ownerPath, "utf8")) as Partial<LockOwner>;
						if (current.pid === owner.pid && current.token === owner.token) await rm(lock, { recursive: true, force: true });
					} catch (cause) {
						if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
					}
				};
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
				try {
					const metadata = await lstat(lock);
					if (Date.now() - metadata.mtimeMs > STALE_LOCK_MS) {
						let owner: Partial<LockOwner> | undefined;
						try { owner = JSON.parse(await readFile(ownerPath, "utf8")) as Partial<LockOwner>; }
						catch (ownerCause) {
							if ((ownerCause as NodeJS.ErrnoException).code !== "ENOENT") owner = undefined;
						}
						const validOwner = owner !== undefined
							&& Number.isInteger(owner.pid) && (owner.pid ?? 0) > 0
							&& typeof owner.token === "string" && isUuid(owner.token);
						if (!validOwner || !processIsAlive(owner!.pid!)) {
							await rm(lock, { recursive: true, force: true });
							continue;
						}
					}
				} catch (inspectCause) {
					if ((inspectCause as NodeJS.ErrnoException).code !== "ENOENT") throw inspectCause;
				}
				if (Date.now() >= deadline) throw new Error("Timed out acquiring the coordination ledger lock.");
				await abortableSleep(LOCK_RETRY_MS, signal);
			}
		}
	}
}

export { CoordinationLedger as CoordinationStore };

export function sameTargetIdentity(left: TargetIdentity, right: TargetIdentity): boolean {
	return left.instanceId === right.instanceId
		&& left.sessionId === right.sessionId
		&& left.windowId === right.windowId
		&& left.paneId === right.paneId;
}

/** Compare mutable pane diagnostics after the stable tmux identity matches. */
export function sameTargetRuntime(left: TerminalTarget, right: TerminalTarget): boolean {
	return left.environment === right.environment
		&& left.sessionId === right.sessionId
		&& left.windowId === right.windowId
		&& left.paneId === right.paneId
		&& left.cwd === right.cwd
		&& left.currentCommand === right.currentCommand
		&& left.dead === right.dead;
}

function pruneState(state: LedgerState): LedgerState {
	const activeRuns = state.runs.filter((run) => run.state !== "closed" && run.state !== "lost");
	const historicalRuns = state.runs
		.filter((run) => run.state === "closed" || run.state === "lost")
		.sort((left, right) => right.createdAt - left.createdAt)
		.slice(0, RETAINED_HISTORICAL_RUNS);
	const runs = [...activeRuns, ...historicalRuns].slice(0, MAX_RUNS);
	const retainedRunIds = new Set(runs.map((run) => run.runId));
	const activeRunIds = new Set(activeRuns.map((run) => run.runId));
	const activeWorks = state.works.filter((work) => activeRunIds.has(work.runId) && work.state === "active");
	const finished = state.works
		.filter((work) => retainedRunIds.has(work.runId) && work.state === "finished")
		.sort((left, right) => right.createdAt - left.createdAt);
	const latestFinishedByRun = new Map<string, ManagedWorkRecord>();
	for (const work of finished) if (!latestFinishedByRun.has(work.runId)) latestFinishedByRun.set(work.runId, work);
	const latestFinished = [...latestFinishedByRun.values()];
	const latestIds = new Set(latestFinished.map((work) => work.workId));
	const extraFinished = finished.filter((work) => !latestIds.has(work.workId)).slice(0, RETAINED_EXTRA_FINISHED_WORKS);
	const works = [...activeWorks, ...latestFinished, ...extraFinished].slice(0, MAX_WORKS);
	if (runs.length === state.runs.length && works.length === state.works.length
		&& runs.every((run, index) => run === state.runs[index]) && works.every((work, index) => work === state.works[index])) return state;
	return { ...state, runs, works };
}

function validRunRecord(value: unknown): value is ManagedRunRecord {
	if (!value || typeof value !== "object") return false;
	const candidate = value as ManagedRunRecord;
	return isUuid(candidate.runId)
		&& (candidate.agent === "pi" || candidate.agent === "codex" || candidate.agent === "claude" || candidate.agent === "opencode")
		&& /^%[0-9]+$/.test(candidate.controllerPaneId)
		&& typeof candidate.tokenHash === "string" && /^[0-9a-f]{64}$/i.test(candidate.tokenHash)
		&& (candidate.state === "starting" || candidate.state === "idle" || candidate.state === "busy" || candidate.state === "closing" || candidate.state === "closed" || candidate.state === "lost")
		&& (candidate.readiness === "starting" || candidate.readiness === "process_started" || candidate.readiness === "verified" || candidate.readiness === "unverified")
		&& typeof candidate.processStarted === "boolean"
		&& typeof candidate.verifiedWorkFinished === "boolean"
		&& validTargetIdentity(candidate.controllerTargetIdentity)
		&& Number.isSafeInteger(candidate.createdAt)
		&& optionalTimestamp(candidate.launchedAt)
		&& optionalTimestamp(candidate.closingAt)
		&& optionalTimestamp(candidate.closedAt)
		&& optionalTimestamp(candidate.lostAt)
		&& (candidate.closingAt === undefined || candidate.state === "closing")
		&& (candidate.closedAt === undefined || candidate.state === "closed")
		&& (candidate.lostAt === undefined || candidate.state === "lost")
		&& validModel(candidate.effectiveModel)
		&& validThinking(candidate.effectiveThinking)
		&& optionalBoundedString(candidate.sessionId)
		&& optionalBoundedString(candidate.sessionFile)
		&& validTarget(candidate.target)
		&& validTargetIdentity(candidate.targetIdentity);
}

function validWorkRecord(value: unknown): value is ManagedWorkRecord {
	if (!value || typeof value !== "object") return false;
	const candidate = value as ManagedWorkRecord;
	return isUuid(candidate.workId)
		&& isUuid(candidate.runId)
		&& /^%[0-9]+$/.test(candidate.controllerPaneId)
		&& validTargetIdentity(candidate.controllerTargetIdentity)
		&& candidate.controllerTargetIdentity.paneId === candidate.controllerPaneId
		&& /^%[0-9]+$/.test(candidate.workerPaneId)
		&& /^[0-9a-f]{64}$/i.test(candidate.promptHash)
		&& isUuid(candidate.deliveryId)
		&& (candidate.state === "active" || candidate.state === "finished")
		&& (candidate.input === "prompt" || candidate.input === "command")
		&& Number.isSafeInteger(candidate.createdAt)
		&& (candidate.outcome === undefined || candidate.outcome === "completed" || candidate.outcome === "blocked" || candidate.outcome === "failed")
		&& (candidate.text === undefined || (typeof candidate.text === "string" && boundManagedText(candidate.text).text === candidate.text))
		&& (candidate.resultDeliveryId === undefined || isUuid(candidate.resultDeliveryId))
		&& optionalTimestamp(candidate.resultReceivedAt)
		&& optionalTimestamp(candidate.workFinishedAt)
		&& optionalBoundedString(candidate.protocolFailure)
		&& validModel(candidate.effectiveModel)
		&& validThinking(candidate.effectiveThinking)
		&& optionalBoundedString(candidate.sessionId)
		&& optionalBoundedString(candidate.sessionFile)
		&& (candidate.truncated === undefined || typeof candidate.truncated === "boolean")
		&& (candidate.resultReceivedAt === undefined || (candidate.outcome !== undefined && candidate.text !== undefined && candidate.resultDeliveryId !== undefined))
		&& (candidate.protocolFailure === undefined || (candidate.resultReceivedAt === undefined && candidate.workFinishedAt !== undefined))
		&& (candidate.state !== "finished" || candidate.workFinishedAt !== undefined)
		&& (candidate.workFinishedAt === undefined || candidate.state === "finished");
}

function validTarget(value: unknown): value is TerminalTarget {
	if (typeof value !== "object" || value === null) return false;
	const target = value as TerminalTarget;
	return target.environment === "tmux"
		&& typeof target.sessionId === "string" && /^\$[0-9]+$/.test(target.sessionId)
		&& boundedString(target.sessionName, 256)
		&& typeof target.windowId === "string" && /^@[0-9]+$/.test(target.windowId)
		&& boundedString(target.windowName, 256)
		&& typeof target.paneId === "string" && /^%[0-9]+$/.test(target.paneId)
		&& boundedString(target.cwd, 4_096)
		&& boundedString(target.currentCommand, 4_096)
		&& typeof target.dead === "boolean";
}

function validTargetIdentity(value: unknown): value is TargetIdentity {
	if (typeof value !== "object" || value === null) return false;
	const identity = value as TargetIdentity;
	return typeof identity.instanceId === "string" && identity.instanceId.length > 0 && identity.instanceId.length <= 4_096
		&& typeof identity.sessionId === "string" && /^\$[0-9]+$/.test(identity.sessionId)
		&& typeof identity.windowId === "string" && /^@[0-9]+$/.test(identity.windowId)
		&& typeof identity.paneId === "string" && /^%[0-9]+$/.test(identity.paneId);
}

function validModel(value: AgentModelMetadata | undefined): boolean {
	return value === undefined || (typeof value === "object" && value !== null
		&& typeof value.provider === "string" && value.provider.length > 0 && value.provider.length <= 256
		&& typeof value.id === "string" && value.id.length > 0 && value.id.length <= 512);
}

function validThinking(value: ThinkingLevel | undefined): boolean {
	return value === undefined || value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function boundedString(value: unknown, maximum: number): value is string {
	return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximum && !/[\0\r\n]/.test(value);
}

function optionalBoundedString(value: string | undefined): boolean {
	return value === undefined || boundedString(value, 4_096);
}

function optionalTimestamp(value: number | undefined): boolean {
	return value === undefined || Number.isSafeInteger(value);
}

function replaceRun(state: LedgerState, next: ManagedRunRecord): LedgerState {
	return { ...state, runs: state.runs.map((run) => run.runId === next.runId ? next : run) };
}

function replaceWork(state: LedgerState, next: ManagedWorkRecord): ManagedWorkRecord[] {
	return state.works.map((work) => work.workId === next.workId ? next : work);
}

function processIsAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (cause) { return (cause as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = (): void => { clearTimeout(timer); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
		const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}
