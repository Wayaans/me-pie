import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import type { PiLaunchProfile } from "../domain.ts";
import {
	buildLauncherScript,
	buildPiArguments,
	buildWorkerEnvironment,
	DEFAULT_TMUX_TIMEOUT_MS,
	nodeCommandRunner,
	quotePosixArgument,
	resolveExecutable,
	workflowRuntimeDirectory,
	writeOwnerOnlyLauncher,
} from "./command.ts";
import {
	ForeignTmuxHandleError,
	MissingTmuxError,
	TmuxCommandError,
	TmuxCommandTimeoutError,
	UnexpectedTmuxOutputError,
	VanishedTmuxSessionError,
	WorkerLaunchError,
	type TmuxCommandOptions,
	type TmuxCommandResult,
	type TmuxCommandRunner,
	type TmuxSessionIdentity,
	type TmuxWindowHandle,
} from "./types.ts";

const SESSION_FORMAT = "#{socket_path}\t#{session_id}\t#{session_name}\t#{pane_id}";
const WINDOW_FORMAT = "#{socket_path}\t#{session_id}\t#{session_name}\t#{window_id}\t#{pane_id}";
const OWNERSHIP_FORMAT = "#{socket_path}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_dead}\t#{@mepie_workflow_run_id}\t#{@mepie_workflow_item_id}";
const ID_PATTERN = /^\$\d+$/;
const WINDOW_PATTERN = /^@\d+$/;
const PANE_PATTERN = /^%\d+$/;

export interface CreateWorkerWindowInput {
	readonly runId: string;
	readonly workItemId: string;
	readonly title: string;
	readonly order: number;
	readonly cwd: string;
	readonly profile: PiLaunchProfile;
	readonly readOnly?: boolean;
	readonly kind?: "implementation" | "audit" | "fix";
	readonly socketPath: string;
	readonly token: string;
}

export interface TmuxControllerOptions {
	readonly runner?: TmuxCommandRunner;
	readonly environment?: NodeJS.ProcessEnv;
	readonly tmuxExecutable?: string;
	readonly piExecutable?: string;
	readonly packageRoot?: string;
	readonly commandTimeoutMs?: number;
	readonly closeTimeoutMs?: number;
	readonly pollIntervalMs?: number;
	readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface CloseWindowResult {
	readonly forced: boolean;
	readonly alreadyExited: boolean;
}

export interface TmuxWindowInspection {
	readonly state: "alive" | "exited" | "missing" | "foreign" | "ambiguous";
	readonly message?: string;
}

interface OwnershipRecord {
	readonly serverSocketPath: string;
	readonly sessionId: string;
	readonly windowId: string;
	readonly paneId: string;
	readonly paneDead: boolean;
	readonly runId: string;
	readonly workItemId: string;
}

async function removeLauncherRuntime(launcherPath: string): Promise<void> {
	await rm(launcherPath, { force: true }).catch(() => undefined);
	await rm(path.dirname(launcherPath), { recursive: true, force: true }).catch(() => undefined);
}

function effectTry<A>(operation: (signal: AbortSignal) => Promise<A>, mapError: (cause: unknown) => Error) {
	return Effect.tryPromise({ try: operation, catch: mapError });
}

export function sanitizeWindowName(order: number, workItemId: string, title = ""): string {
	const prefix = `tf-${String(order).padStart(2, "0")}`;
	const source = workItemId.trim() || title.trim() || "worker";
	const slug = source
		.normalize("NFKD")
		.replace(/[^A-Za-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase()
		.slice(0, 38)
		.replace(/-+$/g, "") || "worker";
	return `${prefix}-${slug}`.slice(0, 48);
}

function parseSession(output: string): TmuxSessionIdentity | undefined {
	const fields = output.trimEnd().split("\t");
	if (fields.length !== 4) return undefined;
	const [serverSocketPath, sessionId, sessionName, paneId] = fields;
	if (!serverSocketPath || !path.isAbsolute(serverSocketPath) || !sessionId || !ID_PATTERN.test(sessionId) || !sessionName || !paneId || !PANE_PATTERN.test(paneId)) return undefined;
	return { serverSocketPath, sessionId, sessionName, paneId };
}

export function parseCreatedWindow(output: string): Omit<TmuxWindowHandle, "runId" | "workItemId" | "displayName" | "socketPath"> | undefined {
	const fields = output.trimEnd().split("\t");
	if (fields.length !== 5) return undefined;
	const [serverSocketPath, sessionId, sessionName, windowId, paneId] = fields;
	if (!serverSocketPath || !path.isAbsolute(serverSocketPath) || !sessionId || !ID_PATTERN.test(sessionId) || !sessionName || !windowId || !WINDOW_PATTERN.test(windowId) || !paneId || !PANE_PATTERN.test(paneId)) {
		return undefined;
	}
	return { serverSocketPath, sessionId, sessionName, windowId, paneId };
}

function parseOwnership(output: string): OwnershipRecord | undefined {
	const fields = output.trimEnd().split("\t");
	if (fields.length !== 7) return undefined;
	const [serverSocketPath, sessionId, windowId, paneId, paneDead, runId, workItemId] = fields;
	if (!serverSocketPath || !path.isAbsolute(serverSocketPath) || !sessionId || !ID_PATTERN.test(sessionId) || !windowId || !WINDOW_PATTERN.test(windowId) || !paneId || !PANE_PATTERN.test(paneId) || (paneDead !== "0" && paneDead !== "1") || !runId || !workItemId) {
		return undefined;
	}
	return { serverSocketPath, sessionId, windowId, paneId, paneDead: paneDead === "1", runId, workItemId };
}

export class TmuxController {
	private readonly runner: TmuxCommandRunner;
	private readonly environment: NodeJS.ProcessEnv;
	private readonly commandTimeoutMs: number;
	private readonly closeTimeoutMs: number;
	private readonly pollIntervalMs: number;
	private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	private readonly packageRoot: string;
	private resolvedTmuxExecutable: string | undefined;
	private resolvedPiExecutable: string | undefined;

	constructor(private readonly options: TmuxControllerOptions = {}) {
		this.runner = options.runner ?? nodeCommandRunner;
		this.environment = options.environment ?? process.env;
		this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_TMUX_TIMEOUT_MS;
		this.closeTimeoutMs = options.closeTimeoutMs ?? 2_000;
		this.pollIntervalMs = options.pollIntervalMs ?? 100;
		this.sleep = options.sleep ?? ((milliseconds, signal) => new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", abort);
				resolve();
			}, milliseconds);
			const abort = () => {
				clearTimeout(timer);
				reject(signal.reason ?? new Error("Tmux close wait aborted."));
			};
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		}));
		this.packageRoot = options.packageRoot ?? fileURLToPath(new URL("../../../", import.meta.url));
		this.resolvedTmuxExecutable = options.tmuxExecutable;
		this.resolvedPiExecutable = options.piExecutable;
	}

	private resolveTmux() {
		return effectTry(async (signal) => {
			if (!this.environment.TMUX) throw new MissingTmuxError({ message: "Ticket Flow requires an active tmux client (TMUX is missing)." });
			this.resolvedTmuxExecutable ??= await resolveExecutable("tmux", this.environment.PATH, signal);
			if (!this.resolvedTmuxExecutable) throw new MissingTmuxError({ message: "The tmux executable was not found in PATH." });
			return this.resolvedTmuxExecutable;
		}, (cause) => cause instanceof Error ? cause : new MissingTmuxError({ message: String(cause) }));
	}

	private resolvePi() {
		return effectTry(async (signal) => {
			this.resolvedPiExecutable ??= await resolveExecutable("pi", this.environment.PATH, signal);
			if (!this.resolvedPiExecutable) throw new WorkerLaunchError({ message: "The Pi executable was not found in PATH." });
			return this.resolvedPiExecutable;
		}, (cause) => cause instanceof Error ? cause : new WorkerLaunchError({ message: String(cause), cause }));
	}

	private run(args: readonly string[], operation: string, options: Partial<TmuxCommandOptions> = {}) {
		return Effect.gen({ self: this }, function* () {
			const executable = yield* this.resolveTmux();
			const result = yield* effectTry(
				(signal) => this.runner.run(executable, args, {
					timeoutMs: options.timeoutMs ?? this.commandTimeoutMs,
					...(options.cwd === undefined ? {} : { cwd: options.cwd }),
					signal: options.signal ?? signal,
				}),
				(cause) => new TmuxCommandError({ operation, code: -1, stderr: cause instanceof Error ? cause.message : String(cause) }),
			);
			if (result.timedOut) return yield* Effect.fail(new TmuxCommandTimeoutError({ command: `tmux ${args[0] ?? ""}`, timeoutMs: options.timeoutMs ?? this.commandTimeoutMs }));
			return result;
		});
	}

	detect() {
		return Effect.gen({ self: this }, function* () {
			const version = yield* this.run(["-V"], "detect tmux");
			if (version.code !== 0 || !/^tmux\s+\S+/m.test(version.stdout)) {
				return yield* Effect.fail(new UnexpectedTmuxOutputError({ operation: "detect tmux", output: `${version.stdout}${version.stderr}` }));
			}
			const current = yield* this.run(["display-message", "-p", "-F", SESSION_FORMAT], "identify current tmux session");
			if (current.code !== 0) {
				return yield* Effect.fail(new VanishedTmuxSessionError({ message: current.stderr.trim() || "The current tmux session vanished." }));
			}
			const identity = parseSession(current.stdout);
			return identity ?? (yield* Effect.fail(new UnexpectedTmuxOutputError({ operation: "identify current tmux session", output: current.stdout })));
		});
	}

	private cleanupUnpersistedWindow(session: TmuxSessionIdentity, launcherPath: string) {
		return Effect.gen({ self: this }, function* () {
			const listed = yield* this.run([
				"list-panes", "-a", "-F",
				"#{socket_path}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_start_command}",
			], "locate unpersisted worker window");
			if (listed.code !== 0) return;
			const expectedCommands = new Set([launcherPath, quotePosixArgument(launcherPath)]);
			const matches = listed.stdout.trimEnd().split("\n").flatMap((line) => {
				const [serverSocketPath, sessionId, windowId, paneId, command, ...extra] = line.split("\t");
				if (extra.length > 0 || !serverSocketPath || !sessionId || !windowId || !paneId || command === undefined) return [];
				return serverSocketPath === session.serverSocketPath
					&& sessionId === session.sessionId
					&& WINDOW_PATTERN.test(windowId)
					&& PANE_PATTERN.test(paneId)
					&& expectedCommands.has(command)
					? [{ windowId }]
					: [];
			});
			if (matches.length !== 1) return;
			yield* this.run(["kill-window", "-t", matches[0]!.windowId], "clean up unpersisted worker window");
		}).pipe(Effect.catch(() => Effect.void));
	}

	createWorkerWindow(input: CreateWorkerWindowInput) {
		return Effect.gen({ self: this }, function* () {
			const session = yield* this.detect();
			const piExecutable = yield* this.resolvePi();
			const runtimeDirectory = workflowRuntimeDirectory(input.runId);
			const args = buildPiArguments(input.profile, this.packageRoot, input.readOnly === undefined ? {} : { readOnly: input.readOnly });
			const environment = buildWorkerEnvironment({
				runId: input.runId,
				workItemId: input.workItemId,
				profile: input.profile,
				// The durable plan currently exposes audit read-only-ness as the
				// launch flag. Carry the role separately so the worker never has to
				// infer it from its prompt or native context.
				kind: input.kind ?? (input.readOnly === true ? "audit" : input.workItemId.startsWith("fix-") ? "fix" : "implementation"),
				socketPath: input.socketPath,
				token: input.token,
			});
			const script = buildLauncherScript(piExecutable, args, environment);
			const launcherPath = yield* effectTry(
				(signal) => writeOwnerOnlyLauncher(runtimeDirectory, script, signal),
				(cause) => new WorkerLaunchError({ message: "Could not create the owner-only Pi launcher.", cause }),
			);
			const displayName = sanitizeWindowName(input.order, input.workItemId, input.title);
			const created = yield* this.run([
				"new-window", "-d", "-P", "-F", WINDOW_FORMAT,
				"-c", input.cwd, "-n", displayName, quotePosixArgument(launcherPath),
			], "create worker window").pipe(
				Effect.onError(() => effectTry(() => removeLauncherRuntime(launcherPath), () => new Error("launcher cleanup failed")).pipe(Effect.catch(() => Effect.void))),
			);
			if (created.code !== 0) {
				yield* effectTry(() => removeLauncherRuntime(launcherPath), () => new Error("launcher cleanup failed")).pipe(Effect.catch(() => Effect.void));
				if (/can't find session|no server running/i.test(created.stderr)) {
					return yield* Effect.fail(new VanishedTmuxSessionError({ sessionId: session.sessionId, message: created.stderr.trim() }));
				}
				return yield* Effect.fail(new TmuxCommandError({ operation: "create worker window", code: created.code, stderr: created.stderr }));
			}
			const parsed = parseCreatedWindow(created.stdout);
			if (!parsed || parsed.serverSocketPath !== session.serverSocketPath || parsed.sessionId !== session.sessionId) {
				yield* this.cleanupUnpersistedWindow(session, launcherPath);
				yield* effectTry(() => removeLauncherRuntime(launcherPath), () => new Error("launcher cleanup failed")).pipe(Effect.catch(() => Effect.void));
				return yield* Effect.fail(new UnexpectedTmuxOutputError({ operation: "create worker window", output: created.stdout }));
			}
			const handle: TmuxWindowHandle = {
				...parsed,
				runId: input.runId,
				workItemId: input.workItemId,
				displayName,
				socketPath: input.socketPath,
			};
			for (const [name, value] of [
				["@mepie_workflow_run_id", input.runId],
				["@mepie_workflow_item_id", input.workItemId],
			] as const) {
				const tagged = yield* this.run(["set-option", "-w", "-t", handle.windowId, name, value], "tag worker window");
				if (tagged.code !== 0) {
					yield* this.run(["kill-window", "-t", handle.windowId], "clean up untagged worker window").pipe(Effect.catch(() => Effect.void));
					return yield* Effect.fail(new TmuxCommandError({ operation: "tag worker window", code: tagged.code, stderr: tagged.stderr }));
				}
			}
			const observed = yield* this.inspect(handle);
			if (!observed) return yield* Effect.fail(new WorkerLaunchError({ message: "The Pi worker pane exited during startup." }));
			yield* this.assertOwned(handle, observed);
			if (observed.paneDead) {
				yield* this.run(["kill-window", "-t", handle.windowId], "clean up exited worker window").pipe(Effect.catch(() => Effect.void));
				return yield* Effect.fail(new WorkerLaunchError({ message: "The Pi worker pane exited during startup." }));
			}
			return handle;
		});
	}

	private inspect(handle: TmuxWindowHandle): Effect.Effect<OwnershipRecord | undefined, Error> {
		return Effect.gen({ self: this }, function* () {
			const result = yield* this.run(["display-message", "-p", "-t", handle.paneId, "-F", OWNERSHIP_FORMAT], "inspect worker window");
			if (result.code !== 0) return undefined;
			const ownership = parseOwnership(result.stdout);
			if (!ownership) return yield* Effect.fail(new UnexpectedTmuxOutputError({ operation: "inspect worker window", output: result.stdout }));
			return ownership;
		});
	}

	inspectWindow(handle: TmuxWindowHandle): Effect.Effect<TmuxWindowInspection> {
		return this.inspect(handle).pipe(
			Effect.map((ownership): TmuxWindowInspection => {
				if (!ownership) return { state: "missing" };
				const matches = ownership.serverSocketPath === handle.serverSocketPath
					&& ownership.sessionId === handle.sessionId
					&& ownership.windowId === handle.windowId
					&& ownership.paneId === handle.paneId
					&& ownership.runId === handle.runId
					&& ownership.workItemId === handle.workItemId;
				if (!matches) return { state: "foreign", message: "The recorded tmux ID now belongs to another window." };
				return { state: ownership.paneDead ? "exited" : "alive" };
			}),
			Effect.catch((cause) => Effect.succeed({ state: "ambiguous", message: cause instanceof Error ? cause.message : String(cause) } as const)),
		);
	}

	private assertOwned(handle: TmuxWindowHandle, ownership: OwnershipRecord) {
		const matches = ownership.serverSocketPath === handle.serverSocketPath
			&& ownership.sessionId === handle.sessionId
			&& ownership.windowId === handle.windowId
			&& ownership.paneId === handle.paneId
			&& ownership.runId === handle.runId
			&& ownership.workItemId === handle.workItemId;
		return matches
			? Effect.void
			: Effect.fail(new ForeignTmuxHandleError({ message: "The recorded tmux handle is stale or belongs to another workflow." }));
	}

	capturePane(handle: TmuxWindowHandle, lines: number) {
		return Effect.gen({ self: this }, function* () {
			const ownership = yield* this.inspect(handle);
			if (!ownership) return yield* Effect.fail(new VanishedTmuxSessionError({ sessionId: handle.sessionId, message: "The worker pane no longer exists." }));
			yield* this.assertOwned(handle, ownership);
			const captured = yield* this.run(["capture-pane", "-p", "-t", handle.paneId, "-S", `-${Math.max(1, Math.min(2_000, lines))}`], "capture worker pane");
			if (captured.code !== 0) return yield* Effect.fail(new TmuxCommandError({ operation: "capture worker pane", code: captured.code, stderr: captured.stderr }));
			return captured.stdout;
		});
	}

	closeWindow(handle: TmuxWindowHandle, force = false) {
		return Effect.gen({ self: this }, function* () {
			const initial = yield* this.inspect(handle);
			if (!initial) return { forced: false, alreadyExited: true } satisfies CloseWindowResult;
			yield* this.assertOwned(handle, initial);
			if (!force) {
				const interrupted = yield* this.run(["send-keys", "-t", handle.paneId, "C-c"], "interrupt worker process");
				if (interrupted.code !== 0) return { forced: false, alreadyExited: true } satisfies CloseWindowResult;
				const deadline = Date.now() + this.closeTimeoutMs;
				while (Date.now() < deadline) {
					yield* effectTry((signal) => this.sleep(this.pollIntervalMs, signal), (cause) => cause instanceof Error ? cause : new Error(String(cause)));
					if (!(yield* this.inspect(handle))) return { forced: false, alreadyExited: false } satisfies CloseWindowResult;
				}
			}
			const finalOwnership = yield* this.inspect(handle);
			if (!finalOwnership) return { forced: false, alreadyExited: false } satisfies CloseWindowResult;
			yield* this.assertOwned(handle, finalOwnership);
			const killed = yield* this.run(["kill-window", "-t", handle.windowId], "force close worker window");
			if (killed.code !== 0) return yield* Effect.fail(new TmuxCommandError({ operation: "force close worker window", code: killed.code, stderr: killed.stderr }));
			return { forced: true, alreadyExited: false } satisfies CloseWindowResult;
		});
	}
}
