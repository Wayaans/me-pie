import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Effect } from "effect";
import { environmentError, errorMessage, type TerminalEnvironmentError } from "./errors.ts";
import { TERMINAL_ENVIRONMENT_RUNTIME_ROOT } from "./paths.ts";

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 10_000;
const MAX_RETAINED_SIGNALS = 1_024;
const SIGNAL_FORMAT_VERSION = 2;
const MAX_DELIVERY_ID_LENGTH = 128;
const UNRESOLVED_DELIVERY_TTL_MS = 24 * 60 * 60 * 1_000;

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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDeliveryId(value: unknown): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= MAX_DELIVERY_ID_LENGTH
		&& !/[\\/\u0000]/u.test(value);
}

export interface SignalStoreOptions {
	readonly rootDirectory?: string;
}

export interface SignalSnapshot {
	readonly sequence: number;
	readonly sourcePaneId?: string;
	readonly deliveryId?: string;
}

export interface SignalEvent {
	readonly sequence: number;
	readonly sourcePaneId: string;
	readonly deliveryId?: string;
}

export interface SignalPoll {
	readonly currentSequence: number;
	readonly signal?: SignalEvent;
}

export type SignalDeliveryState = "pending" | "delivered" | "uncertain";

export type SignalDelivery =
	| {
			readonly deliveryId: string;
			readonly sourcePaneId: string;
			readonly createdAt: number;
			readonly state: "pending" | "uncertain";
		}
	| {
			readonly deliveryId: string;
			readonly sourcePaneId: string;
			readonly createdAt: number;
			readonly state: "delivered";
			readonly sequence: number;
		};

export interface SignalCommit {
	readonly deliveryId: string;
	readonly sourcePaneId: string;
	readonly sequence: number;
}

interface SignalState {
	readonly version: 2;
	/** The highest sequence assigned to a committed delivery. */
	readonly sequence: number;
	readonly deliveries: readonly SignalDelivery[];
}

export class SignalStore {
	private readonly directory: string;

	constructor(environmentInstanceId: string, options: SignalStoreOptions = {}) {
		const serverId = createHash("sha256").update(environmentInstanceId).digest("hex").slice(0, 24);
		const root = options.rootDirectory ?? path.join(TERMINAL_ENVIRONMENT_RUNTIME_ROOT, "signals");
		this.directory = path.join(root, serverId);
	}

	currentSignal(recipientPaneId: string): Effect.Effect<SignalSnapshot, TerminalEnvironmentError> {
		return this.operation("read workspace inbox signal", async (signal) => {
			const state = await this.readState(recipientPaneId, signal);
			const latest = this.committedEvents(state).at(-1);
			return latest === undefined ? { sequence: state.sequence } : { sequence: latest.sequence, sourcePaneId: latest.sourcePaneId };
		});
	}

	currentSequence(recipientPaneId: string): Effect.Effect<number, TerminalEnvironmentError> {
		return this.currentSignal(recipientPaneId).pipe(Effect.map((current) => current.sequence));
	}

	poll(recipientPaneId: string, afterSequence: number): Effect.Effect<SignalPoll, TerminalEnvironmentError> {
		return this.operation("poll workspace inbox signal", async (signal) => {
			const state = await this.readState(recipientPaneId, signal);
			const nextSignal = this.committedEvents(state).find((event) => event.sequence > afterSequence);
			return {
				currentSequence: state.sequence,
				...(nextSignal === undefined ? {} : { signal: nextSignal }),
			};
		});
	}

	/**
	 * Reserve a delivery before sending its transport payload. Repeating a reservation
	 * with the same ID is safe and returns the existing record instead of duplicating it.
	 */
	reserve(
		recipientPaneId: string,
		sourcePaneId: string,
		deliveryId: string,
	): Effect.Effect<SignalDelivery, TerminalEnvironmentError> {
		return this.operation("reserve workspace signal delivery", async (signal) => {
			this.validateDeliveryId(deliveryId);
			this.paneKey(sourcePaneId, "source");
			return this.updateState(recipientPaneId, signal, (state) => {
				const existing = state.deliveries.find((delivery) => delivery.deliveryId === deliveryId);
				if (existing !== undefined) {
					if (existing.sourcePaneId !== sourcePaneId) throw new Error(`Delivery ${deliveryId} is already reserved for another source pane.`);
					return { state, value: existing };
				}
				const delivery: SignalDelivery = { deliveryId, sourcePaneId, createdAt: Date.now(), state: "pending" };
				return {
					state: { ...state, deliveries: this.retainDeliveries([...state.deliveries, delivery]) },
					value: delivery,
				};
			});
		});
	}

	/** Commit a reserved delivery. Repeating a commit by ID is idempotent. */
	commit(recipientPaneId: string, deliveryId: string): Effect.Effect<SignalCommit, TerminalEnvironmentError> {
		return this.operation("commit workspace signal delivery", async (signal) => {
			this.validateDeliveryId(deliveryId);
			return this.updateState(recipientPaneId, signal, (state) => {
				const index = state.deliveries.findIndex((delivery) => delivery.deliveryId === deliveryId);
				const existing = index < 0 ? undefined : state.deliveries[index];
				if (existing === undefined) throw new Error(`Unknown workspace signal delivery: ${deliveryId}`);
				if (existing.state === "delivered") {
					return { state, value: { deliveryId, sourcePaneId: existing.sourcePaneId, sequence: existing.sequence } };
				}
				if (existing.state === "uncertain") throw new Error(`Workspace signal delivery ${deliveryId} is uncertain and cannot be committed.`);
				const sequence = state.sequence + 1;
				if (!Number.isSafeInteger(sequence)) throw new Error("Workspace signal sequence exhausted.");
				const committed: SignalDelivery = { deliveryId, sourcePaneId: existing.sourcePaneId, createdAt: existing.createdAt, state: "delivered", sequence };
				return {
					state: { ...state, sequence, deliveries: this.replaceDelivery(state.deliveries, index, committed) },
					value: { deliveryId, sourcePaneId: committed.sourcePaneId, sequence },
				};
			});
		});
	}

	/** Record that transport outcome is unknown; uncertain deliveries never wake raw wait. */
	markUncertain(recipientPaneId: string, deliveryId: string): Effect.Effect<SignalDelivery, TerminalEnvironmentError> {
		return this.operation("mark workspace signal delivery uncertain", async (signal) => {
			this.validateDeliveryId(deliveryId);
			return this.updateState(recipientPaneId, signal, (state) => {
				const index = state.deliveries.findIndex((delivery) => delivery.deliveryId === deliveryId);
				const existing = index < 0 ? undefined : state.deliveries[index];
				if (existing === undefined) throw new Error(`Unknown workspace signal delivery: ${deliveryId}`);
				if (existing.state !== "pending") return { state, value: existing };
				const uncertain: SignalDelivery = { deliveryId, sourcePaneId: existing.sourcePaneId, createdAt: existing.createdAt, state: "uncertain" };
				return { state: { ...state, deliveries: this.replaceDelivery(state.deliveries, index, uncertain) }, value: uncertain };
			});
		});
	}

	/**
	 * Compatibility wrapper for the original one-phase signal API. New callers should
	 * reserve before transport, then commit or markUncertain after transport.
	 */
	signal(recipientPaneId: string, sourcePaneId: string, deliveryId = crypto.randomUUID()): Effect.Effect<number, TerminalEnvironmentError> {
		const self = this;
		return Effect.gen(function* () {
			yield* self.reserve(recipientPaneId, sourcePaneId, deliveryId);
			const committed = yield* self.commit(recipientPaneId, deliveryId);
			return committed.sequence;
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
			return this.parseState(JSON.parse(await readFile(this.signalPath(recipientPaneId), "utf8")) as unknown);
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { version: SIGNAL_FORMAT_VERSION, sequence: 0, deliveries: [] };
			throw cause;
		}
	}

	private parseState(value: unknown): SignalState {
		if (!isRecord(value)) throw new Error("Signal inbox file is malformed.");
		if (value.version === undefined || value.version === 1) return this.parseLegacyState(value);
		if (value.version !== SIGNAL_FORMAT_VERSION) throw new Error("Signal inbox file has an unsupported version.");
		if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0
			|| !Array.isArray(value.deliveries) || value.deliveries.length > MAX_RETAINED_SIGNALS) {
			throw new Error("Signal inbox file is malformed.");
		}

		const deliveryIds = new Set<string>();
		const sequences = new Set<number>();
		const deliveries: SignalDelivery[] = [];
		for (const candidate of value.deliveries) {
			if (!isRecord(candidate)
				|| !isDeliveryId(candidate.deliveryId)
				|| deliveryIds.has(candidate.deliveryId)
				|| typeof candidate.sourcePaneId !== "string"
				|| !/^%[0-9]+$/.test(candidate.sourcePaneId)
				|| !Number.isSafeInteger(candidate.createdAt) || (candidate.createdAt as number) < 0
				|| (candidate.state !== "pending" && candidate.state !== "delivered" && candidate.state !== "uncertain")) {
				throw new Error("Signal inbox file is malformed.");
			}
			deliveryIds.add(candidate.deliveryId);
			if (candidate.state === "delivered") {
				if (!Number.isSafeInteger(candidate.sequence) || (candidate.sequence as number) < 1 || sequences.has(candidate.sequence as number)) {
					throw new Error("Signal inbox file is malformed.");
				}
				sequences.add(candidate.sequence as number);
				deliveries.push({
					deliveryId: candidate.deliveryId,
					sourcePaneId: candidate.sourcePaneId,
					createdAt: candidate.createdAt as number,
					state: "delivered",
					sequence: candidate.sequence as number,
				});
			} else {
				if (candidate.sequence !== undefined) throw new Error("Signal inbox file is malformed.");
				deliveries.push({ deliveryId: candidate.deliveryId, sourcePaneId: candidate.sourcePaneId, createdAt: candidate.createdAt as number, state: candidate.state });
			}
		}
		const highestSequence = deliveries.reduce((highest, delivery) =>
			delivery.state === "delivered" ? Math.max(highest, delivery.sequence) : highest, 0);
		if (highestSequence > (value.sequence as number)) throw new Error("Signal inbox file is malformed.");
		return { version: SIGNAL_FORMAT_VERSION, sequence: value.sequence as number, deliveries };
	}

	private parseLegacyState(value: Readonly<Record<string, unknown>>): SignalState {
		if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0
			|| !Array.isArray(value.signals) || value.signals.length > MAX_RETAINED_SIGNALS) {
			throw new Error("Signal inbox file is malformed.");
		}
		const deliveries: SignalDelivery[] = [];
		let previousSequence = 0;
		for (const candidate of value.signals) {
			if (!isRecord(candidate)
				|| !Number.isSafeInteger(candidate.sequence)
				|| (candidate.sequence as number) <= previousSequence
				|| typeof candidate.sourcePaneId !== "string"
				|| !/^%[0-9]+$/.test(candidate.sourcePaneId)) {
				throw new Error("Signal inbox file is malformed.");
			}
			previousSequence = candidate.sequence as number;
			deliveries.push({
				deliveryId: `legacy-v1-${previousSequence}`,
				sourcePaneId: candidate.sourcePaneId,
				createdAt: 0,
				state: "delivered",
				sequence: previousSequence,
			});
		}
		if ((value.sequence as number) !== previousSequence) throw new Error("Signal inbox file is malformed.");
		return { version: SIGNAL_FORMAT_VERSION, sequence: value.sequence as number, deliveries };
	}

	private committedEvents(state: SignalState): readonly SignalEvent[] {
		return state.deliveries
			.filter((delivery): delivery is Extract<SignalDelivery, { readonly state: "delivered" }> => delivery.state === "delivered")
			.map((delivery) => ({
				sequence: delivery.sequence,
				sourcePaneId: delivery.sourcePaneId,
				...(delivery.deliveryId.startsWith("legacy-v1-") ? {} : { deliveryId: delivery.deliveryId }),
			}))
			.sort((left, right) => left.sequence - right.sequence);
	}

	private validateDeliveryId(deliveryId: string): void {
		if (!isDeliveryId(deliveryId)) throw new Error("Workspace signal delivery IDs must be non-empty and bounded.");
	}

	private replaceDelivery(deliveries: readonly SignalDelivery[], index: number, replacement: SignalDelivery): readonly SignalDelivery[] {
		return deliveries.map((delivery, candidateIndex) => candidateIndex === index ? replacement : delivery);
	}

	/** Keep unresolved records for safe retries, and trim only committed history. */
	private retainDeliveries(deliveries: readonly SignalDelivery[]): readonly SignalDelivery[] {
		const oldestRetainedAt = Date.now() - UNRESOLVED_DELIVERY_TTL_MS;
		const unresolved = deliveries.filter((delivery) => delivery.state !== "delivered" && delivery.createdAt >= oldestRetainedAt);
		if (unresolved.length > MAX_RETAINED_SIGNALS) throw new Error("Workspace signal delivery retention is full of unresolved records.");
		const committed = deliveries.filter((delivery) => delivery.state === "delivered");
		const retainedCommitted = committed.slice(-Math.max(0, MAX_RETAINED_SIGNALS - unresolved.length));
		const retainedIds = new Set(retainedCommitted.map((delivery) => delivery.deliveryId));
		const unresolvedIds = new Set(unresolved.map((delivery) => delivery.deliveryId));
		return deliveries.filter((delivery) => delivery.state === "delivered" ? retainedIds.has(delivery.deliveryId) : unresolvedIds.has(delivery.deliveryId));
	}

	private async updateState<A>(
		recipientPaneId: string,
		signal: AbortSignal,
		update: (state: SignalState) => { readonly state: SignalState; readonly value: A },
	): Promise<A> {
		signal.throwIfAborted();
		await this.ensureDirectory();
		const release = await this.acquireLock(recipientPaneId, signal);
		try {
			const current = await this.readState(recipientPaneId, signal);
			const next = update(current);
			await this.writeState(recipientPaneId, next.state, signal);
			return next.value;
		} finally {
			await release();
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
