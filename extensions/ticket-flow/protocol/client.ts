import net, { type Socket } from "node:net";
import { Effect, Fiber, Queue } from "effect";
import type { AuthoritativeWorkerContext, WorkerFeedback, WorkerIdentity } from "../domain.ts";
import { encodeJsonLine, JsonLineFramer } from "./framing.ts";
import { validateWorkerReconnectPath, workerReconnectDelay } from "../worker/reconnect.ts";
import {
	decodeFeedback,
	decodeProtocolMessage,
	decodeWorkerContext,
	feedbackFromPayload,
	makeMessage,
	type ProtocolEnvelope,
	type WorkerMessageType,
} from "./messages.ts";

export interface ProtocolClientOptions {
	readonly socketPath: string;
	readonly identity: WorkerIdentity;
	readonly token: string;
	readonly onDelegate: (prompt: string, context: AuthoritativeWorkerContext) => Promise<void> | void;
	readonly onFeedback: (message: string) => Promise<void> | void;
	readonly onShutdown: () => Promise<void> | void;
	readonly retryDelaysMs?: readonly number[];
}
export class ProtocolClientError extends Error { constructor(message: string) { super(message); this.name = "ProtocolClientError"; } }

const MAX_INCOMING_MESSAGES = 1_024;
const MAX_PENDING_SUBMISSIONS = 256;
const MAX_FEEDBACK_MESSAGES = 256;
const MAX_FEEDBACK_WAITERS = 256;
const MAX_SEEN_SERVER_MESSAGES = 4_096;
const MAX_SENT_WORKER_EVENT_IDS = 4_096;
const MAX_IGNORED_ACKNOWLEDGEMENTS = 4_096;

interface FeedbackWaiter {
	readonly resolve: (feedback: WorkerFeedback) => void;
	readonly reject: (cause: unknown) => void;
}

interface SubmissionWaiter {
	readonly resolve: () => void;
	readonly reject: (cause: unknown) => void;
}

interface PendingSubmission {
	readonly envelope: ProtocolEnvelope;
	readonly waiter: SubmissionWaiter | undefined;
}

function requiresWorkerAcknowledgement(type: WorkerMessageType): boolean {
	return type === "worker-progress" || type === "worker-report" || type === "worker-blocked" || type === "worker-failed";
}
function snapshotEnvelope(message: ProtocolEnvelope): ProtocolEnvelope {
	const snapshot = JSON.parse(JSON.stringify(message)) as ProtocolEnvelope;
	// Validate the retained envelope against the same output bound used by
	// every native write before putting it in the pending set.
	encodeJsonLine(snapshot);
	return snapshot;
}

export class ProtocolClient {
	private socket: Socket | undefined;
	private stopped = false;
	private verified = false;
	private retry: ReturnType<typeof setTimeout> | undefined;
	private incoming: Queue.Queue<ProtocolEnvelope> | undefined;
	private processor: Fiber.Fiber<void> | undefined;
	private readySent = false;
	private shutdownSent = false;
	private handshakeMessageId: string | undefined;
	private delegationMessageId: string | undefined;
	private context: AuthoritativeWorkerContext | undefined;
	private readonly feedback: WorkerFeedback[] = [];
	private readonly feedbackWaiters = new Set<FeedbackWaiter>();
	/** Reliable worker submissions remain here until their server acknowledgement arrives. */
	private readonly pendingSubmissions = new Map<string, PendingSubmission>();
	/** A late acknowledgement for an aborted submission must not become feedback. */
	private readonly ignoredAcknowledgements = new Set<string>();
	private readonly sentWorkerEventIds = new Set<string>();
	private readonly seen = new Map<string, string>();
	private readonly reconnectSocketPath: string;
	constructor(readonly options: ProtocolClientOptions) { this.reconnectSocketPath = validateWorkerReconnectPath(options.socketPath); }
	get isVerified(): boolean { return this.verified; }
	get isStopped(): boolean { return this.stopped; }
	get authoritativeContext(): AuthoritativeWorkerContext | undefined { return this.context; }
	start(): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			if (this.stopped || this.incoming) return;
			this.incoming = yield* Queue.bounded<ProtocolEnvelope>(MAX_INCOMING_MESSAGES);
			const consume = Effect.forever(Effect.gen({ self: this }, function* () {
				const message = yield* Queue.take(this.incoming!);
				yield* Effect.tryPromise({
					try: () => this.receive(message),
					catch: (cause) => cause instanceof Error ? cause : new ProtocolClientError("Terminal protocol receive error"),
				}).pipe(Effect.catch((cause) => Effect.sync(() => this.stopTerminal(cause))));
			}));
			this.processor = Effect.runFork(consume);
			this.connect(0);
		});
	}
	private connect(attempt: number): void {
		if (this.stopped || this.socket) return;
		const socket = net.createConnection(this.reconnectSocketPath); this.socket = socket;
		const framer = new JsonLineFramer();
		socket.once("connect", () => {
			const { identity } = this.options;
			const handshake = makeMessage(identity.runId, identity.workItemId, "worker-connected", {
				token: this.options.token, provider: identity.provider, model: identity.model, thinking: identity.thinking,
				...(identity.sessionId === undefined ? {} : { sessionId: identity.sessionId }), ...(identity.sessionFile === undefined ? {} : { sessionFile: identity.sessionFile }),
			});
			this.handshakeMessageId = handshake.messageId;
			try { socket.write(encodeJsonLine(handshake)); } catch { socket.destroy(); }
		});
		socket.on("data", (chunk: Buffer) => {
			try {
				for (const message of framer.push(chunk)) {
					if (!this.incoming || !Queue.offerUnsafe(this.incoming, message)) {
						this.stopTerminal(new ProtocolClientError("Worker protocol input queue is full"));
						return;
					}
				}
			} catch (cause) { this.stopTerminal(cause); }
		});
		let transportClosed = false;
		const onTransportClosed = () => {
			if (transportClosed) return;
			transportClosed = true;
			if (this.socket !== socket) return;
			this.socket = undefined;
			this.verified = false; this.readySent = false;
			// Do not reject or remove pending submissions here. Their complete
			// envelopes and waiters are the durable-in-memory delivery record for
			// this worker process. They are resent after the next handshake.
			if (!this.stopped) this.schedule(attempt + 1);
			if (!socket.destroyed) socket.destroy();
		};
		socket.once("error", onTransportClosed);
		socket.once("close", onTransportClosed);
	}
	private schedule(attempt: number): void {
		if (this.stopped || this.retry) return;
		const delay = workerReconnectDelay(attempt, this.options.retryDelaysMs);
		this.retry = setTimeout(() => { this.retry = undefined; this.connect(attempt); }, delay);
	}
	private stopTerminal(cause: unknown): void {
		this.stopped = true;
		this.verified = false;
		if (this.retry) clearTimeout(this.retry);
		this.retry = undefined;
		this.rejectPendingSubmissions(cause instanceof Error ? cause : new ProtocolClientError(String(cause)));
		this.socket?.destroy();
	}
	private write(message: ProtocolEnvelope): void { if (this.socket && !this.socket.destroyed) this.socket.write(encodeJsonLine(message)); }
	private rememberSentWorkerEventId(messageId: string): void {
		if (this.sentWorkerEventIds.size >= MAX_SENT_WORKER_EVENT_IDS) {
			const oldest = this.sentWorkerEventIds.values().next().value as string | undefined;
			if (oldest !== undefined) this.sentWorkerEventIds.delete(oldest);
		}
		this.sentWorkerEventIds.add(messageId);
	}
	private rememberSeen(messageId: string, serialized: string): void {
		if (this.seen.size >= MAX_SEEN_SERVER_MESSAGES) {
			const oldest = this.seen.keys().next().value as string | undefined;
			if (oldest !== undefined) this.seen.delete(oldest);
		}
		this.seen.set(messageId, serialized);
	}
	private ignoreAcknowledgement(messageId: string): void {
		if (this.ignoredAcknowledgements.size >= MAX_IGNORED_ACKNOWLEDGEMENTS) {
			const oldest = this.ignoredAcknowledgements.values().next().value as string | undefined;
			if (oldest !== undefined) this.ignoredAcknowledgements.delete(oldest);
		}
		this.ignoredAcknowledgements.add(messageId);
	}
	private sendWorkerShutdown(): void {
		if (this.shutdownSent || !this.verified) return;
		this.shutdownSent = true;
		try { this.sendWorkerEvent("worker-shutdown", {}); } catch { /* the transport may already be closing */ }
	}

	sendWorkerEvent(type: Exclude<WorkerMessageType, "worker-connected">, payload: unknown, messageId: string = crypto.randomUUID()): string {
		if (!this.verified) throw new ProtocolClientError("Cannot send worker events before handshake verification");
		const identity = this.options.identity;
		const message = makeMessage(identity.runId, identity.workItemId, type, payload, messageId);
		// Use the same strict payload decoder as the receiving server before writing.
		decodeProtocolMessage(message);
		const envelope = snapshotEnvelope(message);
		if (!this.socket || this.socket.destroyed) throw new ProtocolClientError("Worker socket is unavailable");
		const reliable = requiresWorkerAcknowledgement(type);
		if (reliable) {
			if (this.pendingSubmissions.has(envelope.messageId)) throw new ProtocolClientError("Conflicting duplicate worker submission message ID");
			if (this.pendingSubmissions.size >= MAX_PENDING_SUBMISSIONS) throw new ProtocolClientError("Worker submission queue is full");
			this.pendingSubmissions.set(envelope.messageId, { envelope, waiter: undefined });
		}
		this.rememberSentWorkerEventId(envelope.messageId);
		try {
			this.write(envelope);
		} catch (cause) {
			// Keep reliable events even when the native write races socket close.
			// The close handler will trigger the reconnect path.
			if (reliable) this.socket?.destroy();
			else this.sentWorkerEventIds.delete(envelope.messageId);
			throw cause;
		}
		return envelope.messageId;
	}
	async submitWorkerEvent(type: "worker-progress" | "worker-report" | "worker-blocked" | "worker-failed", payload: unknown, signal?: AbortSignal): Promise<string> {
		if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
		if (!this.verified) throw new ProtocolClientError("Cannot send worker events before handshake verification");
		if (!this.socket || this.socket.destroyed) throw new ProtocolClientError("Worker socket is unavailable");
		if (this.pendingSubmissions.size >= MAX_PENDING_SUBMISSIONS) throw new ProtocolClientError("Worker submission queue is full");
		const identity = this.options.identity;
		const messageId = crypto.randomUUID();
		const message = makeMessage(identity.runId, identity.workItemId, type, payload, messageId);
		decodeProtocolMessage(message);
		const envelope = snapshotEnvelope(message);

		let waiter!: SubmissionWaiter;
		let abort!: () => void;
		let settled = false;
		const acknowledgement = new Promise<void>((resolve, reject) => {
			const cleanup = () => signal?.removeEventListener("abort", abort);
			waiter = {
				resolve: () => {
					if (settled) return;
					settled = true;
					cleanup();
					resolve();
				},
				reject: (cause) => {
					if (settled) return;
					settled = true;
					cleanup();
					reject(cause);
				},
			};
			abort = () => {
				if (settled) return;
				this.pendingSubmissions.delete(messageId);
				this.sentWorkerEventIds.delete(messageId);
				this.ignoreAcknowledgement(messageId);
				waiter.reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
			};
		});
		const pending: PendingSubmission = { envelope, waiter };
		this.pendingSubmissions.set(messageId, pending);
		signal?.addEventListener("abort", abort, { once: true });
		try {
			this.rememberSentWorkerEventId(messageId);
			this.write(envelope);
		} catch {
			// A failed native write is normally followed by close. Retain the
			// envelope and original waiter so reconnect can make delivery progress.
			this.socket?.destroy();
			if (!this.socket) this.schedule(0);
		}
		try {
			await acknowledgement;
			return messageId;
		} catch (cause) {
			if (this.pendingSubmissions.get(messageId) === pending) this.pendingSubmissions.delete(messageId);
			throw cause;
		}
	}
	private resendPendingSubmissions(): void {
		const socket = this.socket;
		if (!socket || socket.destroyed) return;
		for (const pending of this.pendingSubmissions.values()) {
			if (this.socket !== socket || socket.destroyed) return;
			try { this.write(pending.envelope); } catch { socket.destroy(); return; }
		}
	}
	private emitFeedback(event: WorkerFeedback): void {
		const waiter = this.feedbackWaiters.values().next().value as FeedbackWaiter | undefined;
		if (waiter) {
			this.feedbackWaiters.delete(waiter);
			waiter.resolve(event);
		} else {
			if (this.feedback.length >= MAX_FEEDBACK_MESSAGES) this.feedback.shift();
			this.feedback.push(event);
		}
	}
	waitForFeedback(signal?: AbortSignal, timeoutMs?: number): Promise<WorkerFeedback> {
		if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		const pending = this.feedback.shift();
		if (pending) return Promise.resolve(pending);
		if (this.feedbackWaiters.size >= MAX_FEEDBACK_WAITERS) return Promise.reject(new ProtocolClientError("Feedback wait queue is full"));
		return new Promise((resolve, reject) => {
			let waiter: FeedbackWaiter;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); };
			const abort = () => { this.feedbackWaiters.delete(waiter); cleanup(); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
			waiter = { reject, resolve: (event) => { cleanup(); resolve(event); } };
			if (signal?.aborted) { abort(); return; }
			this.feedbackWaiters.add(waiter);
			signal?.addEventListener("abort", abort, { once: true });
			if (timeoutMs !== undefined) timer = setTimeout(() => {
				this.feedbackWaiters.delete(waiter);
				cleanup();
				reject(new Error(`Feedback wait timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});
	}
	private rejectPendingSubmissions(cause: unknown): void {
		for (const pending of this.pendingSubmissions.values()) pending.waiter?.reject(cause);
		this.pendingSubmissions.clear();
	}
	private async receive(message: ProtocolEnvelope): Promise<void> {
		const id = this.options.identity;
		// The rejection response intentionally uses the server's expected identity, so
		// inspect it before identity matching to stop retries for every mismatch.
		if (message.type === "shutdown") {
			this.stopped = true; if (this.retry) clearTimeout(this.retry); this.retry = undefined;
			this.rejectPendingSubmissions(new ProtocolClientError("Worker protocol server rejected the connection"));
			this.sendWorkerShutdown();
			this.verified = false;
			this.emitFeedback({ type: "shutdown" });
			this.write(makeMessage(id.runId, id.workItemId, "accepted", { requestId: (message.payload as { requestId: string }).requestId }));
			try { await this.options.onShutdown(); } finally { this.socket?.end(); }
			return;
		}
		if (message.runId !== id.runId || message.workItemId !== id.workItemId) throw new ProtocolClientError("Server message identity mismatch");
		if (message.type === "accepted") {
			const requestId = (message.payload as { requestId: string }).requestId;
			if (!this.verified) {
				if (requestId !== this.handshakeMessageId) throw new ProtocolClientError("Handshake acknowledgement does not match the current connection");
				this.verified = true;
				if (!this.readySent) { this.readySent = true; this.write(makeMessage(id.runId, id.workItemId, "worker-ready", {})); }
				// Verification is the reconnect delivery barrier. Nothing from the
				// pending set is written before this acknowledgement arrives.
				this.resendPendingSubmissions();
				return;
			}
			if (requestId === this.handshakeMessageId) return;
			const submission = this.pendingSubmissions.get(requestId);
			if (submission) {
				this.pendingSubmissions.delete(requestId);
				this.sentWorkerEventIds.delete(requestId);
				this.ignoredAcknowledgements.delete(requestId);
				submission.waiter?.resolve();
			} else if (this.ignoredAcknowledgements.delete(requestId)) {
				// An acknowledgement racing an abort is intentionally ignored.
			} else if (this.sentWorkerEventIds.has(requestId)) this.sentWorkerEventIds.delete(requestId);
			else this.emitFeedback({ type: "accepted" });
			return;
		}
		if (message.type === "ping") return;
		if (message.type !== "delegate" && message.type !== "feedback") throw new ProtocolClientError("Worker received an unsupported server message");
		const serialized = JSON.stringify(message.payload); const previous = this.seen.get(message.messageId);
		if (previous !== undefined && previous !== serialized) throw new ProtocolClientError("Conflicting duplicate protocol message");
		if (previous === undefined) {
			this.rememberSeen(message.messageId, serialized);
			const payload = message.payload as { prompt?: string; message?: string; requestId: string };
			if (message.type === "delegate") {
				if (this.delegationMessageId !== undefined) throw new ProtocolClientError("Worker accepts exactly one delegation; a second delegation is conflicting");
				const context = decodeWorkerContext((message.payload as { context: unknown }).context);
				if (context.runId !== id.runId || context.workItemId !== id.workItemId) throw new ProtocolClientError("Authoritative context identity does not match the authenticated worker");
				if (context.actualLaunchProfile.provider !== id.provider || context.actualLaunchProfile.model !== id.model || context.actualLaunchProfile.thinking !== id.thinking) throw new ProtocolClientError("Authoritative context launch profile does not match the authenticated worker");
				this.context = context;
				this.delegationMessageId = message.messageId;
				await this.options.onDelegate(payload.prompt!, context);
			} else {
				const feedback = decodeFeedback(message.payload);
				this.emitFeedback(feedbackFromPayload(feedback));
				await this.options.onFeedback(feedback.message);
			}
		}
		this.write(makeMessage(id.runId, id.workItemId, "accepted", { requestId: (message.payload as { requestId: string }).requestId }));
	}
	shutdown(): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			if (!this.stopped) {
				this.stopped = true;
				if (this.retry) clearTimeout(this.retry);
				this.retry = undefined;
				this.sendWorkerShutdown();
				this.emitFeedback({ type: "shutdown" });
				this.socket?.end();
				this.socket = undefined;
			}
			const closed = new ProtocolClientError("Worker protocol client closed");
			this.rejectPendingSubmissions(closed);
			for (const waiter of this.feedbackWaiters) waiter.reject(closed);
			this.feedbackWaiters.clear();
			if (this.incoming) yield* Queue.shutdown(this.incoming);
			this.incoming = undefined;
			if (this.processor) yield* Fiber.interrupt(this.processor);
			this.processor = undefined;
		});
	}
}
