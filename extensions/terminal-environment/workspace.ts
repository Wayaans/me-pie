import { realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Effect, Exit } from "effect";
import { buildAgentInvocation } from "./agents.ts";
import { CoordinationLedger, boundManagedText, hashManagedPrompt, sameTargetIdentity, sameTargetRuntime, type ManagedRunRecord, type ManagedWorkRecord } from "./coordination.ts";
import { environmentError, errorMessage, TerminalEnvironmentError } from "./errors.ts";
import { makeLauncher, removeLauncher } from "./launcher.ts";
import { createManagedLaunchContext, decodeManagedTaskInput, encodeManagedTaskInput, readManagedLaunchContext, managedLaunchEnvironment, managedPromptGuidance, snapshotFromWork, type ManagedLaunchContext, type ManagedSessionSnapshot } from "./managed.ts";
import { closeTargetKindFromId } from "./model.ts";
import type {
	AgentModelMetadata,
	CloseRequest,
	ManagedCloseRequest,
	ManagedResultSendRequest,
	ManagedResultSendResult,
	ManagedTaskSendRequest,
	ManagedTaskSendResult,
	ManagedWaitRequest,
	RawCloseRequest,
	RawSendRequest,
	RawWaitRequest,
	RunRequest,
	SendRequest,
	SpawnRequest,
	TerminalAdapter,
	ThinkingLevel,
	TerminalTarget,
	WaitRequest,
	WaitResult,
	WorkspaceRequest,
	WorkspaceResult,
} from "./model.ts";
import { targetIdentity } from "./model.ts";
import { findExecutable } from "./process.ts";
import { SignalStore } from "./signals.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_POLL_MS = 100;
const DEFAULT_READINESS_TIMEOUT_MS = 20_000;
const DEFAULT_READINESS_POLL_MS = 40;
const PROCESS_START_TIMEOUT_MS = 2_000;
const LAUNCHER_COMMANDS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const TERMINAL_ENVIRONMENT_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface ManagedPiSessionMetadata {
	readonly effectiveModel: AgentModelMetadata;
	readonly effectiveThinking?: ThinkingLevel;
	readonly sessionId?: string;
	readonly sessionFile?: string;
}

export interface WorkspaceOptions {
	readonly environment?: NodeJS.ProcessEnv;
	readonly agentExecutables?: Partial<Record<"pi" | "codex" | "claude" | "opencode", string>>;
	readonly signalStoreRoot?: string;
	readonly coordinationRoot?: string;
	readonly coordinationStoreRoot?: string;
	readonly waitPollMs?: number;
	readonly readinessTimeoutMs?: number;
	readonly readinessPollMs?: number;
	readonly now?: () => number;
}

export class Workspace {
	private readonly environment: NodeJS.ProcessEnv;
	private readonly signalStore: SignalStore;
	private readonly coordination: CoordinationLedger;
	private readonly waitPollMs: number;
	private readonly readinessTimeoutMs: number;
	private readonly readinessPollMs: number;
	private readonly now: () => number;
	private readonly signalStoreRoot: string | undefined;
	private readonly coordinationRoot: string | undefined;
	private readonly managedContext: ManagedLaunchContext | undefined;
	private boundManagedWorkId: string | undefined;

	constructor(
		private readonly adapter: TerminalAdapter,
		private readonly options: WorkspaceOptions = {},
	) {
		this.environment = options.environment ?? process.env;
		const managedContext = readManagedLaunchContext(this.environment);
		this.managedContext = managedContext;
		const configuredSignalRoot = managedContext?.signalStoreRoot ?? options.signalStoreRoot;
		this.signalStoreRoot = configuredSignalRoot === undefined ? undefined : path.resolve(configuredSignalRoot);
		this.signalStore = new SignalStore(adapter.instanceId, this.signalStoreRoot === undefined ? {} : { rootDirectory: this.signalStoreRoot });
		const configuredCoordinationRoot = managedContext?.coordinationRoot ?? options.coordinationRoot ?? options.coordinationStoreRoot;
		this.coordinationRoot = configuredCoordinationRoot === undefined
			? (this.signalStoreRoot === undefined ? undefined : path.join(this.signalStoreRoot, "coordination"))
			: path.resolve(configuredCoordinationRoot);
		this.coordination = new CoordinationLedger(adapter.instanceId, this.coordinationRoot === undefined ? {} : { rootDirectory: this.coordinationRoot });
		this.waitPollMs = options.waitPollMs ?? DEFAULT_WAIT_POLL_MS;
		this.readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
		this.readinessPollMs = options.readinessPollMs ?? DEFAULT_READINESS_POLL_MS;
		this.now = options.now ?? Date.now;
	}

	execute(request: WorkspaceRequest, defaultCwd: string): Effect.Effect<WorkspaceResult, TerminalEnvironmentError> {
		switch (request.action) {
			case "spawn": return this.spawn(request.request, defaultCwd);
			case "run": return this.run(request.request, defaultCwd);
			case "send": return this.send(request.request);
			case "wait": return this.wait(request.request);
			case "close": return this.close(request.request);
		}
	}

	/** Validate the private launch context and publish Pi's effective readiness. */
	initializeManagedWorker(metadata: ManagedPiSessionMetadata): Effect.Effect<boolean, TerminalEnvironmentError> {
		const context = this.managedContext;
		if (!context || context.agent !== "pi") return Effect.succeed(false);
		const current = this.adapter.currentTarget;
		if (context.instanceId !== this.adapter.instanceId || context.controllerPaneId === current.paneId
			|| !sameTargetIdentity(context.target, targetIdentity(this.adapter.instanceId, current))) {
			return Effect.fail(environmentError("initialize managed Pi worker", "Private launch context does not match the current tmux target."));
		}
		return Effect.gen(function* (this: Workspace) {
			const run = yield* this.coordination.getRun(context.runId);
			if (!run || run.agent !== "pi" || run.tokenHash !== context.tokenHash) {
				return yield* environmentError("initialize managed Pi worker", "Private launch context does not match the coordination ledger.");
			}
			const verified = yield* this.resolveManagedTarget(context.runId, current.paneId);
			if (verified.dead || !sameTargetIdentity(context.target, targetIdentity(this.adapter.instanceId, verified))) {
				yield* this.markLostIfPresent(context.runId);
				return yield* environmentError("initialize managed Pi worker", "Managed launch target is dead, stale, or reused.");
			}
			const activeWork = yield* this.coordination.getActiveWork(context.runId);
			if (activeWork && this.boundManagedWorkId !== activeWork.workId) {
				yield* this.coordination.rejectWork({
					runId: context.runId,
					workId: activeWork.workId,
					token: context.token,
					worker: targetIdentity(this.adapter.instanceId, verified),
				}, "Pi session restarted before the managed Work Cycle finished.");
			}
			yield* this.coordination.recordReadiness({
				runId: context.runId,
				token: context.token,
				target: targetIdentity(this.adapter.instanceId, verified),
				targetSnapshot: verified,
				...(metadata.effectiveModel === undefined ? {} : { effectiveModel: metadata.effectiveModel }),
				...(metadata.effectiveThinking === undefined ? {} : { effectiveThinking: metadata.effectiveThinking }),
				...(metadata.sessionId === undefined ? {} : { sessionId: metadata.sessionId }),
				...(metadata.sessionFile === undefined ? {} : { sessionFile: metadata.sessionFile }),
			});
			return true;
		}.bind(this));
	}

	revokeManagedReadiness(reason: string): Effect.Effect<void, TerminalEnvironmentError> {
		const context = this.managedContext;
		if (!context || context.agent !== "pi") return Effect.void;
		return Effect.gen(function* (this: Workspace) {
			const current = yield* this.adapter.resolve(this.adapter.currentTarget.paneId);
			const identity = targetIdentity(this.adapter.instanceId, current);
			if (current.dead || !sameTargetIdentity(context.target, identity)) return;
			yield* this.coordination.revokeReadiness({
				runId: context.runId,
				token: context.token,
				worker: identity,
			}, reason);
			this.boundManagedWorkId = undefined;
		}.bind(this));
	}

	/** Unwrap and bind private task input before Pi command or template expansion. */
	routeManagedInput(
		text: string,
		streamingBehavior: "steer" | "followUp" | undefined,
	): Effect.Effect<{ readonly kind: "unmanaged" | "rejected" } | { readonly kind: "accepted"; readonly text: string }, TerminalEnvironmentError> {
		const context = this.managedContext;
		const envelope = decodeManagedTaskInput(text);
		if (!envelope) return Effect.succeed({ kind: "unmanaged" });
		if (!context || context.agent !== "pi") return Effect.fail(environmentError("route managed task input", "Managed task input reached an unverified Pi process."));
		return Effect.gen(function* (this: Workspace) {
			const current = this.adapter.currentTarget;
			const verified = yield* this.resolveManagedTarget(context.runId, current.paneId);
			const identity = targetIdentity(this.adapter.instanceId, verified);
			if (context.instanceId !== this.adapter.instanceId || verified.dead || !sameTargetIdentity(context.target, identity)) {
				yield* this.markLostIfPresent(context.runId);
				return { kind: "rejected" } as const;
			}
			const run = yield* this.coordination.getRun(context.runId);
			const work = yield* this.coordination.getWork(context.runId, envelope.workId);
			if (!run || run.tokenHash !== context.tokenHash || !sameTargetRuntime(run.target, verified)
				|| !run.verifiedWorkFinished || run.state !== "busy" || !work || work.state !== "active") {
				if (run && !sameTargetRuntime(run.target, verified)) yield* this.markLostIfPresent(context.runId);
				return { kind: "rejected" } as const;
			}
			if (hashManagedPrompt(envelope.text) !== work.promptHash) {
				yield* this.coordination.rejectWork({
					runId: context.runId,
					workId: work.workId,
					token: context.token,
					worker: identity,
				}, "Managed task input failed its Work Cycle integrity check.");
				return { kind: "rejected" } as const;
			}
			if (streamingBehavior !== undefined) {
				yield* this.coordination.rejectWork({
					runId: context.runId,
					workId: work.workId,
					token: context.token,
					worker: identity,
				}, `Managed task was rejected because the Pi worker was already processing ${streamingBehavior} input.`);
				return { kind: "rejected" } as const;
			}
			this.boundManagedWorkId = work.workId;
			return { kind: "accepted", text: envelope.text } as const;
		}.bind(this));
	}

	/** Add worker guidance only to the exact Work Cycle bound by the raw input event. */
	managedPromptGuidance(): Effect.Effect<string | undefined, TerminalEnvironmentError> {
		const context = this.managedContext;
		const workId = this.boundManagedWorkId;
		if (!context || context.agent !== "pi" || workId === undefined) return Effect.succeed(undefined);
		return Effect.gen(function* (this: Workspace) {
			const run = yield* this.coordination.getRun(context.runId);
			const work = yield* this.coordination.getWork(context.runId, workId);
			if (!run || run.tokenHash !== context.tokenHash || run.state !== "busy" || !work || work.state !== "active") return undefined;
			return managedPromptGuidance();
		}.bind(this));
	}

	/** Map Pi's internal settled event to the public Work Finished fact. */
	finishManagedWork(): Effect.Effect<boolean, TerminalEnvironmentError> {
		const context = this.managedContext;
		const workId = this.boundManagedWorkId;
		if (!context || context.agent !== "pi" || workId === undefined) {
			this.boundManagedWorkId = undefined;
			return Effect.succeed(false);
		}
		return Effect.gen(function* (this: Workspace) {
			const current = this.adapter.currentTarget;
			const verified = yield* this.resolveManagedTarget(context.runId, current.paneId);
			if (context.instanceId !== this.adapter.instanceId || verified.dead || !sameTargetIdentity(context.target, targetIdentity(this.adapter.instanceId, verified))) {
				yield* this.markLostIfPresent(context.runId);
				this.boundManagedWorkId = undefined;
				return false;
			}
			const run = yield* this.coordination.getRun(context.runId);
			if (!run || run.tokenHash !== context.tokenHash || !sameTargetRuntime(run.target, verified) || run.state !== "busy") {
				if (run && !sameTargetRuntime(run.target, verified)) yield* this.markLostIfPresent(context.runId);
				this.boundManagedWorkId = undefined;
				return false;
			}
			yield* this.coordination.markWorkFinished({
				runId: context.runId,
				workId,
				token: context.token,
				worker: targetIdentity(this.adapter.instanceId, verified),
			});
			this.boundManagedWorkId = undefined;
			return true;
		}.bind(this));
	}

	private resolveManagedTarget(runId: string, paneId: string): Effect.Effect<TerminalTarget, TerminalEnvironmentError> {
		return this.adapter.resolve(paneId).pipe(Effect.catch((cause) =>
			this.markLostIfPresent(runId).pipe(Effect.flatMap(() => Effect.fail(cause)))));
	}

	private markLostIfPresent(runId: string): Effect.Effect<void, never> {
		return this.coordination.markLost(runId).pipe(Effect.catch(() => Effect.void));
	}

	managedSnapshot(): Effect.Effect<ManagedSessionSnapshot | undefined, TerminalEnvironmentError> {
		const context = this.managedContext;
		if (!context) return Effect.succeed(undefined);
		return Effect.gen(function* (this: Workspace) {
			const run = yield* this.coordination.getRun(context.runId);
			if (!run || run.tokenHash !== context.tokenHash) return undefined;
			const work = yield* this.coordination.getWork(context.runId);
			return snapshotFromWork({
				runId: run.runId,
				readiness: run.readiness === "starting" ? "unverified" : run.readiness,
				...(run.effectiveModel === undefined ? {} : { effectiveModel: run.effectiveModel }),
				...(run.effectiveThinking === undefined ? {} : { effectiveThinking: run.effectiveThinking }),
				...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
				...(run.sessionFile === undefined ? {} : { sessionFile: run.sessionFile }),
			}, work);
		}.bind(this));
	}

	private spawn(request: SpawnRequest, defaultCwd: string): Effect.Effect<WorkspaceResult, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			const cwd = yield* resolveCwd(request.cwd, defaultCwd);
			const target = yield* self.adapter.spawn({ ...request, cwd }, cwd);
			return { action: "spawn", target } as const;
		});
	}

	private run(request: RunRequest, defaultCwd: string): Effect.Effect<WorkspaceResult, TerminalEnvironmentError> {
		const self = this;
		let createdTarget: TerminalTarget | undefined;
		let launchedTarget: TerminalTarget | undefined;
		let runId: string | undefined;
		let launcherPath: string | undefined;
		let launchCompleted = false;
		const operation = Effect.gen(function* () {
			const cwd = yield* resolveCwd(request.cwd, defaultCwd);
			const invocation = yield* Effect.try({
				try: () => buildAgentInvocation(request),
				catch: (cause) => cause instanceof TerminalEnvironmentError
					? cause
					: environmentError("build agent invocation", errorMessage(cause), cause),
			});
			const executable = self.options.agentExecutables?.[invocation.agent]
				?? (yield* findExecutable(invocation.executableName, self.environment));
			const launchArgs = invocation.agent === "pi"
				? [...invocation.args, "-e", TERMINAL_ENVIRONMENT_PACKAGE_ROOT]
				: invocation.args;
			const spawnedTarget = request.targetId === undefined;
			const token = crypto.randomUUID();
			const target = request.targetId
				? (yield* self.adapter.resolve(request.targetId))
				: (yield* self.adapter.spawn({ kind: "window", cwd, title: invocation.agent }, cwd));
			if (spawnedTarget) createdTarget = target;
			if (target.paneId === self.adapter.currentTarget.paneId) {
				return yield* environmentError("run coding agent", `Refusing to replace the calling pane ${target.paneId}.`);
			}
			if (target.dead) return yield* environmentError("run coding agent", "Cannot launch into a dead tmux target.");
			runId = crypto.randomUUID();
			const launchContext = createManagedLaunchContext({
				runId,
				token,
				agent: invocation.agent,
				instanceId: self.adapter.instanceId,
				controllerPaneId: self.adapter.currentTarget.paneId,
				target,
				...(self.coordinationRoot === undefined ? {} : { coordinationRoot: self.coordinationRoot }),
				...(self.signalStoreRoot === undefined ? {} : { signalStoreRoot: self.signalStoreRoot }),
			});
			yield* self.coordination.createRun({
				runId,
				token,
				agent: invocation.agent,
				controllerPaneId: self.adapter.currentTarget.paneId,
				controllerTarget: targetIdentity(self.adapter.instanceId, self.adapter.currentTarget),
				target,
				instanceId: self.adapter.instanceId,
			});
			launcherPath = yield* makeLauncher(executable, launchArgs, managedLaunchEnvironment(launchContext));
			yield* self.adapter.launch(target, launcherPath, cwd, spawnedTarget || (request.replace ?? false), spawnedTarget);
			launchCompleted = true;
			launchedTarget = target;
			launchedTarget = yield* self.waitForProcessTarget(target.paneId);
			if (launchedTarget.dead || !sameTargetIdentity(targetIdentity(self.adapter.instanceId, launchedTarget), targetIdentity(self.adapter.instanceId, target))) {
				return yield* environmentError("run coding agent", "Managed launch target changed or exited before process start was recorded.");
			}
			yield* self.coordination.updateTarget({ runId, token, target: launchedTarget });
			const started = yield* self.coordination.markLaunched(runId);
			const ready = invocation.agent === "pi"
				? yield* self.waitForReadiness(runId)
				: started;
			return {
				action: "run",
				target: ready.target,
				agent: invocation.agent,
				executable,
				spawnedTarget,
				runId,
				readiness: ready.readiness === "starting" ? "unverified" : ready.readiness,
				capability: ready.verifiedWorkFinished ? "verified" : "unverified",
				lifecycle: ready.verifiedWorkFinished ? "verified" : "unverified",
				persistence: "durable",
				processStarted: ready.processStarted,
				verifiedWorkFinished: ready.verifiedWorkFinished,
				capabilities: {
					persistence: "durable",
					processStarted: ready.processStarted,
					verifiedWorkFinished: ready.verifiedWorkFinished,
				},
				...(ready.effectiveModel === undefined ? {} : { effectiveModel: ready.effectiveModel }),
				...(ready.effectiveThinking === undefined ? {} : { effectiveThinking: ready.effectiveThinking }),
				...(ready.sessionId === undefined ? {} : { sessionId: ready.sessionId }),
				...(ready.sessionFile === undefined ? {} : { sessionFile: ready.sessionFile }),
			} as const;
		});
		return operation.pipe(Effect.onExit((exit) => {
			if (Exit.isSuccess(exit)) return Effect.void;
			const markLost = runId === undefined ? Effect.void : self.coordination.markLost(runId).pipe(Effect.ignore);
			const remove = launcherPath === undefined ? Effect.void : removeLauncher(launcherPath).pipe(Effect.ignore);
			const close = createdTarget !== undefined
				? self.adapter.closeSpawnedWindow(createdTarget).pipe(Effect.ignore)
				: launchCompleted && launchedTarget !== undefined
					? Effect.gen(function* () {
						const current = yield* self.adapter.resolve(launchedTarget!.paneId);
						if (!sameTargetIdentity(targetIdentity(self.adapter.instanceId, current), targetIdentity(self.adapter.instanceId, launchedTarget!))) return;
						yield* self.adapter.close(current.paneId, current);
					}).pipe(Effect.ignore)
					: Effect.void;
			return markLost.pipe(Effect.flatMap(() => remove), Effect.flatMap(() => close));
		}));
	}

	private waitForProcessTarget(
		paneId: string,
		deadline = this.now() + PROCESS_START_TIMEOUT_MS,
	): Effect.Effect<TerminalTarget, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			const target = yield* self.adapter.resolve(paneId);
			if (target.dead || !LAUNCHER_COMMANDS.has(path.basename(target.currentCommand)) || self.now() >= deadline) return target;
			yield* Effect.sleep(Math.min(self.readinessPollMs, Math.max(1, deadline - self.now())));
			return yield* self.waitForProcessTarget(paneId, deadline);
		});
	}

	private waitForReadiness(
		runId: string,
		deadline = this.now() + this.readinessTimeoutMs,
	): Effect.Effect<ManagedRunRecord, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			const run = yield* self.coordination.getRun(runId);
			if (!run) return yield* environmentError("wait for managed Pi readiness", `Unknown Agent Run: ${runId}`);
			if (run.readiness === "verified" || self.now() >= deadline) return run;
			yield* Effect.sleep(Math.min(self.readinessPollMs, Math.max(1, deadline - self.now())));
			return yield* self.waitForReadiness(runId, deadline);
		});
	}

	private send(request: SendRequest): Effect.Effect<WorkspaceResult, TerminalEnvironmentError> {
		if ("kind" in request && request.kind === "task") return this.sendManagedTask(request);
		if ("kind" in request && request.kind === "result") return this.sendManagedResult(request);
		return this.sendRaw(request);
	}

	private sendRaw(request: RawSendRequest): Effect.Effect<WorkspaceResult, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			if ("runId" in request || "workId" in request || "outcome" in request || "kind" in request) return yield* environmentError("send raw input", "Managed-only send fields require an explicit managed kind.");
			const target = yield* self.adapter.resolve(request.targetId);
			const sourcePaneId = self.adapter.currentTarget.paneId;
			const replyAfterSequence = yield* self.signalStore.currentSequence(sourcePaneId);
			yield* self.adapter.send(target, request.text, request.submit ?? true);
			const sequence = yield* self.signalStore.signal(target.paneId, sourcePaneId);
			return {
				action: "send",
				target,
				sourcePaneId,
				deliveryId: crypto.randomUUID(),
				sequence,
				replyAfterSequence,
				bytes: Buffer.byteLength(request.text, "utf8"),
				input: request.input,
			} as const;
		});
	}

	private sendManagedTask(request: ManagedTaskSendRequest): Effect.Effect<WorkspaceResult, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			if (request.submit === false) return yield* environmentError("send managed task", "Managed tasks must submit a Pi turn; use raw send for paste-only input.");
			if (request.text.trim().length === 0) return yield* environmentError("send managed task", "Managed task text must contain non-whitespace input.");
			if ("targetId" in request) return yield* environmentError("send managed task", "Managed tasks resolve their target from runId; targetId is not accepted.");
			const sourceTarget = self.adapter.currentTarget;
			const sourcePaneId = sourceTarget.paneId;
			const sourceIdentity = targetIdentity(self.adapter.instanceId, sourceTarget);
			const run = yield* self.coordination.getRun(request.runId);
			if (!run) return yield* environmentError("send managed task", `Unknown Agent Run: ${request.runId}`);
			if (run.agent !== "pi" || run.readiness !== "verified" || !run.verifiedWorkFinished) {
				return yield* environmentError("send managed task", `Run ${request.runId} is not a verified Pi Agent Run and cannot accept managed tasks.`);
			}
			if (run.controllerPaneId !== sourcePaneId || !sameTargetIdentity(run.controllerTargetIdentity, sourceIdentity)) return yield* environmentError("send managed task", `Run ${request.runId} belongs to another controller target.`);
			const target = yield* self.resolveManagedTarget(request.runId, run.target.paneId);
			const resolvedIdentity = targetIdentity(self.adapter.instanceId, target);
			if (target.dead || !sameTargetIdentity(run.targetIdentity, resolvedIdentity) || !sameTargetRuntime(run.target, target)) {
				yield* self.markLostIfPresent(request.runId);
				return yield* environmentError("send managed task", target.dead
					? `Agent Run ${request.runId} target has exited.`
					: `Run ${request.runId} target identity or runtime diagnostics are stale or was reused.`);
			}
			const owned = yield* self.coordination.assertController(request.runId, sourcePaneId, sourceIdentity, resolvedIdentity);
			let reservedWork: ManagedWorkRecord | undefined;
			let deliveryAttempted = false;
			const reservation = Effect.gen(function* () {
				reservedWork = yield* self.coordination.beginWork({
					runId: owned.runId,
					controllerPaneId: sourcePaneId,
					controllerTarget: sourceIdentity,
					workerPaneId: target.paneId,
					targetSnapshot: target,
					input: request.input,
					text: request.text,
				});
				const transportText = yield* Effect.try({
					try: () => encodeManagedTaskInput({ workId: reservedWork!.workId, text: request.text }),
					catch: (cause) => environmentError("encode managed task input", errorMessage(cause), cause),
				});
				yield* Effect.sync(() => { deliveryAttempted = true; });
				yield* self.adapter.send(target, transportText, request.submit ?? true);
				return reservedWork;
			}).pipe(Effect.onExit((exit) => {
				if (Exit.isSuccess(exit) || reservedWork === undefined) return Effect.void;
				return deliveryAttempted
					? self.coordination.markLost(request.runId).pipe(Effect.ignore)
					: self.coordination.cancelWork(request.runId, reservedWork.workId).pipe(Effect.ignore);
			}));
			const work = yield* reservation;
			return {
				action: "send",
				target,
				sourcePaneId,
				deliveryId: work.deliveryId,
				bytes: Buffer.byteLength(request.text, "utf8"),
				input: request.input,
				kind: "task",
				runId: request.runId,
				workId: work.workId,
			} satisfies ManagedTaskSendResult;
		});
	}

	private sendManagedResult(_request: ManagedResultSendRequest): Effect.Effect<WorkspaceResult, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			if ("targetId" in _request || "runId" in _request || "workId" in _request) return yield* environmentError("send managed result", "Managed results infer all correlation from the private child turn binding.");
			const context = self.managedContext;
			const workId = self.boundManagedWorkId;
			if (!context || context.agent !== "pi") return yield* environmentError("send managed result", "Only a verified Pi launch context may send a managed result.");
			if (workId === undefined) return yield* environmentError("send managed result", "No managed Work Cycle is bound to the current Pi turn.");
			const current = self.adapter.currentTarget;
			const target = yield* self.resolveManagedTarget(context.runId, current.paneId);
			const identity = targetIdentity(self.adapter.instanceId, target);
			if (context.instanceId !== self.adapter.instanceId || target.dead || !sameTargetIdentity(context.target, identity)) {
				yield* self.markLostIfPresent(context.runId);
				return yield* environmentError("send managed result", "Managed result source is not the verified launch target.");
			}
			const run = yield* self.coordination.getRun(context.runId);
			if (!run || run.tokenHash !== context.tokenHash || !sameTargetRuntime(run.target, target) || !run.verifiedWorkFinished || run.state !== "busy") {
				if (run && !sameTargetRuntime(run.target, target)) yield* self.markLostIfPresent(context.runId);
				return yield* environmentError("send managed result", "Managed result launch context is not verified for an active Work Cycle.");
			}
			const bounded = boundManagedText(_request.text);
			const work = yield* self.coordination.recordResult({
				runId: context.runId,
				workId,
				token: context.token,
				worker: identity,
				outcome: _request.outcome,
				text: bounded.text,
			});
			if (work.resultDeliveryId === undefined || work.outcome === undefined || work.text === undefined) {
				return yield* environmentError("send managed result", "Managed result was not durably recorded.");
			}
			return {
				action: "send",
				target,
				sourcePaneId: target.paneId,
				deliveryId: work.resultDeliveryId,
				bytes: Buffer.byteLength(work.text, "utf8"),
				input: "prompt",
				kind: "result",
				runId: context.runId,
				workId: work.workId,
				outcome: work.outcome,
				resultReceived: true,
				workFinished: work.workFinishedAt !== undefined,
				text: work.text,
			} satisfies ManagedResultSendResult;
		});
	}

	private close(request: CloseRequest): Effect.Effect<WorkspaceResult, TerminalEnvironmentError> {
		if ("runId" in request) return this.closeManaged(request);
		return this.closeRaw(request);
	}

	private closeRaw(request: RawCloseRequest): Effect.Effect<WorkspaceResult, TerminalEnvironmentError> {
		if (!/^[%@][0-9]+$/.test(request.targetId)) {
			return Effect.fail(environmentError("close terminal target", `Close requires a pane or window ID: ${request.targetId}`));
		}
		const self = this;
		return Effect.gen(function* () {
			const target = yield* self.adapter.resolve(request.targetId);
			const kind = closeTargetKindFromId(request.targetId);
			const owner = yield* self.coordination.findOpenRunForTarget(targetIdentity(self.adapter.instanceId, target), kind === "window");
			if (owner) return yield* environmentError("close terminal target", `Target ${request.targetId} belongs to Agent Run ${owner.runId}; close it by runId.`);
			const closed = yield* self.adapter.close(request.targetId, kind === "pane" ? target : undefined);
			return { action: "close", kind, target: closed } as const;
		});
	}

	private closeManaged(request: ManagedCloseRequest): Effect.Effect<WorkspaceResult, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			const sourceTarget = self.adapter.currentTarget;
			const sourcePaneId = sourceTarget.paneId;
			const sourceIdentity = targetIdentity(self.adapter.instanceId, sourceTarget);
			const run = yield* self.coordination.getRun(request.runId);
			if (!run) return yield* environmentError("close managed Agent Run", `Unknown Agent Run: ${request.runId}`);
			if (run.state === "closed" || run.state === "lost" || run.state === "closing") return yield* environmentError("close managed Agent Run", `Run ${request.runId} is ${run.state}; refusing to close its possibly reused target.`);
			if (run.controllerPaneId !== sourcePaneId || !sameTargetIdentity(run.controllerTargetIdentity, sourceIdentity)) return yield* environmentError("close managed Agent Run", `Run ${request.runId} belongs to another controller target.`);
			const target = yield* self.resolveManagedTarget(request.runId, run.target.paneId);
			const resolvedIdentity = targetIdentity(self.adapter.instanceId, target);
			if (!sameTargetIdentity(run.targetIdentity, resolvedIdentity) || !sameTargetRuntime(run.target, target)) {
				yield* self.markLostIfPresent(request.runId);
				return yield* environmentError("close managed Agent Run", `Run ${request.runId} target identity or runtime diagnostics are stale or was reused; it was marked lost.`);
			}
			if (target.dead) {
				yield* self.markLostIfPresent(request.runId);
				return yield* environmentError("close managed Agent Run", `Agent Run ${request.runId} target has exited; it was marked lost.`);
			}
			const closeInput = { runId: request.runId, controllerPaneId: sourcePaneId, controllerTarget: sourceIdentity, target: resolvedIdentity } as const;
			// Reserve the run and install cleanup in one scope. Cancellation before a
			// close attempt restores it; cancellation during/after close marks it lost.
			let reserved = false;
			let closeAttempted = false;
			const closeReserved = Effect.gen(function* () {
				yield* self.coordination.markClosing(closeInput);
				reserved = true;
				const finalTarget = yield* self.resolveManagedTarget(request.runId, run.target.paneId);
				if (finalTarget.dead || !sameTargetIdentity(resolvedIdentity, targetIdentity(self.adapter.instanceId, finalTarget)) || !sameTargetRuntime(target, finalTarget)) {
					yield* self.markLostIfPresent(request.runId);
					return yield* environmentError("close managed Agent Run", `Agent Run ${request.runId} target changed before close; no pane was closed.`);
				}
				yield* Effect.sync(() => { closeAttempted = true; });
				yield* self.adapter.close(finalTarget.paneId, finalTarget);
				yield* self.coordination.markClosed(closeInput);
				return finalTarget;
			}).pipe(Effect.onExit((exit) => {
				if (Exit.isSuccess(exit) || !reserved) return Effect.void;
				return closeAttempted
					? self.markLostIfPresent(request.runId)
					: self.coordination.restoreClosing(request.runId).pipe(Effect.ignore);
			}));
			const finalTarget = yield* closeReserved;
			return {
				action: "close",
				kind: "pane",
				target: finalTarget,
				runId: request.runId,
			} as const;
		});
	}

	private wait(request: WaitRequest): Effect.Effect<WorkspaceResult, TerminalEnvironmentError> {
		if ("runId" in request) return this.waitManaged(request);
		return this.waitRaw(request);
	}

	private waitRaw(request: RawWaitRequest): Effect.Effect<WorkspaceResult, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			const target = yield* self.adapter.resolve(request.targetId);
			const current = yield* self.signalStore.currentSignal(target.paneId);
			const baseline = request.afterSequence ?? current.sequence;
			const startedAt = self.now();
			const deadline = startedAt + (request.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
			return yield* self.waitLoop(target, baseline, startedAt, deadline);
		});
	}

	private waitManaged(request: ManagedWaitRequest): Effect.Effect<WorkspaceResult, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			if ("targetId" in request || "afterSequence" in request) return yield* environmentError("wait for managed Work Cycle", "Managed waits use runId/workId and do not accept raw target sequence fields.");
			const sourceTarget = self.adapter.currentTarget;
			const sourcePaneId = sourceTarget.paneId;
			const sourceIdentity = targetIdentity(self.adapter.instanceId, sourceTarget);
			const run = yield* self.coordination.getRun(request.runId);
			if (!run) return yield* environmentError("wait for managed Work Cycle", `Unknown Agent Run: ${request.runId}`);
			if (run.controllerPaneId !== sourcePaneId || !sameTargetIdentity(run.controllerTargetIdentity, sourceIdentity)) return yield* environmentError("wait for managed Work Cycle", `Run ${request.runId} belongs to another controller target.`);
			const target = yield* self.resolveManagedTarget(request.runId, run.target.paneId);
			const resolvedIdentity = targetIdentity(self.adapter.instanceId, target);
			if (!sameTargetIdentity(run.targetIdentity, resolvedIdentity) || !sameTargetRuntime(run.target, target)) {
				yield* self.markLostIfPresent(request.runId);
				return yield* environmentError("wait for managed Work Cycle", `Run ${request.runId} target identity or runtime diagnostics are stale or was reused; it was marked lost.`);
			}
			if (target.dead) {
				yield* self.markLostIfPresent(request.runId);
				return yield* environmentError("wait for managed Work Cycle", `Agent Run ${request.runId} target has exited.`);
			}
			yield* self.coordination.assertController(request.runId, sourcePaneId, sourceIdentity, resolvedIdentity);
			const work = yield* self.coordination.getWork(request.runId, request.workId);
			if (!work) return yield* environmentError("wait for managed Work Cycle", `Run ${request.runId} has no Work Cycle.`);
			// Managed waits are ledger-only; raw inbox corruption or unrelated signals cannot wake or block them.
			const sequence = 0;
			const startedAt = self.now();
			const deadline = startedAt + (request.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
			return yield* self.waitManagedLoop(target, sequence, request.runId, work.workId, startedAt, deadline);
		});
	}

	private waitLoop(
		target: TerminalTarget,
		baseline: number,
		startedAt: number,
		deadline: number,
	): Effect.Effect<WaitResult, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			const poll = yield* self.signalStore.poll(target.paneId, baseline);
			const elapsedMs = Math.max(0, self.now() - startedAt);
			if (poll.signal !== undefined) {
				return {
					action: "wait",
					target,
					reason: "signaled",
					sourcePaneId: poll.signal.sourcePaneId,
					sequence: poll.signal.sequence,
					elapsedMs,
				} as const;
			}
			const remainingMs = deadline - self.now();
			if (remainingMs <= 0) return { action: "wait", target, reason: "timeout", sequence: poll.currentSequence, elapsedMs } as const;
			yield* Effect.sleep(Math.min(self.waitPollMs, remainingMs));
			return yield* self.waitLoop(target, baseline, startedAt, deadline);
		});
	}

	private waitManagedLoop(
		target: TerminalTarget,
		sequence: number,
		runId: string,
		workId: string,
		startedAt: number,
		deadline: number,
	): Effect.Effect<WaitResult, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			const currentTarget = yield* self.resolveManagedTarget(runId, target.paneId);
			const currentIdentity = targetIdentity(self.adapter.instanceId, currentTarget);
			const run = yield* self.coordination.getRun(runId);
			if (!run || !sameTargetIdentity(run.targetIdentity, currentIdentity) || currentTarget.dead || !sameTargetRuntime(run.target, currentTarget)) {
				yield* self.markLostIfPresent(runId);
				return yield* environmentError("wait for managed Work Cycle", `Agent Run ${runId} target is stale, reused, or dead.`);
			}
			const work = yield* self.coordination.getWork(runId, workId);
			if (!work) return yield* environmentError("wait for managed Work Cycle", `Unknown Work Cycle: ${workId}`);
			const elapsedMs = Math.max(0, self.now() - startedAt);
			if (work.workFinishedAt !== undefined && work.resultReceivedAt === undefined) {
				return {
					action: "wait",
					mode: "managed",
					reason: "protocol_failure",
					target: currentTarget,
					runId,
					workId,
					text: work.protocolFailure ?? "Work Finished was observed, but the Pi worker did not send Result Received for this Work Cycle.",
					protocolFailure: true,
					resultReceived: false,
					workFinished: true,
					sequence,
					elapsedMs,
				} as const;
			}
			if (work.resultReceivedAt !== undefined && work.workFinishedAt !== undefined && work.outcome !== undefined && work.text !== undefined) {
				return {
					action: "wait",
					mode: "managed",
					reason: "work_finished",
					target: currentTarget,
					runId,
					workId,
					outcome: work.outcome,
					text: work.text,
					metadata: managedMetadata(work, run),
					resultReceived: true,
					workFinished: true,
					sequence,
					elapsedMs,
				} as const;
			}
			const remainingMs = deadline - self.now();
			if (remainingMs <= 0) {
				return {
					action: "wait",
					mode: "managed",
					reason: "timeout",
					target: currentTarget,
					runId,
					workId,
					resultReceived: work.resultReceivedAt !== undefined,
					workFinished: work.workFinishedAt !== undefined,
					sequence,
					elapsedMs,
				} as const;
			}
			yield* Effect.sleep(Math.min(self.waitPollMs, remainingMs));
			return yield* self.waitManagedLoop(target, sequence, runId, workId, startedAt, deadline);
		});
	}
}

function managedMetadata(work: ManagedWorkRecord, run: ManagedRunRecord | undefined): {
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
} {
	const metadata: {
		controllerPaneId?: string;
		workerPaneId?: string;
		deliveryId: string;
		resultDeliveryId?: string;
		resultReceivedAt?: number;
		workFinishedAt?: number;
		effectiveModel?: AgentModelMetadata;
		effectiveThinking?: ThinkingLevel;
		sessionId?: string;
		sessionFile?: string;
		truncated?: boolean;
	} = {
		...(work.controllerPaneId === undefined ? {} : { controllerPaneId: work.controllerPaneId }),
		...(work.workerPaneId === undefined ? {} : { workerPaneId: work.workerPaneId }),
		deliveryId: work.deliveryId,
	};
	if (work.resultDeliveryId !== undefined) metadata.resultDeliveryId = work.resultDeliveryId;
	if (work.resultReceivedAt !== undefined) metadata.resultReceivedAt = work.resultReceivedAt;
	if (work.workFinishedAt !== undefined) metadata.workFinishedAt = work.workFinishedAt;
	const effectiveModel = work.effectiveModel ?? run?.effectiveModel;
	if (effectiveModel !== undefined) metadata.effectiveModel = effectiveModel;
	const effectiveThinking = work.effectiveThinking ?? run?.effectiveThinking;
	if (effectiveThinking !== undefined) metadata.effectiveThinking = effectiveThinking;
	const sessionId = work.sessionId ?? run?.sessionId;
	if (sessionId !== undefined) metadata.sessionId = sessionId;
	const sessionFile = work.sessionFile ?? run?.sessionFile;
	if (sessionFile !== undefined) metadata.sessionFile = sessionFile;
	if (work.truncated !== undefined) metadata.truncated = work.truncated;
	return metadata;
}

function resolveCwd(candidate: string | undefined, defaultCwd: string): Effect.Effect<string, TerminalEnvironmentError> {
	return Effect.tryPromise({
		try: async (signal) => {
			signal.throwIfAborted();
			const resolved = path.resolve(defaultCwd, candidate ?? defaultCwd);
			if (/[\0\r\n\u001f]/.test(resolved)) throw new Error("Working directory contains unsupported terminal control delimiters.");
			const canonical = await realpath(resolved);
			if (!(await stat(canonical)).isDirectory()) throw new Error(`${resolved} is not a directory.`);
			return canonical;
		},
		catch: (cause) => environmentError("resolve working directory", errorMessage(cause), cause),
	});
}
