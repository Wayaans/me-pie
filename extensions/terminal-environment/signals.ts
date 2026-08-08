import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { environmentError, errorMessage, type TerminalEnvironmentError } from "./errors.ts";

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 10_000;

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

export class SignalStore {
	private readonly directory: string;

	constructor(environmentInstanceId: string, options: SignalStoreOptions = {}) {
		const serverId = createHash("sha256").update(environmentInstanceId).digest("hex").slice(0, 24);
		const root = options.rootDirectory ?? path.join(os.tmpdir(), "mepie-terminal-environment", "signals");
		this.directory = path.join(root, serverId);
	}

	currentSequence(paneId: string): Effect.Effect<number, TerminalEnvironmentError> {
		return this.operation("read workspace signal", (signal) => this.readSequence(paneId, signal));
	}

	signal(paneId: string): Effect.Effect<number, TerminalEnvironmentError> {
		return this.operation("write workspace signal", async (signal) => {
			await this.ensureDirectory();
			const release = await this.acquireLock(paneId, signal);
			try {
				const next = await this.readSequence(paneId, signal) + 1;
				await this.writeSequence(paneId, next, signal);
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

	private key(paneId: string): string {
		if (!/^%[0-9]+$/.test(paneId)) throw environmentError("workspace signal", `Invalid pane ID: ${paneId}`);
		return paneId.slice(1);
	}

	private async ensureDirectory(): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await chmod(this.directory, 0o700);
	}

	private sequencePath(paneId: string): string {
		return path.join(this.directory, `${this.key(paneId)}.json`);
	}

	private lockPath(paneId: string): string {
		return path.join(this.directory, `${this.key(paneId)}.lock`);
	}

	private async readSequence(paneId: string, signal: AbortSignal): Promise<number> {
		signal.throwIfAborted();
		await this.ensureDirectory();
		try {
			const parsed = JSON.parse(await readFile(this.sequencePath(paneId), "utf8")) as { readonly sequence?: unknown };
			if (!Number.isSafeInteger(parsed.sequence) || (parsed.sequence as number) < 0) throw new Error("Signal sequence file is malformed.");
			return parsed.sequence as number;
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT") return 0;
			throw cause;
		}
	}

	private async writeSequence(paneId: string, sequence: number, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		const destination = this.sequencePath(paneId);
		const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify({ sequence })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx", signal });
			await chmod(temporary, 0o600);
			await rename(temporary, destination);
		} finally {
			await rm(temporary, { force: true }).catch(() => undefined);
		}
	}

	private async acquireLock(paneId: string, signal: AbortSignal): Promise<() => Promise<void>> {
		const lock = this.lockPath(paneId);
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
