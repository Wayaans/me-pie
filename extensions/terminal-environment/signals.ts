import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { environmentError, errorMessage, type TerminalEnvironmentError } from "./errors.ts";

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 10_000;
const MAX_RETAINED_SIGNALS = 1_024;

interface LockOwner {
	readonly pid: number;
	readonly token: string;
}

function processIsAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (cause) { return (cause as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
		const abort = (): void => { clearTimeout(timer); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}

export interface SignalStoreOptions {
	readonly rootDirectory?: string;
}

export interface SignalSnapshot {
	readonly sequence: number;
	readonly sourcePaneId?: string;
}

export interface SignalEvent {
	readonly sequence: number;
	readonly sourcePaneId: string;
}

export interface SignalPoll {
	readonly currentSequence: number;
	readonly signal?: SignalEvent;
}

interface SignalState {
	readonly sequence: number;
	readonly signals: readonly SignalEvent[];
}

export class SignalStore {
	private readonly directory: string;

	constructor(environmentInstanceId: string, options: SignalStoreOptions = {}) {
		const serverId = createHash("sha256").update(environmentInstanceId).digest("hex").slice(0, 24);
		const root = options.rootDirectory ?? path.join(os.tmpdir(), "mepie-terminal-environment", "signals");
		this.directory = path.join(root, serverId);
	}

	currentSignal(recipientPaneId: string): Effect.Effect<SignalSnapshot, TerminalEnvironmentError> {
		return this.operation("read workspace inbox signal", async (signal) => {
			const state = await this.readState(recipientPaneId, signal);
			return state.signals.at(-1) ?? { sequence: 0 };
		});
	}

	currentSequence(recipientPaneId: string): Effect.Effect<number, TerminalEnvironmentError> {
		return this.currentSignal(recipientPaneId).pipe(Effect.map((current) => current.sequence));
	}

	poll(recipientPaneId: string, afterSequence: number): Effect.Effect<SignalPoll, TerminalEnvironmentError> {
		return this.operation("poll workspace inbox signal", async (signal) => {
			const state = await this.readState(recipientPaneId, signal);
			const nextSignal = state.signals.find((event) => event.sequence > afterSequence);
			return {
				currentSequence: state.sequence,
				...(nextSignal === undefined ? {} : { signal: nextSignal }),
			};
		});
	}

	signal(recipientPaneId: string, sourcePaneId: string): Effect.Effect<number, TerminalEnvironmentError> {
		return this.operation("write workspace inbox signal", async (signal) => {
			await this.ensureDirectory();
			this.paneKey(sourcePaneId, "source");
			const release = await this.acquireLock(recipientPaneId, signal);
			try {
				const current = await this.readState(recipientPaneId, signal);
				const next = current.sequence + 1;
				const signals = [...current.signals, { sequence: next, sourcePaneId }].slice(-MAX_RETAINED_SIGNALS);
				await this.writeState(recipientPaneId, { sequence: next, signals }, signal);
				return next;
			} finally {
				await release();
			}
		});
	}

	private operation<A>(operation: string, run: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, TerminalEnvironmentError> {
		return Effect.tryPromise({
			try: run,
			catch: (cause) => environmentError(operation, errorMessage(cause), cause),
		});
	}

	private paneKey(paneId: string, role: "recipient" | "source"): string {
		if (!/^%[0-9]+$/.test(paneId)) throw environmentError("workspace signal", `Invalid ${role} pane ID: ${paneId}`);
		return paneId.slice(1);
	}

	private async ensureDirectory(): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await chmod(this.directory, 0o700);
	}

	private signalPath(recipientPaneId: string): string {
		return path.join(this.directory, `to-${this.paneKey(recipientPaneId, "recipient")}.json`);
	}

	private lockPath(recipientPaneId: string): string {
		return path.join(this.directory, `to-${this.paneKey(recipientPaneId, "recipient")}.lock`);
	}

	private async readState(recipientPaneId: string, signal: AbortSignal): Promise<SignalState> {
		signal.throwIfAborted();
		await this.ensureDirectory();
		try {
			const parsed = JSON.parse(await readFile(this.signalPath(recipientPaneId), "utf8")) as {
				readonly sequence?: unknown;
				readonly signals?: unknown;
			};
			if (!Number.isSafeInteger(parsed.sequence) || (parsed.sequence as number) < 1
				|| !Array.isArray(parsed.signals) || parsed.signals.length < 1
				|| parsed.signals.length > MAX_RETAINED_SIGNALS) {
				throw new Error("Signal inbox file is malformed.");
			}
			const signals = parsed.signals as Array<{ readonly sequence?: unknown; readonly sourcePaneId?: unknown }>;
			if (signals.some((event, index) => !Number.isSafeInteger(event.sequence)
				|| (event.sequence as number) < 1
				|| (index > 0 && (event.sequence as number) <= (signals[index - 1]!.sequence as number))
				|| typeof event.sourcePaneId !== "string"
				|| !/^%[0-9]+$/.test(event.sourcePaneId))
				|| signals.at(-1)!.sequence !== parsed.sequence) {
				throw new Error("Signal inbox file is malformed.");
			}
			return { sequence: parsed.sequence as number, signals: signals as SignalEvent[] };
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { sequence: 0, signals: [] };
			throw cause;
		}
	}

	private async writeState(recipientPaneId: string, state: SignalState, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		const destination = this.signalPath(recipientPaneId);
		const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx", signal });
			await chmod(temporary, 0o600);
			await rename(temporary, destination);
		} finally {
			await rm(temporary, { force: true }).catch(() => undefined);
		}
	}

	private async acquireLock(recipientPaneId: string, signal: AbortSignal): Promise<() => Promise<void>> {
		const lock = this.lockPath(recipientPaneId);
		const ownerPath = path.join(lock, "owner.json");
		const deadline = Date.now() + LOCK_TIMEOUT_MS;
		for (;;) {
			signal.throwIfAborted();
			try {
				await mkdir(lock, { mode: 0o700 });
				const owner: LockOwner = { pid: process.pid, token: crypto.randomUUID() };
				try {
					await writeFile(ownerPath, JSON.stringify(owner), { encoding: "utf8", mode: 0o600, flag: "wx", signal });
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
							if ((ownerCause as NodeJS.ErrnoException).code !== "ENOENT") throw ownerCause;
						}
						if (owner === undefined || (typeof owner.pid === "number" && !processIsAlive(owner.pid))) {
							await rm(lock, { recursive: true, force: true });
							continue;
						}
					}
				} catch (inspectCause) {
					if ((inspectCause as NodeJS.ErrnoException).code !== "ENOENT") throw inspectCause;
				}
				if (Date.now() >= deadline) throw new Error("Timed out acquiring the workspace signal lock.");
				await abortableSleep(LOCK_RETRY_MS, signal);
			}
		}
	}
}
