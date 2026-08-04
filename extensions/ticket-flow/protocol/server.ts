import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net, { type Socket } from "node:net";
import path from "node:path";
import { Effect, Fiber, Queue } from "effect";
import type { PiLaunchProfile, WorkerIdentity } from "../domain.ts";
import { encodeJsonLine, JsonLineFramer } from "./framing.ts";
import { decodeWorkerConnected, makeMessage, toWorkflowEvent, type ProtocolEnvelope, type WorkflowProtocolEvent } from "./messages.ts";

export type ProtocolRejectionReason = "version" | "run" | "work-item" | "token" | "provider" | "model" | "thinking" | "protocol";
export interface ProtocolRejection { readonly reason: ProtocolRejectionReason; readonly actual?: WorkerIdentity; }
export interface ProtocolServerOptions {
	readonly socketPath: string;
	readonly runId: string;
	readonly workItemId: string;
	readonly token: string;
	readonly profile: PiLaunchProfile;
	readonly onEvent?: (event: WorkflowProtocolEvent) => Promise<void> | void;
	readonly onAcknowledgement?: (receipt: CommandReceipt) => Promise<void> | void;
	readonly onRejected?: (rejection: ProtocolRejection) => Promise<void> | void;
}
export interface CommandReceipt { readonly requestId: string; readonly messageId: string; }
export class ProtocolServerError extends Error { constructor(message: string) { super(message); this.name = "ProtocolServerError"; } }
interface Waiter { readonly predicate: (event: WorkflowProtocolEvent) => boolean; readonly resolve: (event: WorkflowProtocolEvent) => void; readonly reject: (cause: unknown) => void; }
interface AcknowledgementWaiter { readonly resolve: () => void; readonly reject: (cause: unknown) => void; }
interface PendingCommand { readonly receipt: CommandReceipt; readonly type: "delegate" | "feedback" | "shutdown"; readonly payload: Record<string, unknown>; acknowledged: boolean; readonly waiters: Set<AcknowledgementWaiter>; }
type IncomingMessage =
	| { readonly type: "message"; readonly socket: Socket; readonly message: ProtocolEnvelope }
	| { readonly type: "closed"; readonly socket: Socket };
function expectedProfile(profile: PiLaunchProfile): { provider: string; model: string } { const slash = profile.model.indexOf("/"); return { provider: profile.model.slice(0, slash), model: profile.model.slice(slash + 1) }; }
function commandPayload(payload: Record<string, unknown>): payload is Record<string, unknown> & { readonly requestId: string } { return typeof payload.requestId === "string"; }
function requiresWorkerAcknowledgement(type: ProtocolEnvelope["type"]): boolean {
	return type === "worker-progress" || type === "worker-report" || type === "worker-blocked" || type === "worker-failed";
}

export class ProtocolServer {
	private server: net.Server | undefined;
	private peer: Socket | undefined;
	private verified = false;
	private closed = false;
	private incoming: Queue.Queue<IncomingMessage> | undefined;
	private processor: Fiber.Fiber<void> | undefined;
	private readonly events: WorkflowProtocolEvent[] = [];
	private readonly pendingEvents: WorkflowProtocolEvent[] = [];
	private readonly waiters = new Set<Waiter>();
	private readonly seenIncoming = new Map<string, string>();
	private readonly pendingCommands = new Map<string, PendingCommand>();
	constructor(readonly options: ProtocolServerOptions) {}
	get isVerified(): boolean { return this.verified; }
	get identity(): WorkerIdentity | undefined { return this.events.find((event) => event.type === "worker-connected")?.identity; }

	start(): Effect.Effect<void, ProtocolServerError> {
		return Effect.gen({ self: this }, function* () {
			if (!this.incoming) {
				this.incoming = yield* Queue.unbounded<IncomingMessage>();
				const consume = Effect.forever(Effect.gen({ self: this }, function* () {
					const incoming = yield* Queue.take(this.incoming!);
					if (incoming.type === "closed") {
						if (this.peer === incoming.socket) {
							this.peer = undefined;
							this.verified = false;
						}
						return;
					}
					yield* Effect.tryPromise({
						try: () => this.receive(incoming.socket, incoming.message),
						catch: () => new ProtocolServerError("Protocol receive error"),
					}).pipe(Effect.catch(() => Effect.sync(() => this.reject(incoming.socket))));
				}));
				this.processor = Effect.runFork(consume);
			}
			yield* Effect.tryPromise({
				try: () => this.startPromise(),
				catch: (cause) => new ProtocolServerError(cause instanceof Error ? cause.message : String(cause)),
			});
		}).pipe(Effect.onError(() => this.shutdown()));
	}
	private async startPromise(): Promise<void> {
		if (this.closed) throw new ProtocolServerError("Closed protocol server cannot be restarted");
		if (this.server) return;
		await mkdir(path.dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
		await chmod(path.dirname(this.options.socketPath), 0o700);
		const ownerPath = `${this.options.socketPath}.owner`;
		let existing: Awaited<ReturnType<typeof lstat>> | undefined;
		try { existing = await lstat(this.options.socketPath); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
		if (existing) {
			const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
			let owner: string; try { owner = await readFile(ownerPath, "utf8"); } catch { throw new ProtocolServerError("Refusing to replace a stale protocol path without a run ownership marker"); }
			if (!existing.isSocket() || (uid !== undefined && existing.uid !== uid) || owner !== this.options.runId) throw new ProtocolServerError("Refusing to replace a stale protocol path not owned by this run");
			await rm(this.options.socketPath);
		}
		await writeFile(ownerPath, this.options.runId, { encoding: "utf8", mode: 0o600, flag: "w" }); await chmod(ownerPath, 0o600);
		const server = net.createServer((socket) => this.accept(socket));
		try {
			await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.options.socketPath, () => { server.off("error", reject); resolve(); }); });
			await chmod(this.options.socketPath, 0o600); this.server = server;
		} catch (cause) { await rm(ownerPath, { force: true }); throw cause; }
	}
	private accept(socket: Socket): void {
		if (this.closed || this.peer !== undefined) { socket.destroy(); return; }
		this.peer = socket;
		const framer = new JsonLineFramer();
		socket.on("data", (chunk: Buffer) => {
			try {
				for (const message of framer.push(chunk)) {
					if (!this.incoming || !Queue.offerUnsafe(this.incoming, { type: "message", socket, message })) this.reject(socket);
				}
			} catch { void this.options.onRejected?.({ reason: "protocol" }); this.reject(socket); }
		});
		socket.once("close", () => {
			if (!this.incoming || !Queue.offerUnsafe(this.incoming, { type: "closed", socket })) {
				if (this.peer === socket) {
					this.peer = undefined;
					this.verified = false;
				}
			}
		});
		socket.once("error", () => undefined);
	}
	private async receive(socket: Socket, message: ProtocolEnvelope): Promise<void> {
		const serialized = JSON.stringify(message);
		const previous = this.seenIncoming.get(message.messageId);
		if (previous !== undefined) {
			if (previous !== serialized) return this.reject(socket);
			if ((message.type === "worker-connected" && this.verified) || requiresWorkerAcknowledgement(message.type)) {
				this.write(makeMessage(this.options.runId, this.options.workItemId, "accepted", { requestId: message.messageId }));
			}
			return;
		}
		this.seenIncoming.set(message.messageId, serialized);
		try {
			if (!this.verified) {
				if (message.type !== "worker-connected") throw new ProtocolServerError("Worker sent a command before authentication");
				const payload = decodeWorkerConnected(message.payload);
				const expected = expectedProfile(this.options.profile);
				const actual: WorkerIdentity = { runId: message.runId, workItemId: message.workItemId, provider: payload.provider, model: payload.model, thinking: payload.thinking, ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }), ...(payload.sessionFile === undefined ? {} : { sessionFile: payload.sessionFile }) };
				const reason: ProtocolRejectionReason | undefined = message.runId !== this.options.runId ? "run"
					: message.workItemId !== this.options.workItemId ? "work-item"
					: payload.token !== this.options.token ? "token"
					: payload.provider !== expected.provider ? "provider"
					: payload.model !== expected.model ? "model"
					: payload.thinking !== this.options.profile.thinking ? "thinking"
					: undefined;
				if (reason) { await this.options.onRejected?.({ reason, actual }); throw new ProtocolServerError(`Worker ${reason} does not match the requested worker`); }
				const reconnecting = this.events.some((event) => event.type === "worker-connected");
				this.verified = true;
				this.write(makeMessage(this.options.runId, this.options.workItemId, "accepted", { requestId: message.messageId }));
				const event = toWorkflowEvent(message)!;
				this.emit(event);
				await this.options.onEvent?.(event);
				if (reconnecting) this.resendPendingCommands();
				return;
			}
			if (message.runId !== this.options.runId || message.workItemId !== this.options.workItemId) throw new ProtocolServerError("Worker message identity changed after verification");
			if (message.type === "accepted") { await this.acceptAcknowledgement((message.payload as { requestId: string }).requestId); return; }
			const event = toWorkflowEvent(message);
			if (event) {
				// Shutdown is a transport-level lifecycle notification. Do not await
				// the serialized controller callback before processing the command
				// acknowledgement: the controller may be waiting for that ack while
				// holding its progression permit.
				if (event.type === "worker-shutdown") {
					this.emit(event);
					void Promise.resolve(this.options.onEvent?.(event)).catch(() => undefined);
					return;
				}
				await this.options.onEvent?.(event);
				this.emit(event);
				if (requiresWorkerAcknowledgement(message.type)) this.write(makeMessage(this.options.runId, this.options.workItemId, "accepted", { requestId: message.messageId }));
			}
		} catch { this.reject(socket); }
	}
	private reject(socket: Socket): void {
		try { socket.end(encodeJsonLine(makeMessage(this.options.runId, this.options.workItemId, "shutdown", { requestId: crypto.randomUUID(), reason: "identity-rejected" }))); } catch { socket.destroy(); }
	}
	private emit(event: WorkflowProtocolEvent): void {
		this.events.push(event);
		const waiter = [...this.waiters].find((candidate) => candidate.predicate(event));
		if (waiter) {
			this.waiters.delete(waiter);
			waiter.resolve(event);
		} else {
			this.pendingEvents.push(event);
		}
	}
	wait(predicate: (event: WorkflowProtocolEvent) => boolean = () => true, signal?: AbortSignal): Promise<WorkflowProtocolEvent> {
		const pendingIndex = this.pendingEvents.findIndex(predicate);
		if (pendingIndex >= 0) return Promise.resolve(this.pendingEvents.splice(pendingIndex, 1)[0]!);
		return new Promise((resolve, reject) => {
			let waiter: Waiter;
			const abort = () => { this.waiters.delete(waiter); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
			waiter = { predicate, reject, resolve: (event) => { signal?.removeEventListener("abort", abort); resolve(event); } };
			if (signal?.aborted) { abort(); return; }
			this.waiters.add(waiter);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}
	private write(message: ProtocolEnvelope): void { if (!this.peer || this.peer.destroyed) throw new ProtocolServerError("Native worker socket is unavailable"); this.peer.write(encodeJsonLine(message)); }
	send(type: "delegate" | "feedback" | "accepted" | "shutdown" | "ping", payload: Record<string, unknown>, messageId: string = crypto.randomUUID()): CommandReceipt | undefined {
		if (!this.verified) throw new ProtocolServerError("Cannot send before worker profile verification");
		if (type !== "delegate" && type !== "feedback" && type !== "shutdown") { this.write(makeMessage(this.options.runId, this.options.workItemId, type, payload, messageId)); return undefined; }
		if (!commandPayload(payload) || typeof payload.requestId !== "string") throw new ProtocolServerError(`${type} requires a request ID`);
		const requestId = payload.requestId;
		const existing = this.pendingCommands.get(requestId);
		if (existing) {
			if (existing.type !== type || JSON.stringify(existing.payload) !== JSON.stringify(payload)) throw new ProtocolServerError("Conflicting duplicate command request ID");
			this.write(makeMessage(this.options.runId, this.options.workItemId, type, payload, existing.receipt.messageId)); return existing.receipt;
		}
		const receipt = { requestId, messageId };
		this.pendingCommands.set(receipt.requestId, { receipt, type, payload, acknowledged: false, waiters: new Set() }); this.write(makeMessage(this.options.runId, this.options.workItemId, type, payload, messageId)); return receipt;
	}
	private resendPendingCommands(): void {
		for (const command of this.pendingCommands.values()) {
			if (!command.acknowledged) {
				this.write(makeMessage(this.options.runId, this.options.workItemId, command.type, command.payload, command.receipt.messageId));
			}
		}
	}
	private async acceptAcknowledgement(requestId: string): Promise<void> {
		const command = this.pendingCommands.get(requestId);
		if (!command) throw new ProtocolServerError("Acknowledgement does not match a pending command");
		if (command.acknowledged) return;
		command.acknowledged = true;
		// Resolve transport waiters before persisting the acknowledgement. The
		// controller may be holding its progression permit while waiting for this
		// receipt; persisting first would deadlock that serialized operation.
		for (const waiter of command.waiters) waiter.resolve();
		command.waiters.clear();
		await this.options.onAcknowledgement?.(command.receipt);
	}
	waitForAcknowledgement(requestId: string, signal?: AbortSignal): Promise<CommandReceipt> {
		const command = this.pendingCommands.get(requestId); if (!command) return Promise.reject(new ProtocolServerError("Unknown command request ID"));
		if (command.acknowledged) return Promise.resolve(command.receipt);
		return new Promise((resolve, reject) => {
			let waiter: AcknowledgementWaiter;
			const done = () => { signal?.removeEventListener("abort", abort); resolve(command.receipt); };
			const abort = () => { command.waiters.delete(waiter); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
			waiter = { resolve: done, reject };
			if (signal?.aborted) { abort(); return; }
			command.waiters.add(waiter);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}
	shutdown(): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			if (this.closed) return;
			this.closed = true;
			const closed = new ProtocolServerError("Protocol server closed");
			for (const waiter of this.waiters) waiter.reject(closed);
			this.waiters.clear();
			for (const command of this.pendingCommands.values()) {
				for (const waiter of command.waiters) waiter.reject(closed);
				command.waiters.clear();
			}
			if (this.peer && !this.peer.destroyed) this.peer.destroy();
			const server = this.server;
			this.server = undefined;
			if (server) yield* Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())));
			if (this.incoming) yield* Queue.shutdown(this.incoming);
			this.incoming = undefined;
			if (this.processor) yield* Fiber.interrupt(this.processor);
			this.processor = undefined;
			yield* Effect.promise(() => rm(this.options.socketPath, { force: true }).catch(() => undefined));
			yield* Effect.promise(() => rm(`${this.options.socketPath}.owner`, { force: true }).catch(() => undefined));
		});
	}
}
