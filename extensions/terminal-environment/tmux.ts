import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect, Exit } from "effect";
import { environmentError, errorMessage, type TerminalEnvironmentError } from "./errors.ts";
import { closeTargetKindFromId, type SpawnRequest, type TerminalAdapter, type TerminalTarget } from "./model.ts";
import { findExecutable, nodeCommandRunner, runCommand, type CommandResult, type CommandRunner } from "./process.ts";

const FIELD_SEPARATOR = "\u001f";
const RECORD_FORMAT = [
	"#{socket_path}", "#{pid}", "#{session_id}", "#{session_name}", "#{window_id}",
	"#{pane_id}", "#{window_name}", "#{pane_current_path}", "#{pane_current_command}", "#{pane_dead}",
].join(FIELD_SEPARATOR);
const TARGET_ID = /^[%@$][0-9]+$/;
const SHELL_COMMANDS = new Set(["bash", "dash", "elvish", "fish", "ksh", "nu", "sh", "tcsh", "xonsh", "zsh"]);

export interface TmuxAdapterOptions {
	readonly environment?: NodeJS.ProcessEnv;
	readonly runner?: CommandRunner;
	readonly tmuxExecutable?: string;
}

function stripTrailingNewline(value: string): string {
	return value.replace(/\r?\n$/, "");
}

interface ParsedTarget {
	readonly socketPath: string;
	readonly serverPid: number;
	readonly target: TerminalTarget;
}

function parseTarget(output: string): ParsedTarget | undefined {
	const rows = stripTrailingNewline(output).split("\n");
	if (rows.length !== 1) return undefined;
	const fields = rows[0]!.split(FIELD_SEPARATOR);
	if (fields.length !== 10) return undefined;
	const [socketPath, rawServerPid, sessionId, sessionName, windowId, paneId, windowName, cwd, currentCommand, dead] = fields;
	const serverPid = Number(rawServerPid);
	if (!socketPath || !path.isAbsolute(socketPath) || !Number.isSafeInteger(serverPid) || serverPid < 1 || !sessionId || !/^\$[0-9]+$/.test(sessionId)
		|| sessionName === undefined || !windowId || !/^@[0-9]+$/.test(windowId)
		|| !paneId || !/^%[0-9]+$/.test(paneId) || windowName === undefined || !cwd
		|| currentCommand === undefined || (dead !== "0" && dead !== "1")) return undefined;
	return {
		socketPath,
		serverPid,
		target: {
			environment: "tmux",
			sessionId,
			sessionName,
			windowId,
			windowName,
			paneId,
			cwd,
			currentCommand,
			dead: dead === "1",
		},
	};
}

function failedCommand(operation: string, result: CommandResult): TerminalEnvironmentError {
	return environmentError(operation, result.stderr.trim() || `tmux exited with code ${result.code}.`);
}

export class TmuxAdapter implements TerminalAdapter {
	readonly environment = "tmux" as const;

	private constructor(
		readonly socketPath: string,
		private readonly serverPid: number,
		readonly currentTarget: TerminalTarget,
		private readonly executable: string,
		private readonly runner: CommandRunner,
		private readonly processEnvironment: NodeJS.ProcessEnv,
	) {}

	get instanceId(): string { return `${this.socketPath}:${this.serverPid}`; }

	static detect(options: TmuxAdapterOptions = {}): Effect.Effect<TmuxAdapter | undefined, TerminalEnvironmentError> {
		const environment = options.environment ?? process.env;
		if (!environment.TMUX?.trim() || environment.HERDR_ENV === "1" || environment.CMUX_ENV === "1") return Effect.succeed(undefined);
		const runner = options.runner ?? nodeCommandRunner;
		return Effect.gen(function* () {
			const executable = options.tmuxExecutable ?? (yield* findExecutable("tmux", environment));
			const result = yield* runCommand(runner, executable, ["display-message", "-p", "-F", RECORD_FORMAT], "detect tmux", environment);
			if (result.code !== 0) return yield* failedCommand("detect tmux", result);
			const parsed = parseTarget(result.stdout);
			if (!parsed) return yield* environmentError("detect tmux", "tmux returned malformed current-target identity.");
			return new TmuxAdapter(parsed.socketPath, parsed.serverPid, parsed.target, executable, runner, environment);
		});
	}

	spawn(request: SpawnRequest, defaultCwd: string): Effect.Effect<TerminalTarget, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			const kind = request.kind ?? "window";
			const cwd = request.cwd ?? defaultCwd;
			if (/[\0\r\n\u001f]/.test(cwd) || (request.title !== undefined && /[\0\r\n\u001f]/.test(request.title))) {
				return yield* environmentError(`spawn tmux ${kind}`, "cwd and title must not contain terminal control delimiters.");
			}
			let args: string[];
			if (kind === "session") {
				if (request.targetId) return yield* environmentError("spawn tmux session", "A new tmux session cannot have targetId.");
				args = ["new-session", "-d", "-P", "-F", RECORD_FORMAT, "-c", cwd];
				if (request.title) args.push("-s", request.title);
			} else if (kind === "window") {
				const parent = request.targetId ? (yield* self.resolve(request.targetId)).sessionId : self.currentTarget.sessionId;
				args = ["new-window", ...(request.focus ? [] : ["-d"]), "-P", "-F", RECORD_FORMAT, "-t", parent, "-c", cwd];
				if (request.title) args.push("-n", request.title);
			} else {
				const parent = request.targetId ? (yield* self.resolve(request.targetId)).paneId : self.currentTarget.paneId;
				args = ["split-window", ...(request.focus ? [] : ["-d"]), request.direction === "down" ? "-v" : "-h", "-P", "-F", RECORD_FORMAT, "-t", parent, "-c", cwd];
			}
			const result = yield* self.command(args, `spawn tmux ${kind}`);
			const target = yield* self.parseOwnedTarget(result.stdout, `spawn tmux ${kind}`);
			const postSpawn = kind === "session" && request.focus
				? self.command(["switch-client", "-t", target.sessionId], "focus tmux session")
				: kind === "pane" && request.title
					? self.command(["select-pane", "-T", request.title, "-t", target.paneId], "title tmux pane")
					: undefined;
			if (postSpawn) {
				const rollback = kind === "session"
					? self.command(["kill-session", "-t", target.sessionId], "rollback tmux session")
					: self.command(["kill-pane", "-t", target.paneId], "rollback tmux pane");
				yield* postSpawn.pipe(Effect.onExit((exit) => Exit.isSuccess(exit) ? Effect.void : rollback.pipe(Effect.ignore)));
			}
			return target;
		});
	}

	resolve(targetId: string): Effect.Effect<TerminalTarget, TerminalEnvironmentError> {
		if (!TARGET_ID.test(targetId)) return Effect.fail(environmentError("resolve tmux target", `Invalid tmux target ID: ${targetId}`));
		const self = this;
		return Effect.gen(function* () {
			const result = yield* self.command(["display-message", "-p", "-t", targetId, "-F", RECORD_FORMAT], "resolve tmux target");
			const target = yield* self.parseOwnedTarget(result.stdout, "resolve tmux target");
			const matches = targetId.startsWith("$") ? target.sessionId === targetId
				: targetId.startsWith("@") ? target.windowId === targetId
					: target.paneId === targetId;
			if (!matches) return yield* environmentError("resolve tmux target", `tmux resolved ${targetId} to a different target.`);
			return target;
		});
	}

	launch(target: TerminalTarget, launcherPath: string, cwd: string, replace: boolean, ownedByOperation: boolean): Effect.Effect<void, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			const verified = ownedByOperation ? target : (yield* self.resolve(target.paneId));
			if (verified.dead) return yield* environmentError("launch coding agent", `Target ${verified.paneId} has exited.`);
			if (!replace && !SHELL_COMMANDS.has(path.basename(verified.currentCommand))) {
				return yield* environmentError("launch coding agent", `Target ${verified.paneId} is busy with ${verified.currentCommand}; set replace=true to replace it.`);
			}
			yield* self.command(["respawn-pane", "-k", "-c", cwd, "-t", verified.paneId, launcherPath], "launch coding agent");
		});
	}

	closeSpawnedWindow(target: TerminalTarget): Effect.Effect<void, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			const verified = yield* self.resolve(target.windowId);
			if (verified.sessionId !== target.sessionId || verified.windowId !== target.windowId) {
				return yield* environmentError("rollback spawned tmux window", "Spawned window identity changed before rollback.");
			}
			yield* self.command(["kill-window", "-t", verified.windowId], "rollback spawned tmux window");
		});
	}

	close(targetId: string): Effect.Effect<TerminalTarget, TerminalEnvironmentError> {
		if (!/^[%@][0-9]+$/.test(targetId)) {
			return Effect.fail(environmentError("close tmux target", `Close requires a pane or window ID: ${targetId}`));
		}
		const self = this;
		return Effect.gen(function* () {
			const caller = yield* self.resolve(self.currentTarget.paneId);
			const target = yield* self.resolve(targetId);
			const kind = closeTargetKindFromId(targetId);
			const protectedTarget = kind === "window"
				? target.windowId === caller.windowId
				: target.paneId === caller.paneId;
			if (protectedTarget) {
				return yield* environmentError("close tmux target", `Refusing to close ${targetId} because it contains the calling pane ${caller.paneId}.`);
			}
			const command = kind === "window" ? "kill-window" : "kill-pane";
			yield* self.command([command, "-t", targetId], "close tmux target");
			return target;
		});
	}

	send(target: TerminalTarget, text: string, submit: boolean): Effect.Effect<void, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			const verified = yield* self.resolve(target.paneId);
			if (verified.dead) return yield* environmentError("send terminal input", `Target ${verified.paneId} has exited.`);
			const bufferName = `mepie-${crypto.randomUUID()}`;
			const directory = path.join(os.tmpdir(), "mepie-terminal-environment", `input-${crypto.randomUUID()}`);
			const inputPath = path.join(directory, "input.txt");
			yield* Effect.tryPromise({
				try: async (signal) => {
					await mkdir(directory, { recursive: true, mode: 0o700 });
					await chmod(directory, 0o700);
					await writeFile(inputPath, text, { encoding: "utf8", mode: 0o600, flag: "wx", signal });
					await chmod(inputPath, 0o600);
				},
				catch: (cause) => environmentError("prepare terminal input", errorMessage(cause), cause),
			});
			const delivery = Effect.gen(function* () {
				yield* self.command(["load-buffer", "-b", bufferName, inputPath], "load terminal input");
				yield* self.command(["paste-buffer", "-p", "-d", "-b", bufferName, "-t", verified.paneId], "paste terminal input");
				if (submit) yield* self.command(["send-keys", "-t", verified.paneId, "Enter"], "submit terminal input");
			});
			return yield* delivery.pipe(Effect.ensuring(Effect.promise(async () => {
				await self.runner.run(self.executable, ["-S", self.socketPath, "delete-buffer", "-b", bufferName], { env: self.processEnvironment }).catch(() => undefined);
				await rm(directory, { recursive: true, force: true }).catch(() => undefined);
			})));
		});
	}

	private command(args: readonly string[], operation: string): Effect.Effect<CommandResult, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			const result = yield* runCommand(self.runner, self.executable, ["-S", self.socketPath, ...args], operation, self.processEnvironment);
			if (result.code !== 0) return yield* failedCommand(operation, result);
			return result;
		});
	}

	private parseOwnedTarget(output: string, operation: string): Effect.Effect<TerminalTarget, TerminalEnvironmentError> {
		const parsed = parseTarget(output);
		if (!parsed) return Effect.fail(environmentError(operation, "tmux returned malformed target identity."));
		if (parsed.socketPath !== this.socketPath || parsed.serverPid !== this.serverPid) {
			return Effect.fail(environmentError(operation, "tmux target belongs to a different or restarted server."));
		}
		return Effect.succeed(parsed.target);
	}
}
