import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnProcess } from "node:child_process";
import type { SerializedWorkerHandle, TmuxHandle } from "../model.ts";
import { exactModelParts, THINKING_LEVELS } from "../model.ts";
import type { BackendIdentity, SpawnInput, WorkerBackend, WorkerInspection } from "./backend.ts";
import { TicketflowBackendError, TicketflowValidationError } from "../errors.ts";

/**
 * The tmux user options are the ownership record.  They deliberately contain
 * no transport secret: a handle can therefore be safely reconstructed from
 * tmux's window list during recovery.
 */
export const TICKETFLOW_RUN_TAG = "@ticketflow_run_id" as const;
export const TICKETFLOW_ASSIGNMENT_TAG = "@ticketflow_assignment_id" as const;
export const TICKETFLOW_OPERATION_TAG = "@ticketflow_operation_id" as const;

const SESSION_FORMAT = "#{socket_path}\t#{session_id}\t#{session_name}\t#{pane_id}";
const NEW_WINDOW_FORMAT = "#{socket_path}\t#{session_id}\t#{session_name}\t#{window_id}\t#{pane_id}\t#{window_name}";
const WINDOW_LIST_FORMAT = `${NEW_WINDOW_FORMAT}\t#{pane_dead}\t#{${TICKETFLOW_RUN_TAG}}\t#{${TICKETFLOW_ASSIGNMENT_TAG}}\t#{${TICKETFLOW_OPERATION_TAG}}`;
const INSPECTION_FORMAT = `#{socket_path}\t#{session_id}\t#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_dead}\t#{${TICKETFLOW_RUN_TAG}}\t#{${TICKETFLOW_ASSIGNMENT_TAG}}\t#{${TICKETFLOW_OPERATION_TAG}}`;

const SESSION_ID = /^\$[0-9]+$/;
const WINDOW_ID = /^@[0-9]+$/;
const PANE_ID = /^%[0-9]+$/;
const CONTROL = /[\0\r\n]/;
const SAFE_ID = /^[^\0\t\r\n]+$/;
const DEFAULT_COMMAND_TIMEOUT_MS = 3_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

export interface TmuxCommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
	readonly timedOut?: boolean;
}

export interface TmuxCommandOptions {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
}

export interface TmuxCommandRunner {
	readonly run: (
		executable: string,
		args: readonly string[],
		options: TmuxCommandOptions,
	) => Promise<TmuxCommandResult>;
}

export interface TmuxBackendOptions {
	/** An injectable runner is useful for deterministic lifecycle tests. */
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

export const nodeTmuxCommandRunner: TmuxCommandRunner = {
	run(executable, args, options) {
		return new Promise((resolve, reject) => {
			const child = spawnProcess(executable, [...args], {
				cwd: options.cwd,
				env: options.env ?? process.env,
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
			});
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timedOut = false;
			const finish = (result: TmuxCommandResult): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				resolve(result);
			};
			const fail = (cause: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				reject(cause);
			};
			const abort = (): void => {
				child.kill("SIGTERM");
			};
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, options.timeoutMs);
			options.signal?.addEventListener("abort", abort, { once: true });
			if (options.signal?.aborted) abort();
			child.stdout.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
			child.stderr.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
			child.on("error", fail);
			child.on("close", (code) => finish({ stdout, stderr, code: code ?? -1, timedOut }));
		});
	},
};

function quotePosix(value: string): string {
	return value.length === 0 ? "''" : `'${value.replaceAll("'", `\'"'"\'`)}'`;
}

function safeRuntimeName(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80) || "run";
}

function launchMarker(operationId: string): string {
	return `tf-launch-${safeRuntimeName(operationId).slice(0, 32)}`;
}

function noAbortSignal(): AbortSignal {
	return new AbortController().signal;
}

function stripSingleTrailingNewline(value: string): string {
	if (value.endsWith("\n")) value = value.slice(0, -1);
	if (value.endsWith("\r")) value = value.slice(0, -1);
	return value;
}

function lines(value: string): readonly string[] {
	const stripped = stripSingleTrailingNewline(value);
	return stripped.length === 0 ? [] : stripped.split("\n");
}

function backendFailure(operation: string, message: string, cause?: unknown): TicketflowBackendError {
	return new TicketflowBackendError({
		operation,
		message,
		...(cause === undefined ? {} : { cause }),
	});
}

function invalid(field: string, message: string): TicketflowValidationError {
	return new TicketflowValidationError({ message, path: field });
}

function assertText(value: string, field: string, options: { readonly id?: boolean } = {}): void {
	if (!value || !value.trim()) throw invalid(field, `${field} must be non-empty.`);
	if (CONTROL.test(value) || (options.id === true && !SAFE_ID.test(value))) {
		throw invalid(field, `${field} contains unsupported control characters.`);
	}
}

function assertInput(input: SpawnInput, sessionFile?: string): void {
	assertText(input.cwd, "cwd");
	assertText(input.runId, "runId", { id: true });
	assertText(input.assignmentId, "assignmentId", { id: true });
	assertText(input.operationId, "operationId", { id: true });
	assertText(input.title, "title");
	assertText(input.socketPath, "socketPath");
	assertText(input.token, "token");
	if (!THINKING_LEVELS.includes(input.profile.thinking)) {
		throw invalid("profile.thinking", "Worker thinking level must be explicit and supported.");
	}
	try {
		const model = exactModelParts(input.profile.model);
		if (`${model.provider}/${model.model}` !== input.profile.model) throw new Error("not canonical");
	} catch (cause) {
		throw invalid("profile.model", cause instanceof Error ? cause.message : "Worker model is invalid.");
	}
	if (input.kind !== "implementation" && input.kind !== "audit" && input.kind !== "fix") {
		throw invalid("kind", "Worker assignment kind is invalid.");
	}
	if (sessionFile !== undefined) assertText(sessionFile, "sessionFile");
}

function validateHandle(handle: SerializedWorkerHandle): handle is TmuxHandle {
	return handle.backend === "tmux"
		&& typeof handle.serverSocketPath === "string"
		&& path.isAbsolute(handle.serverSocketPath)
		&& SESSION_ID.test(handle.sessionId)
		&& WINDOW_ID.test(handle.windowId)
		&& PANE_ID.test(handle.paneId)
		&& SAFE_ID.test(handle.runId)
		&& SAFE_ID.test(handle.assignmentId)
		&& SAFE_ID.test(handle.operationId)
		&& typeof handle.sessionName === "string"
		&& typeof handle.displayName === "string";
}

interface SessionIdentity {
	readonly serverSocketPath: string;
	readonly sessionId: string;
	readonly sessionName: string;
	readonly paneId: string;
}

interface WindowRecord {
	readonly serverSocketPath: string;
	readonly sessionId: string;
	readonly sessionName: string;
	readonly windowId: string;
	readonly paneId: string;
	readonly displayName: string;
	readonly paneDead: boolean;
	readonly runId: string;
	readonly assignmentId: string;
	readonly operationId: string;
}

function parseSession(output: string): SessionIdentity | undefined {
	const rows = lines(output);
	if (rows.length !== 1) return undefined;
	const fields = rows[0]!.split("\t");
	if (fields.length !== 4) return undefined;
	const [serverSocketPath, sessionId, sessionName, paneId] = fields;
	if (!serverSocketPath || !path.isAbsolute(serverSocketPath) || !sessionId || !SESSION_ID.test(sessionId) || !sessionName || !paneId || !PANE_ID.test(paneId)) return undefined;
	return { serverSocketPath, sessionId, sessionName, paneId };
}

function parseNewWindow(output: string): Omit<WindowRecord, "paneDead" | "runId" | "assignmentId" | "operationId"> | undefined {
	const rows = lines(output);
	if (rows.length !== 1) return undefined;
	const fields = rows[0]!.split("\t");
	if (fields.length !== 5 && fields.length !== 6) return undefined;
	const [serverSocketPath, sessionId, sessionName, windowId, paneId] = fields;
	const displayName = fields.length === 6 ? fields[5]! : "";
	if (!serverSocketPath || !path.isAbsolute(serverSocketPath) || !sessionId || !SESSION_ID.test(sessionId) || !sessionName || !windowId || !WINDOW_ID.test(windowId) || !paneId || !PANE_ID.test(paneId)) return undefined;
	return { serverSocketPath, sessionId, sessionName, windowId, paneId, displayName };
}

function parseWindow(output: string): WindowRecord | undefined {
	const rows = lines(output);
	if (rows.length !== 1) return undefined;
	const fields = rows[0]!.split("\t");
	// The nine-field spelling is also accepted for tmux versions/tests which
	// omit window_name.  Window name is presentation only, never ownership.
	if (fields.length !== 9 && fields.length !== 10) return undefined;
	const [serverSocketPath, sessionId, sessionName, windowId, paneId] = fields;
	const displayName = fields.length === 10 ? fields[5] : "";
	const offset = fields.length === 10 ? 6 : 5;
	const paneDead = fields[offset];
	const runId = fields[offset + 1];
	const assignmentId = fields[offset + 2];
	const operationId = fields[offset + 3];
	if (!serverSocketPath || !path.isAbsolute(serverSocketPath) || !sessionId || !SESSION_ID.test(sessionId) || !sessionName || !windowId || !WINDOW_ID.test(windowId) || !paneId || !PANE_ID.test(paneId) || displayName === undefined || (paneDead !== "0" && paneDead !== "1") || runId === undefined || assignmentId === undefined || operationId === undefined) return undefined;
	return {
		serverSocketPath,
		sessionId,
		sessionName,
		windowId,
		paneId,
		displayName,
		paneDead: paneDead === "1",
		runId,
		assignmentId,
		operationId,
	};
}

function handleFromWindow(window: Pick<WindowRecord, "serverSocketPath" | "sessionId" | "sessionName" | "windowId" | "paneId" | "displayName">, input: Pick<SpawnInput, "runId" | "assignmentId" | "operationId">): TmuxHandle {
	return {
		backend: "tmux",
		serverSocketPath: window.serverSocketPath,
		sessionId: window.sessionId,
		sessionName: window.sessionName,
		windowId: window.windowId,
		paneId: window.paneId,
		runId: input.runId,
		assignmentId: input.assignmentId,
		operationId: input.operationId,
		displayName: window.displayName,
	};
}

function ownershipMatches(window: WindowRecord, handle: TmuxHandle): boolean {
	return window.serverSocketPath === handle.serverSocketPath
		&& window.sessionId === handle.sessionId
		&& window.sessionName === handle.sessionName
		&& window.windowId === handle.windowId
		&& window.paneId === handle.paneId
		&& window.runId === handle.runId
		&& window.assignmentId === handle.assignmentId
		&& window.operationId === handle.operationId;
}

function windowTarget(handle: TmuxHandle): string {
	return `${handle.sessionId}:${handle.windowId}`;
}

function paneTarget(handle: TmuxHandle): string {
	return `${handle.sessionId}:${handle.windowId}.${handle.paneId}`;
}

function launcherScript(
	piExecutable: string,
	args: readonly string[],
	environment: Readonly<Record<string, string>>,
): string {
	const exports = Object.entries(environment).map(([key, value]) => `export ${key}=${quotePosix(value)}`);
	return [
		"#!/bin/sh",
		"set -eu",
		"launcher=$0",
		"runtime_dir=${launcher%/*}",
		"rm -f -- \"$launcher\"",
		"rmdir -- \"$runtime_dir\" 2>/dev/null || true",
		...exports,
		`exec ${[piExecutable, ...args].map(quotePosix).join(" ")}`,
		"",
	].join("\n");
}

async function makeLauncher(runId: string, script: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const directory = path.join(os.tmpdir(), "ticketflow-tmux", `${safeRuntimeName(runId)}-${crypto.randomUUID()}`);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		await chmod(directory, 0o700);
		const launcher = path.join(directory, "launch.sh");
		await writeFile(launcher, script, { encoding: "utf8", mode: 0o700, flag: "wx", signal });
		await chmod(launcher, 0o700);
		return launcher;
	} catch (cause) {
		await rm(directory, { recursive: true, force: true }).catch(() => undefined);
		throw cause;
	}
}

async function removeLauncher(launcher: string): Promise<void> {
	await rm(launcher, { force: true }).catch(() => undefined);
	await rm(path.dirname(launcher), { recursive: true, force: true }).catch(() => undefined);
}

async function findExecutable(name: string, searchPath: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
	signal?.throwIfAborted();
	for (const directory of (searchPath ?? "").split(path.delimiter)) {
		if (!directory) continue;
		const candidate = path.join(directory, name);
		try {
			await access(candidate, fsConstants.X_OK);
			return path.resolve(candidate);
		} catch {
			// Keep searching PATH.
		}
	}
	return undefined;
}

export class TmuxWorkerBackend implements WorkerBackend {
	private readonly runner: TmuxCommandRunner;
	private readonly environment: NodeJS.ProcessEnv;
	private readonly commandTimeoutMs: number;
	private readonly closeTimeoutMs: number;
	private readonly pollIntervalMs: number;
	private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	private readonly packageRoot: string;
	private tmuxPath: string | undefined;
	private piPath: string | undefined;

	public constructor(options: TmuxBackendOptions = {}) {
		this.runner = options.runner ?? nodeTmuxCommandRunner;
		this.environment = options.environment ?? process.env;
		this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
		this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.sleep = options.sleep ?? ((milliseconds, signal) => new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", abort);
				resolve();
			}, milliseconds);
			const abort = (): void => {
				clearTimeout(timer);
				reject(signal.reason ?? new Error("Ticket Flow tmux wait aborted."));
			};
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		}));
		this.packageRoot = options.packageRoot ?? fileURLToPath(new URL("../../../", import.meta.url));
		this.tmuxPath = options.tmuxExecutable;
		this.piPath = options.piExecutable;
	}

	private async resolveTmux(signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted();
		if (!this.environment.TMUX) throw backendFailure("validate tmux", "Ticket Flow requires a functioning current tmux session (TMUX is missing).");
		if (this.tmuxPath) return this.tmuxPath;
		this.tmuxPath = await findExecutable("tmux", this.environment.PATH, signal);
		if (!this.tmuxPath) throw backendFailure("validate tmux", "The tmux executable was not found in PATH.");
		return this.tmuxPath;
	}

	private async resolvePi(signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted();
		if (this.piPath) return this.piPath;
		this.piPath = await findExecutable("pi", this.environment.PATH, signal);
		if (!this.piPath) throw backendFailure("launch worker", "The Pi executable was not found in PATH.");
		return this.piPath;
	}

	private async command(args: readonly string[], operation: string, signal?: AbortSignal): Promise<TmuxCommandResult> {
		signal?.throwIfAborted();
		const executable = await this.resolveTmux(signal);
		let result: TmuxCommandResult;
		try {
			result = await this.runner.run(executable, args, {
				env: this.environment,
				timeoutMs: this.commandTimeoutMs,
				...(signal === undefined ? {} : { signal }),
			});
		} catch (cause) {
			if (signal?.aborted) signal.throwIfAborted();
			throw backendFailure(operation, cause instanceof Error ? cause.message : String(cause), cause);
		}
		signal?.throwIfAborted();
		if (result.timedOut) throw backendFailure(operation, `tmux command timed out after ${this.commandTimeoutMs}ms.`);
		return result;
	}

	private commandOnServer(serverSocketPath: string, args: readonly string[], operation: string, signal?: AbortSignal): Promise<TmuxCommandResult> {
		if (!path.isAbsolute(serverSocketPath) || CONTROL.test(serverSocketPath)) throw backendFailure(operation, "Persisted tmux server socket path is invalid.");
		return this.command(["-S", serverSocketPath, ...args], operation, signal);
	}

	private async currentSession(signal?: AbortSignal): Promise<SessionIdentity> {
		const result = await this.command(["display-message", "-p", "-F", SESSION_FORMAT], "identify current tmux session", signal);
		if (result.code !== 0) throw backendFailure("identify current tmux session", result.stderr.trim() || "The current tmux session is not functioning.");
		const session = parseSession(result.stdout);
		if (!session) throw backendFailure("identify current tmux session", "tmux returned malformed current-session identity.");
		return session;
	}

	public async identify(signal?: AbortSignal): Promise<BackendIdentity> {
		const current = await this.currentSession(signal);
		return { serverSocketPath: current.serverSocketPath, sessionId: current.sessionId, sessionName: current.sessionName };
	}

	public async validate(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		await this.resolveTmux(signal);
		const version = await this.command(["-V"], "validate tmux", signal);
		if (version.code !== 0 || !/^tmux\s+\S+/m.test(version.stdout)) {
			throw backendFailure("validate tmux", version.stderr.trim() || "The tmux executable did not return a valid version.");
		}
		await this.currentSession(signal);
		await this.resolvePi(signal);
	}

	private async listWindows(serverSocketPath: string, signal?: AbortSignal): Promise<readonly WindowRecord[]> {
		const result = await this.commandOnServer(serverSocketPath, ["list-windows", "-a", "-F", WINDOW_LIST_FORMAT], "reconcile worker windows", signal);
		if (result.code !== 0) throw backendFailure("reconcile worker windows", result.stderr.trim() || "Could not list tmux windows.");
		const rows = lines(result.stdout);
		const records: WindowRecord[] = [];
		for (const row of rows) {
			const record = parseWindow(`${row}\n`);
			if (!record) throw backendFailure("reconcile worker windows", "tmux returned malformed window ownership data.");
			records.push(record);
		}
		return records;
	}

	private async inspectWindowRecord(handle: TmuxHandle, signal?: AbortSignal): Promise<WindowRecord | undefined> {
		const result = await this.commandOnServer(handle.serverSocketPath, ["display-message", "-p", "-t", handle.paneId, "-F", WINDOW_LIST_FORMAT], "inspect launch intent", signal);
		if (result.code !== 0) return undefined;
		return parseWindow(result.stdout);
	}

	private async reconcile(input: SpawnInput, current: SessionIdentity, signal?: AbortSignal): Promise<TmuxHandle | undefined> {
		const marker = launchMarker(input.operationId);
		const matches = (await this.listWindows(current.serverSocketPath, signal)).filter((window) => {
			if (window.sessionId !== current.sessionId || window.sessionName !== current.sessionName) return false;
			const exact = window.runId === input.runId && window.assignmentId === input.assignmentId && window.operationId === input.operationId;
			const partial = window.displayName === marker
				&& (window.runId === "" || window.runId === input.runId)
				&& (window.assignmentId === "" || window.assignmentId === input.assignmentId)
				&& (window.operationId === "" || window.operationId === input.operationId);
			return exact || partial;
		});
		if (matches.length > 1) throw backendFailure("reconcile worker windows", "Multiple tmux windows match the durable Ticket Flow launch intent.");
		const match = matches[0];
		if (match === undefined) return undefined;
		const handle = handleFromWindow(match, input);
		const fresh = await this.inspectWindowRecord(handle, signal);
		if (!fresh || fresh.serverSocketPath !== match.serverSocketPath || fresh.sessionId !== match.sessionId || fresh.sessionName !== match.sessionName || fresh.windowId !== match.windowId || fresh.paneId !== match.paneId || fresh.displayName !== match.displayName || fresh.runId !== match.runId || fresh.assignmentId !== match.assignmentId || fresh.operationId !== match.operationId) {
			throw backendFailure("reconcile worker windows", "Launch-intent window identity changed before ownership could be completed.");
		}
		if (match.runId !== input.runId || match.assignmentId !== input.assignmentId || match.operationId !== input.operationId) await this.setOwnership(handle, input, signal);
		if (match.paneDead) {
			await this.killIfOwned(handle, undefined);
			return undefined;
		}
		await this.renameOwnedWindow(handle, input.title, signal);
		const verified = await this.inspect(handle, signal);
		if (verified.state !== "alive") {
			if (verified.state === "foreign" || verified.state === "ambiguous") throw backendFailure("reconcile worker windows", verified.message);
			throw backendFailure("reconcile worker windows", `Recovered Worker is ${verified.state}.`);
		}
		return { ...handle, displayName: input.title };
	}

	private async setOwnership(handle: TmuxHandle, input: Pick<SpawnInput, "runId" | "assignmentId" | "operationId">, signal?: AbortSignal): Promise<void> {
		const tags: readonly [string, string][] = [
			[TICKETFLOW_RUN_TAG, input.runId],
			[TICKETFLOW_ASSIGNMENT_TAG, input.assignmentId],
			[TICKETFLOW_OPERATION_TAG, input.operationId],
		];
		for (const [tag, value] of tags) {
			const result = await this.commandOnServer(handle.serverSocketPath, ["set-option", "-w", "-t", windowTarget(handle), tag, value], "tag worker window", signal);
			if (result.code !== 0) throw backendFailure("tag worker window", result.stderr.trim() || `Could not set ${tag}.`);
		}
	}

	private async renameOwnedWindow(handle: TmuxHandle, title: string, signal?: AbortSignal): Promise<void> {
		const renamed = await this.commandOnServer(handle.serverSocketPath, ["rename-window", "-t", windowTarget(handle), title], "rename worker window", signal);
		if (renamed.code !== 0) throw backendFailure("rename worker window", renamed.stderr.trim() || "Could not rename the verified worker window.");
	}

	private buildHandle(created: Omit<WindowRecord, "paneDead" | "runId" | "assignmentId" | "operationId">, input: SpawnInput, current: SessionIdentity): TmuxHandle {
		if (created.serverSocketPath !== current.serverSocketPath || created.sessionId !== current.sessionId) {
			throw backendFailure("create worker window", "tmux created the worker outside the current functioning session.");
		}
		return handleFromWindow({ ...created, displayName: created.displayName || input.title.trim() }, input);
	}

	private async launch(input: SpawnInput, resuming: boolean, sessionFile: string | undefined, signal?: AbortSignal): Promise<SerializedWorkerHandle> {
		assertInput(input, sessionFile);
		if (resuming && sessionFile === undefined) throw invalid("sessionFile", "A persisted session file is required to reopen a Worker.");
		signal?.throwIfAborted();
		// Establish the current client session before reconciliation.  A stale
		// launch intent must never make a vanished/non-current tmux client look
		// healthy.
		const current = await this.currentSession(signal);
		if (input.backendIdentity && (input.backendIdentity.serverSocketPath !== current.serverSocketPath || input.backendIdentity.sessionId !== current.sessionId || input.backendIdentity.sessionName !== current.sessionName)) throw backendFailure("launch worker", "Current tmux identity differs from the persisted launch intent.");
		const existing = await this.reconcile(input, current, signal);
		if (existing) return existing;
		const piExecutable = await this.resolvePi(signal);
		const environment: Readonly<Record<string, string>> = {
			TICKETFLOW_ROLE: "worker",
			TICKETFLOW_RUN_ID: input.runId,
			TICKETFLOW_ASSIGNMENT_ID: input.assignmentId,
			TICKETFLOW_OPERATION_ID: input.operationId,
			TICKETFLOW_KIND: input.kind,
			TICKETFLOW_REQUESTED_MODEL: input.profile.model,
			TICKETFLOW_REQUESTED_THINKING: input.profile.thinking,
			TICKETFLOW_SOCKET: input.socketPath,
			TICKETFLOW_TOKEN: input.token,
			TICKETFLOW_RESUME: resuming ? "1" : "0",
		};
		const model = exactModelParts(input.profile.model);
		const piArguments: string[] = [
			"--model", `${model.provider}/${model.model}`,
			"--thinking", input.profile.thinking,
			"--no-extensions", "-e", this.packageRoot,
			"--no-skills",
			"--no-prompt-templates",
			...(resuming ? ["--session", sessionFile!] : []),
		];
		const script = launcherScript(piExecutable, piArguments, environment);
		const launcher = await makeLauncher(input.runId, script, signal).catch((cause) => {
			if (signal?.aborted) signal.throwIfAborted();
			throw backendFailure("launch worker", "Could not create the owner-only Pi launcher.", cause);
		});
		const displayName = input.title.trim();
		const initialWindowName = launchMarker(input.operationId);
		let createdResult: TmuxCommandResult;
		try {
			createdResult = await this.commandOnServer(current.serverSocketPath, [
				"new-window", "-d", "-P", "-F", NEW_WINDOW_FORMAT,
				"-t", current.sessionId,
				"-c", input.cwd,
				"-n", initialWindowName,
				launcher,
			], "create worker window", signal);
		} catch (cause) {
			await removeLauncher(launcher);
			throw cause;
		}
		if (createdResult.code !== 0) {
			await removeLauncher(launcher);
			throw backendFailure("create worker window", createdResult.stderr.trim() || "tmux could not create the worker window.");
		}
		const created = parseNewWindow(createdResult.stdout);
		if (!created) {
			// There is no trustworthy window identity to destroy here.  In
			// particular, never turn a pane ID guessed from command output into a
			// kill target.  The launcher removes its own secret-bearing file.
			await removeLauncher(launcher);
			throw backendFailure("create worker window", "tmux returned malformed worker-window identity.");
		}
		let handle: TmuxHandle | undefined;
		try {
			handle = this.buildHandle(created, input, current);
			await this.setOwnership(handle, input, signal);
			await this.renameOwnedWindow(handle, displayName, signal);
			handle = { ...handle, displayName };
			const observed = await this.inspect(handle, signal);
			if (observed.state !== "alive") {
				if (observed.state === "foreign" || observed.state === "ambiguous") throw backendFailure("launch worker", observed.message);
				throw backendFailure("launch worker", `The newly created Worker is ${observed.state}.`);
			}
			return handle;
		} catch (cause) {
			// Once all three tags and all IDs have been observed, cleanup is safe;
			// otherwise leave the window alone rather than risking a reused ID.
			if (handle !== undefined) await this.killIfOwned(handle, undefined).catch(() => undefined);
			await removeLauncher(launcher);
			throw cause;
		}
	}

	public async spawn(input: SpawnInput, signal?: AbortSignal): Promise<SerializedWorkerHandle> {
		return this.launch(input, false, undefined, signal);
	}

	public async reopen(input: SpawnInput & { readonly sessionFile: string }, signal?: AbortSignal): Promise<SerializedWorkerHandle> {
		return this.launch(input, true, input.sessionFile, signal);
	}

	public async inspect(handle: SerializedWorkerHandle, signal?: AbortSignal): Promise<WorkerInspection> {
		if (!validateHandle(handle)) return { state: "foreign", message: "The recorded tmux handle is malformed or foreign." };
		signal?.throwIfAborted();
		let result: TmuxCommandResult;
		try {
			// The pane ID is used only to locate a candidate.  The returned record
			// must match socket, session, window, pane, and every ownership tag.
			result = await this.commandOnServer(handle.serverSocketPath, ["display-message", "-p", "-t", handle.paneId, "-F", INSPECTION_FORMAT], "inspect worker", signal);
		} catch (cause) {
			if (signal?.aborted) signal.throwIfAborted();
			return { state: "ambiguous", message: cause instanceof Error ? cause.message : String(cause) };
		}
		if (result.code !== 0) {
			if (/can't find (?:pane|window|session)|no server running|no current client/i.test(result.stderr)) return { state: "missing" };
			return { state: "ambiguous", message: result.stderr.trim() || "tmux could not inspect the worker pane." };
		}
		// With remain-on-exit disabled, tmux can answer a stale pane target
		// successfully while rendering empty fields (the socket path remains
		// available).  Treat that exact vanished-target shape as missing; never
		// infer ownership from the pane ID alone.
		const rawFields = lines(result.stdout)[0]?.split("\t");
		if (rawFields?.length === 9 && rawFields.slice(1).every((field) => field === "")) return { state: "missing" };
		const record = parseWindow(result.stdout);
		if (!record) return { state: "ambiguous", message: "tmux returned malformed worker ownership data." };
		if (!ownershipMatches(record, handle)) return { state: "foreign", message: "The recorded tmux IDs or ownership tags now belong to another window." };
		return { state: record.paneDead ? "exited" : "alive" };
	}

	private async killIfOwned(handle: TmuxHandle, signal?: AbortSignal): Promise<void> {
		const verified = await this.inspect(handle, signal);
		if (verified.state !== "alive" && verified.state !== "exited") return;
		const killed = await this.commandOnServer(handle.serverSocketPath, ["kill-window", "-t", windowTarget(handle)], "kill worker window", signal);
		if (killed.code !== 0) throw backendFailure("kill worker window", killed.stderr.trim() || "tmux could not kill the verified worker window.");
	}

	public async abort(handle: SerializedWorkerHandle, signal?: AbortSignal): Promise<void> {
		if (!validateHandle(handle)) throw backendFailure("abort worker", "The recorded tmux handle is malformed or foreign.");
		const observed = await this.inspect(handle, signal);
		if (observed.state === "missing" || observed.state === "exited") return;
		if (observed.state === "foreign" || observed.state === "ambiguous") throw backendFailure("abort worker", observed.message);
		// inspect() above is the ownership re-verification immediately before
		// this non-destructive interrupt.  Abort intentionally never closes.
		const interrupted = await this.commandOnServer(handle.serverSocketPath, ["send-keys", "-t", paneTarget(handle), "C-c"], "abort worker turn", signal);
		if (interrupted.code !== 0) throw backendFailure("abort worker", interrupted.stderr.trim() || "tmux could not send C-c to the verified worker.");
	}

	public async closeLaunchIntent(identity: Pick<SpawnInput, "runId" | "assignmentId" | "operationId" | "backendIdentity">, signal?: AbortSignal): Promise<void> {
		assertText(identity.runId, "runId", { id: true });
		assertText(identity.assignmentId, "assignmentId", { id: true });
		assertText(identity.operationId, "operationId", { id: true });
		const current = identity.backendIdentity ?? await this.currentSession(signal);
		if (!path.isAbsolute(current.serverSocketPath) || !SESSION_ID.test(current.sessionId) || !current.sessionName) throw backendFailure("close launch intent", "Persisted tmux launch identity is invalid.");
		const marker = launchMarker(identity.operationId);
		const matches = (await this.listWindows(current.serverSocketPath, signal)).filter((window) =>
			window.sessionId === current.sessionId && window.sessionName === current.sessionName && ((window.runId === identity.runId && window.assignmentId === identity.assignmentId && window.operationId === identity.operationId)
			|| (window.displayName === marker
				&& (window.runId === "" || window.runId === identity.runId)
				&& (window.assignmentId === "" || window.assignmentId === identity.assignmentId)
				&& (window.operationId === "" || window.operationId === identity.operationId))),
		);
		if (matches.length > 1) throw backendFailure("close launch intent", "Multiple tmux windows match the durable launch intent.");
		const match = matches[0];
		if (!match) return;
		let handle = handleFromWindow(match, identity);
		const fresh = await this.inspectWindowRecord(handle, signal);
		if (!fresh || fresh.windowId !== match.windowId || fresh.paneId !== match.paneId || fresh.displayName !== match.displayName || fresh.runId !== match.runId || fresh.assignmentId !== match.assignmentId || fresh.operationId !== match.operationId) throw backendFailure("close launch intent", "Launch-intent identity changed before cleanup.");
		if (match.runId !== identity.runId || match.assignmentId !== identity.assignmentId || match.operationId !== identity.operationId) {
			await this.setOwnership(handle, identity, signal);
			handle = { ...handle, runId: identity.runId, assignmentId: identity.assignmentId, operationId: identity.operationId };
		}
		await this.close(handle, signal);
	}

	public async close(handle: SerializedWorkerHandle, signal?: AbortSignal): Promise<void> {
		if (!validateHandle(handle)) throw backendFailure("close worker", "The recorded tmux handle is malformed or foreign.");
		let observed = await this.inspect(handle, signal);
		if (observed.state === "missing") return;
		if (observed.state === "foreign" || observed.state === "ambiguous") throw backendFailure("close worker", observed.message);
		if (observed.state === "alive") {
			const interrupted = await this.commandOnServer(handle.serverSocketPath, ["send-keys", "-t", paneTarget(handle), "C-c"], "close worker gracefully", signal);
			if (interrupted.code !== 0) throw backendFailure("close worker gracefully", interrupted.stderr.trim() || "tmux could not send C-c to the verified worker.");
			const deadline = Date.now() + Math.max(0, this.closeTimeoutMs);
			while (Date.now() < deadline) {
				signal?.throwIfAborted();
				const wait = Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now()));
				await this.sleep(wait, signal ?? noAbortSignal());
				observed = await this.inspect(handle, signal);
				if (observed.state === "missing") return;
				if (observed.state === "foreign" || observed.state === "ambiguous") throw backendFailure("close worker", observed.message);
				if (observed.state === "exited") break;
			}
		}
		// This final inspect is deliberately adjacent to kill-window.  A pane
		// or window ID that was reused/changed is never a kill target.
		observed = await this.inspect(handle, signal);
		if (observed.state === "missing") return;
		if (observed.state === "foreign" || observed.state === "ambiguous") throw backendFailure("close worker", observed.message);
		const killed = await this.commandOnServer(handle.serverSocketPath, ["kill-window", "-t", windowTarget(handle)], "close worker window", signal);
		if (killed.code !== 0) throw backendFailure("close worker window", killed.stderr.trim() || "tmux could not kill the verified worker window.");
	}
}

/** Short aliases keep the adapter convenient without changing the interface. */
export { TmuxWorkerBackend as TmuxBackend };
export function createTmuxBackend(options: TmuxBackendOptions = {}): WorkerBackend {
	return new TmuxWorkerBackend(options);
}

export default TmuxWorkerBackend;
