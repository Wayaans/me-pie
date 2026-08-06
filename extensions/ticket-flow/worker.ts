import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { ThinkingLevel, WorkerIdentity, WorkerProfile, WorkerReport } from "./model.ts";
import { exactModelParts, THINKING_LEVELS } from "./model.ts";
import {
	formatWorkerReportMarkdown,
	renderTicketflowCall,
	renderTicketflowResult,
	runWithTicketflowProgress,
} from "./tool-ui.ts";
import {
	MAX_TRANSPORT_TEXT_BYTES,
	TRANSPORT_VERSION,
	WorkerReportSchema,
	type TransportCommand,
	type TransportIdentity,
	type TransportMessage,
	type TransportReportEvent,
	type TransportSettledEvent,
	JsonlFramer,
	decodeTransportMessage,
	encodeTransportMessage,
} from "./transport.ts";
import { TicketflowTransportError } from "./errors.ts";
import net, { type Socket } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";

const MAX_RETRY_DELAY_MS = 2_000;
const INITIAL_RETRY_DELAY_MS = 50;
const ReportParametersSchema = Type.Object({
	status: StringEnum(["completed", "blocked", "failed", "audit"] as const),
	summary: Type.String({ minLength: 1, maxLength: 16_384 }),
	commitIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 })),
	questions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 })),
	verdicts: Type.Optional(Type.Array(Type.Object({
		requirement: Type.String({ minLength: 1 }),
		verdict: StringEnum(["pass", "fail", "not-applicable"] as const),
		evidence: Type.String({ minLength: 1 }),
		fixes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	}, { additionalProperties: false }), { minItems: 1, maxItems: 100 })),
	findings: Type.Optional(Type.Array(Type.Object({
		id: Type.String({ minLength: 1 }),
		severity: StringEnum(["critical", "high", "medium", "low"] as const),
		finding: Type.String({ minLength: 1 }),
		evidence: Type.String({ minLength: 1 }),
		requirement: Type.Optional(Type.String({ minLength: 1 })),
		fix: Type.Optional(Type.String({ minLength: 1 })),
	}, { additionalProperties: false }), { maxItems: 100 })),
	auditedCommitIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 })),
}, { additionalProperties: false });
export { WorkerReportSchema as TicketflowReportSchema } from "./transport.ts";
export { WorkerReportSchema as TICKETFLOW_REPORT_SCHEMA } from "./transport.ts";
export { ReportParametersSchema as TicketflowReportParametersSchema };
export type TicketflowReportParameters = Static<typeof ReportParametersSchema>;
export type TicketflowReport = WorkerReport;

export interface WorkerBridgeOptions {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly socketPath: string;
	readonly runId: string;
	readonly assignmentId: string;
	readonly token: string;
	readonly requestedProfile: WorkerProfile;
	readonly resume?: boolean;
	readonly retryDelaysMs?: readonly number[];
}

export interface WorkerIdentityFromContext extends TransportIdentity {}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
function bridgeError(message: string, cause?: unknown): TicketflowTransportError {
	return new TicketflowTransportError({ message, ...(cause === undefined ? {} : { cause }) });
}
function control(value: string, field: string): void {
	if (!value || value !== value.trim() || /[\0\r\n]/.test(value)) throw bridgeError(`${field} is invalid.`);
}
function positiveTurn(value: number | undefined): number {
	if (value !== undefined && Number.isSafeInteger(value) && value > 0) return value;
	return 1;
}
function boundUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let result = "";
	let bytes = 0;
	for (const character of text) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > maxBytes) break;
		result += character; bytes += size;
	}
	return result;
}
function textResult(text: string, details: unknown): { content: [{ type: "text"; text: string }]; details: unknown; terminate: true } {
	return { content: [{ type: "text", text: boundUtf8(text, MAX_TRANSPORT_TEXT_BYTES) }], details, terminate: true };
}

function assertReportBound(report: WorkerReport): void {
	const text = JSON.stringify(report);
	if (Buffer.byteLength(text, "utf8") > MAX_TRANSPORT_TEXT_BYTES || text.split("\n").length > 1_500) throw bridgeError("ticketflow_report exceeds Ticket Flow transport bounds.");
}

/**
 * Derive the effective worker identity from Pi, rather than from launch
 * arguments.  Main authenticates both the requested and effective profiles.
 */
export function workerIdentityFromContext(context: Pick<ExtensionContext, "model" | "thinkingLevel" | "sessionManager">): WorkerIdentityFromContext {
	if (!context.model) throw bridgeError("Ticket Flow worker has no effective Pi model.");
	if (!context.thinkingLevel || !THINKING_LEVELS.includes(context.thinkingLevel as ThinkingLevel)) throw bridgeError("Ticket Flow worker has no effective Pi thinking level.");
	const runtimeSessionId = context.sessionManager.getSessionId();
	const sessionFile = context.sessionManager.getSessionFile();
	control(context.model.provider, "Effective provider");
	control(context.model.id, "Effective model");
	if (!runtimeSessionId) throw bridgeError("Ticket Flow worker requires a Pi session ID.");
	if (!sessionFile || !path.isAbsolute(sessionFile)) throw bridgeError("Ticket Flow worker requires an absolute Pi session file.");
	let sessionId = runtimeSessionId;
	try {
		const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n", 1)[0]!) as { readonly id?: unknown };
		if (typeof header.id === "string" && header.id) sessionId = header.id;
	} catch { /* A newly-created test/runtime file may not yet expose its header; Main still binds the exact file. */ }
	return {
		provider: context.model.provider,
		model: context.model.id,
		thinking: context.thinkingLevel as ThinkingLevel,
		sessionId,
		sessionFile,
	};
}

export const effectiveWorkerIdentity = workerIdentityFromContext;

function commandIdentity(command: TransportCommand): string { return JSON.stringify(command); }
function eventIdentity(event: TransportReportEvent | TransportSettledEvent): string { return JSON.stringify(event); }

interface EventWaiter {
	readonly resolve: () => void;
	readonly reject: (cause: unknown) => void;
}
interface PendingEvent {
	readonly message: TransportReportEvent | TransportSettledEvent;
	readonly serialized: string;
	readonly waiters: Set<EventWaiter>;
	lastSentAt: number;
}
interface ProcessedCommand {
	readonly serialized: string;
	readonly acknowledgement: Extract<TransportMessage, { type: "ack" }>;
}

/** Worker-side half of the authenticated Main bridge. */
export class WorkerChannel {
	private socket: Socket | undefined;
	private stopped = false;
	private connected = false;
	private ready = false;
	private reportToolRegistered = false;
	private settledListenerRegistered = false;
	private currentTurn = 0;
	private reportSubmitted = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectAttempt = 0;
	private processing: Promise<void> = Promise.resolve();
	private helloRequestId = crypto.randomUUID();
	private readonly pendingEvents = new Map<string, PendingEvent>();
	private readonly acknowledgedEvents = new Set<string>();
	private readonly processedCommands = new Map<string, ProcessedCommand>();
	private readonly commandInFlight = new Map<string, { readonly serialized: string; readonly promise: Promise<Extract<TransportMessage, { type: "ack" }>> }>();
	private activeContext: ExtensionContext;

	constructor(readonly options: WorkerBridgeOptions) {
		this.activeContext = options.ctx;
		control(options.runId, "runId"); control(options.assignmentId, "assignmentId");
		if (!options.token || /[\0\r\n]/.test(options.token)) throw bridgeError("Transport token is invalid.");
		if (!path.isAbsolute(options.socketPath) || Buffer.byteLength(options.socketPath) > 100) throw bridgeError("Worker transport socket path must be absolute and fit the Unix socket limit.");
		const parts = exactModelParts(options.requestedProfile.model);
		control(parts.provider, "Requested provider"); control(parts.model, "Requested model");
		if (!THINKING_LEVELS.includes(options.requestedProfile.thinking)) throw bridgeError("Requested thinking level is unsupported.");
		this.restoreSessionLedger();
	}

	get isConnected(): boolean { return this.connected; }
	get isVerified(): boolean { return this.ready; }
	get isReady(): boolean { return this.ready; }
	get currentWorkerTurn(): number { return this.currentTurn; }
	get currentTurnNumber(): number { return this.currentTurn; }
	get hasSubmittedReport(): boolean { return this.reportSubmitted; }

	/** Register exactly one worker-facing tool and one settlement listener. */
	start(): void {
		if (this.stopped) throw bridgeError("A closed WorkerChannel cannot be restarted.");
		this.registerReportTool();
		this.registerSettledListener();
		// Force Pi to materialize the session header before Main records the
		// identity. Without an entry, a never-prompted Worker may expose a future
		// path that does not yet exist and cannot retain its session ID on resume.
		this.appendLedger("ticketflow-worker-session", { runId: this.options.runId, assignmentId: this.options.assignmentId });
		this.connect();
	}

	registerReportTool(): void {
		if (this.reportToolRegistered) return;
		this.options.pi.registerTool({
			name: "ticketflow_report",
			label: "Ticket Flow report",
			description: "Submit the structured report for the current Ticket Flow assignment turn.",
			parameters: ReportParametersSchema,
			execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
				if (!Value.Check(WorkerReportSchema, params)) throw bridgeError("ticketflow_report parameters do not match the exact report union.");
				this.activeContext = ctx;
				if (this.currentTurn < 1) throw bridgeError("ticketflow_report is unavailable before Main sends the first task.");
				if (this.reportSubmitted) throw bridgeError("Only one Ticket Flow report may be submitted for a worker turn.");
				const report = params as WorkerReport;
				assertReportBound(report);
				this.reportSubmitted = true;
				const eventId = this.queueReport(report);
				// The worker may terminate its turn only after Main has durably persisted
				// and acknowledged the immutable report.
				await runWithTicketflowProgress("Submitting", onUpdate, () => this.waitForEventAcknowledgement(eventId, signal));
				return textResult("Ticket Flow report durably submitted.", report);
			},
			renderCall(args, theme) {
				return renderTicketflowCall("↥", "Report", args.status, theme);
			},
			renderResult(result, options, theme, context) {
				const report = options.isPartial || context.isError ? undefined : result.details as WorkerReport | undefined;
				return renderTicketflowResult(result, options, theme, context, {
					label: "Report submitted",
					...(report ? { markdown: formatWorkerReportMarkdown(report) } : {}),
				});
			},
			executionMode: "sequential",
		});
		this.reportToolRegistered = true;
	}

	private registerSettledListener(): void {
		if (this.settledListenerRegistered) return;
		this.options.pi.on("agent_settled", (_event, ctx) => {
			this.activeContext = ctx;
			if (this.currentTurn > 0) this.queueSettled();
		});
		this.settledListenerRegistered = true;
	}

	/** Queue a report without persisting it locally; Main owns durable report state. */
	submitReport(report: WorkerReport, turn = this.currentTurn || 1): string {
		if (!Value.Check(WorkerReportSchema, report)) throw bridgeError("Report does not match the exact Ticket Flow report union.");
		assertReportBound(report);
		const nextTurn = positiveTurn(turn);
		if (nextTurn !== this.currentTurn) this.reportSubmitted = false;
		this.currentTurn = nextTurn;
		if (this.reportSubmitted) throw bridgeError("Only one Ticket Flow report may be submitted for a worker turn.");
		this.reportSubmitted = true;
		return this.queueReport(report);
	}

	/** Enqueue the end-of-turn marker.  It is acknowledged only after Main's callback returns. */
	notifySettled(turn = this.currentTurn || 1): string {
		this.currentTurn = positiveTurn(turn);
		return this.queueSettled();
	}

	private queueReport(report: WorkerReport): string {
		if (!this.currentTurn) this.currentTurn = 1;
		const message: TransportReportEvent = {
			version: TRANSPORT_VERSION,
			type: "event",
			event: "report",
			eventId: crypto.randomUUID(),
			turn: this.currentTurn,
			report: report as TransportReportEvent["report"],
		};
		this.addPendingEvent(message);
		return message.eventId;
	}

	private queueSettled(): string {
		if (!this.currentTurn) this.currentTurn = 1;
		const message: TransportSettledEvent = {
			version: TRANSPORT_VERSION,
			type: "event",
			event: "settled",
			eventId: crypto.randomUUID(),
			turn: this.currentTurn,
			reportSubmitted: this.reportSubmitted,
		};
		this.addPendingEvent(message);
		return message.eventId;
	}

	private appendLedger(customType: string, data: unknown): void {
		const append = (this.options.pi as ExtensionAPI & { readonly appendEntry?: (type: string, value: unknown) => void }).appendEntry;
		if (typeof append === "function") append.call(this.options.pi, customType, data);
	}

	private restoreSessionLedger(): void {
		const manager = this.options.ctx.sessionManager as ExtensionContext["sessionManager"] & { readonly getEntries?: () => readonly unknown[] };
		if (typeof manager.getEntries !== "function") return;
		const pending = new Map<string, TransportReportEvent | TransportSettledEvent>();
		const acknowledged = new Set<string>();
		const commandIntents = new Map<string, TransportCommand>();
		for (const entry of manager.getEntries()) {
			if (!entry || typeof entry !== "object" || (entry as { readonly type?: unknown }).type !== "custom") continue;
			const custom = entry as { readonly customType?: unknown; readonly data?: unknown };
			const data = custom.data as { readonly runId?: unknown; readonly assignmentId?: unknown; readonly command?: unknown; readonly message?: unknown; readonly eventId?: unknown } | undefined;
			if (!data || data.runId !== this.options.runId || data.assignmentId !== this.options.assignmentId) continue;
			if (custom.customType === "ticketflow-worker-command-intent" || custom.customType === "ticketflow-worker-command") {
				try {
					const command = decodeTransportMessage(data.command);
					if (command.type !== "command") continue;
					if (custom.customType === "ticketflow-worker-command-intent") commandIntents.set(command.requestId, command);
					else {
						commandIntents.delete(command.requestId);
						const acknowledgement = { version: TRANSPORT_VERSION, type: "ack" as const, requestId: command.requestId };
						this.processedCommands.set(command.requestId, { serialized: commandIdentity(command), acknowledgement });
						if (command.turn !== undefined) this.currentTurn = Math.max(this.currentTurn, command.turn);
					}
				} catch { /* Ignore unrelated/corrupt historical custom entries. */ }
			} else if (custom.customType === "ticketflow-worker-event") {
				try {
					const message = decodeTransportMessage(data.message);
					if (message.type === "event") pending.set(message.eventId, message);
				} catch { /* Ignore unrelated/corrupt historical custom entries. */ }
			} else if (custom.customType === "ticketflow-worker-event-ack" && typeof data.eventId === "string") acknowledged.add(data.eventId);
		}
		for (const [requestId, command] of commandIntents) {
			this.processedCommands.set(requestId, {
				serialized: commandIdentity(command),
				acknowledgement: { version: TRANSPORT_VERSION, type: "ack", requestId, ok: false, error: "Worker command delivery outcome is ambiguous after process recovery; refusing duplicate execution." },
			});
		}
		for (const eventId of acknowledged) pending.delete(eventId);
		for (const message of pending.values()) this.addPendingEvent(message, false);
	}

	private addPendingEvent(message: TransportReportEvent | TransportSettledEvent, persist = true): void {
		const serialized = eventIdentity(message);
		if (persist) this.appendLedger("ticketflow-worker-event", { runId: this.options.runId, assignmentId: this.options.assignmentId, message });
		this.pendingEvents.set(message.eventId, { message, serialized, waiters: new Set(), lastSentAt: 0 });
		this.flushEvents();
	}

	private waitForEventAcknowledgement(eventId: string, signal?: AbortSignal): Promise<void> {
		if (this.acknowledgedEvents.has(eventId)) return Promise.resolve();
		const pending = this.pendingEvents.get(eventId);
		if (!pending) return Promise.reject(bridgeError("Unknown pending worker event."));
		return new Promise<void>((resolve, reject) => {
			let waiter: EventWaiter;
			const cleanup = () => { pending.waiters.delete(waiter); signal?.removeEventListener("abort", abort); };
			const abort = () => { cleanup(); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
			waiter = { resolve: () => { cleanup(); resolve(); }, reject: (cause) => { cleanup(); reject(cause); } };
			if (signal?.aborted) { abort(); return; }
			pending.waiters.add(waiter);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}

	private connect(): void {
		if (this.stopped || this.socket) return;
		const socket = net.createConnection(this.options.socketPath);
		this.socket = socket;
		this.connected = false;
		this.ready = false;
		const framer = new JsonlFramer();
		socket.setNoDelay(true);
		socket.once("connect", () => {
			if (this.socket !== socket || this.stopped) return;
			try {
				this.connected = true;
				this.reconnectAttempt = 0;
				const identity = workerIdentityFromContext(this.activeContext);
				const { provider: requestedProvider, model: requestedModel } = exactModelParts(this.options.requestedProfile.model);
				const hello: TransportMessage = {
					version: TRANSPORT_VERSION,
					type: "hello",
					requestId: this.helloRequestId,
					runId: this.options.runId,
					assignmentId: this.options.assignmentId,
					token: this.options.token,
					requestedProvider,
					requestedModel,
					requestedThinking: this.options.requestedProfile.thinking,
					effectiveProvider: identity.provider,
					effectiveModel: identity.model,
					effectiveThinking: identity.thinking,
					sessionId: identity.sessionId,
					sessionFile: identity.sessionFile,
				};
				socket.write(encodeTransportMessage(hello));
			} catch (cause) { this.failSocket(socket, cause); }
		});
		socket.on("data", (chunk: Buffer) => {
			try { for (const message of framer.push(chunk)) this.enqueue(() => this.receive(message)); }
			catch (cause) { this.failSocket(socket, cause); }
		});
		socket.once("error", () => undefined);
		socket.once("close", () => {
			if (this.socket !== socket) return;
			this.socket = undefined;
			this.connected = false;
			this.ready = false;
			if (!this.stopped) this.scheduleReconnect();
		});
	}

	private enqueue(operation: () => Promise<void>): void {
		this.processing = this.processing.then(operation, operation).catch((cause) => {
			if (this.socket) this.failSocket(this.socket, cause);
		});
	}
	private failSocket(socket: Socket, _cause: unknown): void { if (!socket.destroyed) socket.destroy(); }
	private scheduleReconnect(): void {
		if (this.reconnectTimer || this.stopped) return;
		const configured = this.options.retryDelaysMs;
		const delay = configured?.[Math.min(this.reconnectAttempt, configured.length - 1)] ?? Math.min(INITIAL_RETRY_DELAY_MS * 2 ** this.reconnectAttempt, MAX_RETRY_DELAY_MS);
		this.reconnectAttempt += 1;
		this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect(); }, delay);
	}

	private async receive(message: TransportMessage): Promise<void> {
		if (message.type === "reject") {
			this.stopped = true;
			if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
			const failure = bridgeError(`Main rejected the worker connection: ${message.reason}`);
			for (const pending of this.pendingEvents.values()) for (const waiter of pending.waiters) waiter.reject(failure);
			this.pendingEvents.clear();
			throw failure;
		}
		if (message.type === "ready") {
			if (message.requestId !== this.helloRequestId) throw bridgeError("Main ready acknowledgement does not match the worker handshake.");
			this.ready = true;
			this.write({ version: TRANSPORT_VERSION, type: "ack", requestId: message.requestId });
			this.flushEvents();
			return;
		}
		if (message.type === "ack") {
			if (message.requestId === this.helloRequestId) throw bridgeError("Main cannot acknowledge the worker handshake before ready.");
			const pending = this.pendingEvents.get(message.requestId);
			if (!pending) {
				if (this.acknowledgedEvents.has(message.requestId)) return;
				throw bridgeError("Main acknowledged an unknown worker event ID.");
			}
			this.pendingEvents.delete(message.requestId);
			this.acknowledgedEvents.add(message.requestId);
			this.appendLedger("ticketflow-worker-event-ack", { runId: this.options.runId, assignmentId: this.options.assignmentId, eventId: message.requestId });
			if (message.ok === false) {
				const failure = bridgeError(message.error ?? "Main permanently rejected the worker event.");
				for (const waiter of pending.waiters) waiter.reject(failure);
			} else {
				for (const waiter of pending.waiters) waiter.resolve();
			}
			pending.waiters.clear();
			return;
		}
		if (!this.ready) throw bridgeError("Worker received a command before Main marked the channel ready.");
		if (message.type !== "command") throw bridgeError("Worker received an unsupported transport message.");
		await this.dispatchCommand(message);
	}

	private write(message: TransportMessage): void {
		const socket = this.socket;
		if (!socket || socket.destroyed) throw bridgeError("Worker transport socket is unavailable.");
		socket.write(encodeTransportMessage(message));
	}

	private async dispatchCommand(command: TransportCommand): Promise<void> {
		const serialized = commandIdentity(command);
		const previous = this.processedCommands.get(command.requestId);
		if (previous) {
			if (previous.serialized !== serialized) throw bridgeError("Conflicting duplicate command request ID.");
			this.write(previous.acknowledgement);
			return;
		}
		const existing = this.commandInFlight.get(command.requestId);
		if (existing) {
			if (existing.serialized !== serialized) throw bridgeError("Conflicting duplicate command request ID.");
			const ack = await existing.promise;
			this.write(ack);
			return;
		}
		const operation = this.performCommand(command);
		this.commandInFlight.set(command.requestId, { serialized, promise: operation });
		try {
			const ack = await operation;
			this.processedCommands.set(command.requestId, { serialized, acknowledgement: ack });
			this.write(ack);
		} finally { this.commandInFlight.delete(command.requestId); }
	}

	private async performCommand(command: TransportCommand): Promise<Extract<TransportMessage, { type: "ack" }>> {
		try {
			this.appendLedger("ticketflow-worker-command-intent", { runId: this.options.runId, assignmentId: this.options.assignmentId, command });
			switch (command.command) {
				case "task":
					if (this.options.resume) throw bridgeError("A resumed Ticket Flow session never accepts the old initial task again; Main must send explicit follow-up work.");
					this.beginTurn(command.turn);
					// Intentionally no options: task is the exact initial user message.
					await Promise.resolve(this.options.pi.sendUserMessage(command.message));
					break;
				case "steer":
					this.beginTurn(command.turn);
					await Promise.resolve(this.options.pi.sendUserMessage(command.message, { deliverAs: "steer" }));
					break;
				case "follow-up":
					this.beginTurn(command.turn);
					await Promise.resolve(this.options.pi.sendUserMessage(command.message, typeof this.activeContext.isIdle === "function" && this.activeContext.isIdle() ? undefined : { deliverAs: "followUp" }));
					break;
				case "abort":
					await Promise.resolve(this.activeContext.abort());
					break;
				case "shutdown":
					await Promise.resolve(this.activeContext.shutdown());
					break;
			}
			this.appendLedger("ticketflow-worker-command", { runId: this.options.runId, assignmentId: this.options.assignmentId, command });
			return { version: TRANSPORT_VERSION, type: "ack", requestId: command.requestId };
		} catch (cause) {
			return { version: TRANSPORT_VERSION, type: "ack", requestId: command.requestId, ok: false, error: errorMessage(cause).slice(0, 4_096) };
		}
	}

	private beginTurn(turn: number): void {
		this.currentTurn = positiveTurn(turn);
		// A later task/steer/follow-up starts a fresh report window.  In
		// particular, a blocked report settles only this one window.
		this.reportSubmitted = false;
	}

	private flushEvents(): void {
		if (!this.ready || !this.socket || this.socket.destroyed) return;
		const now = Date.now();
		for (const pending of this.pendingEvents.values()) {
			if (now - pending.lastSentAt < 100) continue;
			pending.lastSentAt = now;
			try { this.socket.write(encodeTransportMessage(pending.message)); }
			catch { return; }
		}
		if (this.pendingEvents.size > 0) this.scheduleEventRetry();
	}
	private eventRetryTimer: ReturnType<typeof setTimeout> | undefined;
	private scheduleEventRetry(): void {
		if (this.eventRetryTimer || this.stopped) return;
		this.eventRetryTimer = setTimeout(() => { this.eventRetryTimer = undefined; this.flushEvents(); }, 250);
	}

	/** Used by tests and by a coordinator that needs to close without shutdown. */
	async close(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.eventRetryTimer) clearTimeout(this.eventRetryTimer);
		this.reconnectTimer = undefined; this.eventRetryTimer = undefined;
		const socket = this.socket; this.socket = undefined;
		if (socket && !socket.destroyed) socket.destroy();
		const closed = bridgeError("Ticket Flow worker bridge closed.");
		for (const pending of this.pendingEvents.values()) for (const waiter of pending.waiters) waiter.reject(closed);
		this.pendingEvents.clear();
		this.connected = false; this.ready = false;
	}
	shutdown(): Promise<void> { return this.close(); }
}

/** A descriptive alias for callers that use “bridge” rather than “channel”. */
export { WorkerChannel as WorkerBridge };
export function createWorkerChannel(options: WorkerBridgeOptions): WorkerChannel { return new WorkerChannel(options); }

export function registerTicketflowReportTool(_pi: ExtensionAPI, bridge: WorkerChannel): void {
	// The index decides whether the worker role is active.  This helper only
	// performs the worker tool registration and never opens a socket by itself.
	bridge.registerReportTool();
}
