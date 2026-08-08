import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Effect, Exit } from "effect";
import { buildAgentInvocation } from "./agents.ts";
import { environmentError, errorMessage, TerminalEnvironmentError } from "./errors.ts";
import { makeLauncher, removeLauncher } from "./launcher.ts";
import type {
	RunRequest,
	SendRequest,
	SpawnRequest,
	TerminalAdapter,
	WaitRequest,
	WaitResult,
	WorkspaceRequest,
	WorkspaceResult,
} from "./model.ts";
import { findExecutable } from "./process.ts";
import { SignalStore } from "./signals.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_POLL_MS = 100;

export interface WorkspaceOptions {
	readonly environment?: NodeJS.ProcessEnv;
	readonly agentExecutables?: Partial<Record<"pi" | "codex" | "claude" | "opencode", string>>;
	readonly signalStoreRoot?: string;
	readonly waitPollMs?: number;
	readonly now?: () => number;
}

export class Workspace {
	private readonly environment: NodeJS.ProcessEnv;
	private readonly signalStore: SignalStore;
	private readonly waitPollMs: number;
	private readonly now: () => number;

	constructor(
		private readonly adapter: TerminalAdapter,
		private readonly options: WorkspaceOptions = {},
	) {
		this.environment = options.environment ?? process.env;
		this.signalStore = new SignalStore(adapter.instanceId, options.signalStoreRoot === undefined ? {} : { rootDirectory: options.signalStoreRoot });
		this.waitPollMs = options.waitPollMs ?? DEFAULT_WAIT_POLL_MS;
		this.now = options.now ?? Date.now;
	}

	execute(request: WorkspaceRequest, defaultCwd: string): Effect.Effect<WorkspaceResult, TerminalEnvironmentError> {
		switch (request.action) {
			case "spawn": return this.spawn(request.request, defaultCwd);
			case "run": return this.run(request.request, defaultCwd);
			case "send": return this.send(request.request);
			case "wait": return this.wait(request.request);
		}
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
		return Effect.gen(function* () {
			const cwd = yield* resolveCwd(request.cwd, defaultCwd);
			const invocation = yield* Effect.try({
				try: () => buildAgentInvocation(request),
				catch: (cause) => cause instanceof TerminalEnvironmentError
					? cause
					: environmentError("build agent invocation", errorMessage(cause), cause),
			});
			const executable = self.options.agentExecutables?.[invocation.agent]
				?? (yield* findExecutable(invocation.executableName, self.environment));
			return yield* Effect.acquireUseRelease(
				makeLauncher(executable, invocation.args),
				(launcherPath) => {
					const spawnedTarget = request.targetId === undefined;
					let createdTarget: WaitResult["target"] | undefined;
					const launch = Effect.gen(function* () {
						const target = request.targetId
							? (yield* self.adapter.resolve(request.targetId))
							: (yield* self.adapter.spawn({ kind: "window", cwd, title: invocation.agent }, cwd));
						if (spawnedTarget) createdTarget = target;
						yield* self.adapter.launch(target, launcherPath, cwd, spawnedTarget || (request.replace ?? false), spawnedTarget);
						return { action: "run", target, agent: invocation.agent, executable, spawnedTarget } as const;
					});
					return launch.pipe(Effect.onExit((exit) => {
						if (Exit.isSuccess(exit) || !createdTarget) return Effect.void;
						return self.adapter.closeSpawnedWindow(createdTarget).pipe(Effect.ignore);
					}));
				},
				(launcherPath, exit) => Exit.isSuccess(exit) ? Effect.void : removeLauncher(launcherPath),
			);
		});
	}

	private send(request: SendRequest): Effect.Effect<WorkspaceResult, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			const target = yield* self.adapter.resolve(request.targetId);
			yield* self.adapter.send(target, request.text, request.submit ?? true);
			const sequence = yield* self.signalStore.signal(target.paneId);
			return {
				action: "send",
				target,
				deliveryId: crypto.randomUUID(),
				sequence,
				bytes: Buffer.byteLength(request.text, "utf8"),
				input: request.input,
			} as const;
		});
	}

	private wait(request: WaitRequest): Effect.Effect<WorkspaceResult, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			const target = yield* self.adapter.resolve(request.targetId);
			const current = yield* self.signalStore.currentSequence(target.paneId);
			const baseline = request.afterSequence ?? current;
			const startedAt = self.now();
			const deadline = startedAt + (request.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
			return yield* self.waitLoop(target, baseline, startedAt, deadline);
		});
	}

	private waitLoop(
		target: WaitResult["target"],
		baseline: number,
		startedAt: number,
		deadline: number,
	): Effect.Effect<WaitResult, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			const sequence = yield* self.signalStore.currentSequence(target.paneId);
			const elapsedMs = Math.max(0, self.now() - startedAt);
			if (sequence > baseline) return { action: "wait", target, reason: "signaled", sequence, elapsedMs };
			const inspected = yield* self.adapter.resolve(target.paneId).pipe(
				Effect.map((resolved) => ({ present: true as const, resolved })),
				Effect.catch((cause) => isMissingTarget(cause)
					? Effect.succeed({ present: false as const })
					: Effect.fail(cause)),
			);
			if (!inspected.present || inspected.resolved.dead) {
				return { action: "wait", target, reason: "target-exited", sequence, elapsedMs };
			}
			const remainingMs = deadline - self.now();
			if (remainingMs <= 0) return { action: "wait", target, reason: "timeout", sequence, elapsedMs };
			yield* Effect.sleep(Math.min(self.waitPollMs, remainingMs));
			return yield* self.waitLoop(target, baseline, startedAt, deadline);
		});
	}
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

function isMissingTarget(cause: TerminalEnvironmentError): boolean {
	return cause.operation === "resolve tmux target"
		&& /can't find (?:pane|window|session)|no server running|no current client/i.test(cause.message);
}
