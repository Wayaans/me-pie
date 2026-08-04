import net, { type Socket } from "node:net";
import { Effect, Fiber, Queue } from "effect";
import type { WorkerIdentity } from "../domain.ts";
import { encodeJsonLine, JsonLineFramer } from "./framing.ts";
import { decodeProtocolMessage, makeMessage, type ProtocolEnvelope, type WorkerMessageType } from "./messages.ts";

export interface ProtocolClientOptions {
	readonly socketPath: string;
	readonly identity: WorkerIdentity;
	readonly token: string;
	readonly onDelegate: (prompt: string) => Promise<void> | void;
	readonly onFeedback: (message: string) => Promise<void> | void;
	readonly onShutdown: () => Promise<void> | void;
	readonly retryDelaysMs?: readonly number[];
}
export class ProtocolClientError extends Error { constructor(message: string) { super(message); this.name = "ProtocolClientError"; } }

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
	private readonly seen = new Map<string, string>();
	constructor(readonly options: ProtocolClientOptions) {}
	get isVerified(): boolean { return this.verified; }
	get isStopped(): boolean { return this.stopped; }
	start(): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			if (this.stopped || this.incoming) return;
			this.incoming = yield* Queue.unbounded<ProtocolEnvelope>();
			const consume = Effect.forever(Effect.gen({ self: this }, function* () {
				const message = yield* Queue.take(this.incoming!);
				yield* Effect.tryPromise({
					try: () => this.receive(message),
					catch: () => new ProtocolClientError("Terminal protocol receive error"),
				}).pipe(Effect.catch(() => Effect.sync(() => {
					this.stopped = true;
					this.verified = false;
					this.socket?.destroy();
				})));
			}));
			this.processor = Effect.runFork(consume);
			this.connect(0);
		});
	}
	private connect(attempt: number): void {
		if (this.stopped || this.socket) return;
		const socket = net.createConnection(this.options.socketPath); this.socket = socket;
		const framer = new JsonLineFramer();
		socket.once("connect", () => {
			const { identity } = this.options;
			const handshake = makeMessage(identity.runId, identity.workItemId, "worker-connected", {
				token: this.options.token, provider: identity.provider, model: identity.model, thinking: identity.thinking,
				...(identity.sessionId === undefined ? {} : { sessionId: identity.sessionId }), ...(identity.sessionFile === undefined ? {} : { sessionFile: identity.sessionFile }),
			});
			this.handshakeMessageId = handshake.messageId;
			socket.write(encodeJsonLine(handshake));
		});
		socket.on("data", (chunk: Buffer) => {
			try {
				for (const message of framer.push(chunk)) {
					if (!this.incoming || !Queue.offerUnsafe(this.incoming, message)) {
						this.stopped = true;
						socket.destroy();
					}
				}
			} catch { this.stopped = true; socket.destroy(); }
		});
		socket.once("error", () => undefined);
		socket.once("close", () => {
			if (this.socket === socket) this.socket = undefined;
			this.verified = false; this.readySent = false;
			if (!this.stopped) this.schedule(attempt + 1);
		});
	}
	private schedule(attempt: number): void {
		const delays = this.options.retryDelaysMs ?? [50, 100, 250, 500, 1_000]; const delay = delays[Math.min(attempt, delays.length - 1)] ?? 1_000;
		this.retry = setTimeout(() => { this.retry = undefined; this.connect(attempt); }, delay);
	}
	private write(message: ProtocolEnvelope): void { if (this.socket && !this.socket.destroyed) this.socket.write(encodeJsonLine(message)); }
	private sendWorkerShutdown(): void {
		if (this.shutdownSent || !this.verified) return;
		this.shutdownSent = true;
		this.sendWorkerEvent("worker-shutdown", {});
	}

	sendWorkerEvent(type: Exclude<WorkerMessageType, "worker-connected">, payload: unknown, messageId = crypto.randomUUID()): string {
		if (!this.verified) throw new ProtocolClientError("Cannot send worker events before handshake verification");
		const identity = this.options.identity;
		const message = makeMessage(identity.runId, identity.workItemId, type, payload, messageId);
		// Use the same strict payload decoder as the receiving server before writing.
		decodeProtocolMessage(message);
		if (!this.socket || this.socket.destroyed) throw new ProtocolClientError("Worker socket is unavailable");
		this.write(message);
		return message.messageId;
	}
	private async receive(message: ProtocolEnvelope): Promise<void> {
		const id = this.options.identity;
		// The rejection response intentionally uses the server's expected identity, so
		// inspect it before identity matching to stop retries for every mismatch.
		if (message.type === "shutdown") {
			this.stopped = true; if (this.retry) clearTimeout(this.retry); this.retry = undefined;
			this.sendWorkerShutdown();
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
			}
			return;
		}
		if (message.type === "ping") return;
		if (message.type !== "delegate" && message.type !== "feedback") throw new ProtocolClientError("Worker received an unsupported server message");
		const serialized = JSON.stringify(message.payload); const previous = this.seen.get(message.messageId);
		if (previous !== undefined && previous !== serialized) throw new ProtocolClientError("Conflicting duplicate protocol message");
		if (previous === undefined) {
			this.seen.set(message.messageId, serialized);
			const payload = message.payload as { prompt?: string; message?: string; requestId: string };
			if (message.type === "delegate") {
				if (this.delegationMessageId !== undefined) throw new ProtocolClientError("Worker accepts exactly one delegation; a second delegation is conflicting");
				this.delegationMessageId = message.messageId; await this.options.onDelegate(payload.prompt!);
			} else await this.options.onFeedback(payload.message!);
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
				this.socket?.end();
				this.socket = undefined;
			}
			if (this.incoming) yield* Queue.shutdown(this.incoming);
			this.incoming = undefined;
			if (this.processor) yield* Fiber.interrupt(this.processor);
			this.processor = undefined;
		});
	}
}
