import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { Assignment, WorkerIdentity, WorkerProfile, WorkerReport } from "./model.ts";
import { exactModelParts, THINKING_LEVELS } from "./model.ts";
import { TicketflowTransportError } from "./errors.ts";

/** The wire format is deliberately small.  A frame is one complete UTF-8 JSON value. */
export const TRANSPORT_VERSION = 1 as const;
export const MAX_TRANSPORT_LINE_BYTES = 64 * 1024;
export const MAX_TRANSPORT_BUFFER_BYTES = 128 * 1024;
export const MAX_FRAME_BYTES = MAX_TRANSPORT_LINE_BYTES;
export const MAX_BUFFER_BYTES = MAX_TRANSPORT_BUFFER_BYTES;
export const MAX_TRANSPORT_TEXT_BYTES = 48 * 1024;
export const MAX_TRANSPORT_LINES = 2_000;

const MAX_ID_LENGTH = 256;
const MAX_REPORT_ARRAY = 100;
const MAX_SUMMARY_LENGTH = 16_384;
const MAX_EVIDENCE_LENGTH = 16_384;
const MAX_FINDING_LENGTH = 16_384;
const MAX_STRING_LENGTH = 32_768;

const NonEmpty = Type.String({ minLength: 1, maxLength: MAX_STRING_LENGTH });
const Identifier = Type.String({ minLength: 1, maxLength: MAX_ID_LENGTH, pattern: "^[^\\u0000\\r\\n\\s]+$" });
const Thinking = Type.Union([
	Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"),
	Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
]);
const Provider = Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000\\r\\n\\s/]+$" });
const Model = Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000\\r\\n\\s]+$" });
const AbsolutePath = Type.String({ minLength: 1, maxLength: 4_096, pattern: "^/[^\\u0000\\r\\n]*$" });

const RequirementVerdictSchema = Type.Object({
	requirement: Type.String({ minLength: 1, maxLength: MAX_EVIDENCE_LENGTH }),
	verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("not-applicable")]),
	evidence: Type.String({ minLength: 1, maxLength: MAX_EVIDENCE_LENGTH }),
	fixes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: MAX_EVIDENCE_LENGTH }), { maxItems: MAX_REPORT_ARRAY })),
}, { additionalProperties: false });

const AuditFindingSchema = Type.Object({
	id: Identifier,
	severity: Type.Union([Type.Literal("critical"), Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
	finding: Type.String({ minLength: 1, maxLength: MAX_FINDING_LENGTH }),
	evidence: Type.String({ minLength: 1, maxLength: MAX_EVIDENCE_LENGTH }),
	requirement: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_EVIDENCE_LENGTH })),
	fix: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_EVIDENCE_LENGTH })),
}, { additionalProperties: false });

/** The report tool and the transport use precisely the durable WorkerReport union. */
export const WorkerReportSchema = Type.Union([
	Type.Object({
		status: Type.Literal("completed"),
		summary: Type.String({ minLength: 1, maxLength: MAX_SUMMARY_LENGTH }),
		commitIds: Type.Array(Identifier, { minItems: 1, maxItems: MAX_REPORT_ARRAY }),
	}, { additionalProperties: false }),
	Type.Object({
		status: Type.Literal("blocked"),
		summary: Type.String({ minLength: 1, maxLength: MAX_SUMMARY_LENGTH }),
		questions: Type.Array(Type.String({ minLength: 1, maxLength: MAX_EVIDENCE_LENGTH }), { minItems: 1, maxItems: MAX_REPORT_ARRAY }),
	}, { additionalProperties: false }),
	Type.Object({
		status: Type.Literal("failed"),
		summary: Type.String({ minLength: 1, maxLength: MAX_SUMMARY_LENGTH }),
	}, { additionalProperties: false }),
	Type.Object({
		status: Type.Literal("audit"),
		summary: Type.String({ minLength: 1, maxLength: MAX_SUMMARY_LENGTH }),
		verdicts: Type.Array(RequirementVerdictSchema, { minItems: 1, maxItems: MAX_REPORT_ARRAY }),
		findings: Type.Array(AuditFindingSchema, { maxItems: MAX_REPORT_ARRAY }),
		auditedCommitIds: Type.Array(Identifier, { maxItems: MAX_REPORT_ARRAY }),
	}, { additionalProperties: false }),
]);
export type TransportWorkerReport = Static<typeof WorkerReportSchema>;
export const TicketflowReportSchema = WorkerReportSchema;
export const TICKETFLOW_REPORT_SCHEMA = WorkerReportSchema;

const HelloSchema = Type.Object({
	version: Type.Literal(TRANSPORT_VERSION),
	type: Type.Literal("hello"),
	requestId: Identifier,
	runId: Identifier,
	assignmentId: Identifier,
	token: NonEmpty,
	requestedProvider: Provider,
	requestedModel: Model,
	requestedThinking: Thinking,
	effectiveProvider: Provider,
	effectiveModel: Model,
	effectiveThinking: Thinking,
	sessionId: Identifier,
	sessionFile: AbsolutePath,
}, { additionalProperties: false });

const TaskCommandSchema = Type.Object({
	version: Type.Literal(TRANSPORT_VERSION),
	type: Type.Literal("command"),
	command: Type.Literal("task"),
	requestId: Identifier,
	turn: Type.Integer({ minimum: 1 }),
	message: Type.String({ minLength: 1, maxLength: MAX_STRING_LENGTH }),
}, { additionalProperties: false });
const MessageCommandSchema = Type.Object({
	version: Type.Literal(TRANSPORT_VERSION),
	type: Type.Literal("command"),
	command: Type.Union([Type.Literal("steer"), Type.Literal("follow-up")]),
	requestId: Identifier,
	turn: Type.Integer({ minimum: 1 }),
	message: Type.String({ minLength: 1, maxLength: MAX_STRING_LENGTH }),
}, { additionalProperties: false });
const ControlCommandSchema = Type.Object({
	version: Type.Literal(TRANSPORT_VERSION),
	type: Type.Literal("command"),
	command: Type.Union([Type.Literal("abort"), Type.Literal("shutdown")]),
	requestId: Identifier,
	turn: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

const ReportEventSchema = Type.Object({
	version: Type.Literal(TRANSPORT_VERSION),
	type: Type.Literal("event"),
	eventId: Identifier,
	event: Type.Literal("report"),
	turn: Type.Integer({ minimum: 1 }),
	report: WorkerReportSchema,
}, { additionalProperties: false });
const SettledEventSchema = Type.Object({
	version: Type.Literal(TRANSPORT_VERSION),
	type: Type.Literal("event"),
	eventId: Identifier,
	event: Type.Literal("settled"),
	turn: Type.Integer({ minimum: 1 }),
	reportSubmitted: Type.Boolean(),
}, { additionalProperties: false });

const AckSchema = Type.Object({
	version: Type.Literal(TRANSPORT_VERSION),
	type: Type.Literal("ack"),
	requestId: Identifier,
	ok: Type.Optional(Type.Boolean()),
	error: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
}, { additionalProperties: false });
const ReadySchema = Type.Object({
	version: Type.Literal(TRANSPORT_VERSION),
	type: Type.Literal("ready"),
	requestId: Identifier,
}, { additionalProperties: false });
const RejectSchema = Type.Object({
	version: Type.Literal(TRANSPORT_VERSION),
	type: Type.Literal("reject"),
	reason: Type.String({ minLength: 1, maxLength: 512 }),
}, { additionalProperties: false });

export const TransportHelloSchema = HelloSchema;
export const TransportTaskSchema = TaskCommandSchema;
export const TransportMessageCommandSchema = MessageCommandSchema;
export const TransportControlSchema = ControlCommandSchema;
export const TransportReportEventSchema = ReportEventSchema;
export const TransportSettledEventSchema = SettledEventSchema;
export const TransportAckSchema = AckSchema;
export const TransportReadySchema = ReadySchema;

export const TransportMessageSchema = Type.Union([
	HelloSchema,
	TaskCommandSchema,
	MessageCommandSchema,
	ControlCommandSchema,
	ReportEventSchema,
	SettledEventSchema,
	AckSchema,
	ReadySchema,
	RejectSchema,
]);
export type TransportMessage = Static<typeof TransportMessageSchema>;
export type TransportCommand = Static<typeof TaskCommandSchema> | Static<typeof MessageCommandSchema> | Static<typeof ControlCommandSchema>;
export type TransportReportEvent = Static<typeof ReportEventSchema>;
export type TransportSettledEvent = Static<typeof SettledEventSchema>;
export type ReportEvent = TransportReportEvent;
export type SettledEvent = TransportSettledEvent;
export type TransportReady = TransportIdentity;
export type TransportIdentity = Pick<WorkerIdentity, "provider" | "model" | "thinking" | "sessionId" | "sessionFile">;

export class PermanentTransportEventError extends Error {
	constructor(message: string) { super(message); this.name = "PermanentTransportEventError"; }
}

export interface CommandReceipt {
	readonly requestId: string;
	readonly command: TransportCommand["command"];
}

export interface TransportServerOptions {
	readonly socketPath: string;
	readonly runId: string;
	readonly assignmentId: string;
	readonly token: string;
	readonly requestedProfile: WorkerProfile;
	readonly onReady?: (identity: TransportIdentity) => Promise<void> | void;
	readonly onReport?: (event: TransportReportEvent) => Promise<void> | void;
	readonly onSettled?: (event: TransportSettledEvent) => Promise<void> | void;
	/** More explicit aliases are useful to coordinators which keep callbacks grouped by worker. */
	readonly ready?: (identity: TransportIdentity) => Promise<void> | void;
	readonly report?: (event: TransportReportEvent) => Promise<void> | void;
	readonly settled?: (event: TransportSettledEvent) => Promise<void> | void;
	readonly onWorkerReady?: (identity: TransportIdentity) => Promise<void> | void;
	readonly onWorkerReport?: (event: TransportReportEvent) => Promise<void> | void;
	readonly onWorkerSettled?: (event: TransportSettledEvent) => Promise<void> | void;
}

export interface SendTaskInput { readonly command: "task"; readonly message?: string; readonly prompt?: string; readonly turn?: number; readonly requestId?: string }
export interface SendMessageInput { readonly command: "steer" | "follow-up"; readonly message: string; readonly turn?: number; readonly requestId?: string }
export interface SendControlInput { readonly command: "abort" | "shutdown"; readonly turn?: number; readonly requestId?: string }
export type SendInput = SendTaskInput | SendMessageInput | SendControlInput | {
	readonly type: "task" | "steer" | "follow-up" | "abort" | "shutdown";
	readonly message?: string;
	readonly prompt?: string;
	readonly turn?: number;
	readonly requestId?: string;
};

interface PendingCommand {
	readonly wire: TransportCommand;
	readonly receipt: CommandReceipt;
	acknowledged: boolean;
	readonly waiters: Set<PendingWaiter>;
}
interface PendingWaiter {
	readonly resolve: (receipt: CommandReceipt) => void;
	readonly reject: (cause: unknown) => void;
}
interface SettlementWaiter {
	readonly turn: number;
	readonly resolve: (event: TransportSettledEvent) => void;
	readonly reject: (cause: unknown) => void;
}
interface ReadyWaiter {
	readonly resolve: (identity: TransportIdentity) => void;
	readonly reject: (cause: unknown) => void;
}
function transportError(message: string, cause?: unknown): TicketflowTransportError {
	return new TicketflowTransportError({ message, ...(cause === undefined ? {} : { cause }) });
}
function reasonOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
function assertControlString(value: string, name: string): void {
	if (!value || value !== value.trim() || /[\0\r\n]/.test(value)) throw transportError(`${name} is invalid.`);
}
function assertSocketPath(socketPath: string): void {
	if (!path.isAbsolute(socketPath) || /[\0\r\n]/.test(socketPath) || Buffer.byteLength(socketPath) > 100) throw transportError("Transport socket path must be absolute, control-free, and fit the Unix socket limit.");
}
function exactProfile(profile: WorkerProfile): { readonly provider: string; readonly model: string } {
	const parts = exactModelParts(profile.model);
	assertControlString(profile.thinking, "Requested thinking level");
	if (!THINKING_LEVELS.includes(profile.thinking)) throw transportError("Requested thinking level is unsupported.");
	return parts;
}
function safeEqual(left: string, right: string): boolean {
	// Tokens are random opaque strings.  Keeping comparison constant-shape avoids
	// accidentally turning authentication into an ordinary string-prefix check.
	if (left.length !== right.length) return false;
	let different = 0;
	for (let index = 0; index < left.length; index += 1) different |= left.charCodeAt(index) ^ right.charCodeAt(index);
	return different === 0;
}
function jsonBytes(value: unknown): Buffer {
	let serialized: string;
	try { serialized = JSON.stringify(value); } catch (cause) { throw transportError("Transport message is not JSON serializable.", cause); }
	const bytes = Buffer.from(`${serialized}\n`, "utf8");
	if (bytes.length > MAX_TRANSPORT_LINE_BYTES) throw transportError("Transport message exceeds the maximum UTF-8 JSONL frame size.");
	return bytes;
}
function assertMessage(value: unknown): asserts value is TransportMessage {
	if (!Value.Check(TransportMessageSchema, value)) throw transportError("Transport message does not match its strict schema.");
	const inspect = (entry: unknown): void => {
		if (typeof entry === "string") {
			if (entry.includes("\0") || Buffer.byteLength(entry, "utf8") > MAX_TRANSPORT_TEXT_BYTES || entry.split("\n").length > MAX_TRANSPORT_LINES) throw transportError("Transport text exceeds its control, byte, or line bound.");
			return;
		}
		if (Array.isArray(entry)) { for (const item of entry) inspect(item); return; }
		if (entry && typeof entry === "object") for (const item of Object.values(entry)) inspect(item);
	};
	inspect(value);
}
function encode(value: TransportMessage): Buffer {
	assertMessage(value);
	return jsonBytes(value);
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
export class JsonlFramer {
	private buffer = Buffer.alloc(0);
	push(chunk: Uint8Array): TransportMessage[] {
		this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
		if (this.buffer.length > MAX_TRANSPORT_BUFFER_BYTES) throw transportError("Transport receive buffer exceeds its bound.");
		const messages: TransportMessage[] = [];
		for (;;) {
			const newline = this.buffer.indexOf(0x0a);
			if (newline < 0) break;
			if (newline + 1 > MAX_TRANSPORT_LINE_BYTES) throw transportError("Transport JSONL frame exceeds its bound.");
			let frame = this.buffer.subarray(0, newline);
			this.buffer = this.buffer.subarray(newline + 1);
			if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
			if (frame.length === 0) throw transportError("Transport JSONL frames cannot be empty.");
			let value: unknown;
			try { value = JSON.parse(utf8Decoder.decode(frame)); }
			catch (cause) { throw transportError("Transport frame is not valid UTF-8 JSON.", cause); }
			assertMessage(value);
			messages.push(value);
		}
		if (this.buffer.length > MAX_TRANSPORT_LINE_BYTES) throw transportError("Transport JSONL frame exceeds its bound.");
		return messages;
	}
}

export { JsonlFramer as JsonLineFramer };

function identityFromHello(message: Static<typeof HelloSchema>): TransportIdentity {
	return {
		provider: message.effectiveProvider,
		model: message.effectiveModel,
		thinking: message.effectiveThinking,
		sessionId: message.sessionId,
		sessionFile: message.sessionFile,
	};
}
function messageIdentity(message: TransportMessage): string {
	const canonical = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(canonical);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
		return value;
	};
	return JSON.stringify(canonical(message));
}
function abortError(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError");
}
/** Main-side authenticated Unix socket server.  The coordinator owns persistence. */
export class TransportServer {
	private server: Server | undefined;
	private peer: Socket | undefined;
	private started = false;
	private closed = false;
	private authenticated = false;
	private ready = false;
	private identity: TransportIdentity | undefined;
	private readyFailure: unknown;
	private processing: Promise<void> = Promise.resolve();
	private readonly pendingCommands = new Map<string, PendingCommand>();
	private readonly acknowledgedCommands = new Set<string>();
	private readonly completedCommands = new Map<string, { readonly wire: TransportCommand; readonly receipt: CommandReceipt; readonly error?: string }>();
	private readonly receivedEvents = new Map<string, string>();
	private readonly eventInFlight = new Map<string, Promise<void>>();
	private readonly pendingSettlements = new Map<number, TransportSettledEvent>();
	private readonly settlementWaiters = new Set<SettlementWaiter>();
	private readonly readyWaiters = new Set<ReadyWaiter>();
	private readonly onReady: ((identity: TransportIdentity) => Promise<void> | void) | undefined;
	private readonly onReport: ((event: TransportReportEvent) => Promise<void> | void) | undefined;
	private readonly onSettled: ((event: TransportSettledEvent) => Promise<void> | void) | undefined;
	private readonly ownerMarker: string;
	private helloRequestId: string | undefined;

	constructor(readonly options: TransportServerOptions) {
		assertSocketPath(options.socketPath);
		assertControlString(options.runId, "runId");
		assertControlString(options.assignmentId, "assignmentId");
		if (!options.token || /[\0\r\n]/.test(options.token)) throw transportError("Transport token is invalid.");
		const expected = exactProfile(options.requestedProfile);
		if (!expected.provider || !expected.model) throw transportError("Requested worker profile is invalid.");
		this.onReady = options.onReady ?? options.ready ?? options.onWorkerReady;
		this.onReport = options.onReport ?? options.report ?? options.onWorkerReport;
		this.onSettled = options.onSettled ?? options.settled ?? options.onWorkerSettled;
		this.ownerMarker = JSON.stringify({ version: 1, runId: options.runId, assignmentId: options.assignmentId });
	}

	get isStarted(): boolean { return this.started; }
	get isAuthenticated(): boolean { return this.authenticated; }
	get isVerified(): boolean { return this.authenticated; }
	get isReady(): boolean { return this.ready; }
	get workerIdentity(): TransportIdentity | undefined { return this.identity; }

	async start(): Promise<void> {
		if (this.closed) throw transportError("A closed TransportServer cannot be restarted.");
		if (this.started) return;
		const directory = path.dirname(this.options.socketPath);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await chmod(directory, 0o700);
		await this.removeOwnedStaleSocket();
		const ownerFile = `${this.options.socketPath}.owner`;
		try {
			const ownerMetadata = await lstat(ownerFile);
			if (!ownerMetadata.isFile() || ownerMetadata.isSymbolicLink() || ownerMetadata.nlink !== 1 || (ownerMetadata.mode & 0o077) !== 0) throw transportError("Transport ownership marker is not owner-only.");
			const existingOwner = await readFile(ownerFile, "utf8");
			if (existingOwner !== this.ownerMarker) throw transportError("Transport ownership marker belongs to another assignment.");
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
		}
		await writeFile(ownerFile, this.ownerMarker, { encoding: "utf8", mode: 0o600, flag: "w" });
		await chmod(ownerFile, 0o600);
		const server = net.createServer((socket) => this.accept(socket));
		try {
			await new Promise<void>((resolve, reject) => {
				const failed = (cause: Error) => { server.off("listening", listening); reject(cause); };
				const listening = () => { server.off("error", failed); resolve(); };
				server.once("error", failed);
				server.once("listening", listening);
				server.listen(this.options.socketPath);
			});
			await chmod(this.options.socketPath, 0o600);
			this.server = server;
			this.started = true;
		} catch (cause) {
			server.close();
			await rm(ownerFile, { force: true });
			throw transportError("Could not start the Ticket Flow transport server.", cause);
		}
	}

	private async removeOwnedStaleSocket(): Promise<void> {
		const socket = this.options.socketPath;
		let metadata: Awaited<ReturnType<typeof lstat>>;
		try { metadata = await lstat(socket); }
		catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return; throw cause; }
		if (!metadata.isSocket() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw transportError("Refusing to replace a non-owned transport path.");
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		if (uid !== undefined && metadata.uid !== uid) throw transportError("Refusing to replace a transport socket owned by another user.");
		if ((metadata.mode & 0o077) !== 0) throw transportError("Existing transport socket is not owner-only.");
		const ownerFile = `${socket}.owner`;
		let owner: string;
		try {
			const ownerMetadata = await lstat(ownerFile);
			if (!ownerMetadata.isFile() || ownerMetadata.isSymbolicLink() || ownerMetadata.nlink !== 1 || (ownerMetadata.mode & 0o077) !== 0) throw new Error("ownership marker is not owner-only");
			owner = await readFile(ownerFile, "utf8");
		} catch (cause) { throw transportError("Refusing to replace a stale transport socket without its ownership marker.", cause); }
		if (owner !== this.ownerMarker) throw transportError("Existing transport socket belongs to another Ticket Flow assignment.");
		await rm(socket);
		await rm(ownerFile, { force: true });
	}

	private accept(socket: Socket): void {
		if (this.peer?.destroyed) {
			this.peer = undefined;
			this.authenticated = false;
			this.ready = false;
			this.identity = undefined;
			this.helloRequestId = undefined;
		}
		if (this.closed || this.peer !== undefined) { socket.destroy(); return; }
		this.peer = socket;
		this.authenticated = false;
		this.ready = false;
		this.identity = undefined;
		this.helloRequestId = undefined;
		const framer = new JsonlFramer();
		socket.setNoDelay(true);
		socket.on("data", (chunk: Buffer) => {
			try {
				for (const message of framer.push(chunk)) this.enqueue(() => this.receive(socket, message));
			} catch (cause) { this.reject(socket, reasonOf(cause)); }
		});
		socket.once("close", () => {
			if (this.peer !== socket) return;
			this.peer = undefined;
			this.authenticated = false;
			this.ready = false;
			this.identity = undefined;
			this.helloRequestId = undefined;
		});
		socket.once("error", () => undefined);
	}

	private enqueue(operation: () => Promise<void>): void {
		this.processing = this.processing.then(operation, operation).catch((cause) => {
			if (this.peer) this.reject(this.peer, reasonOf(cause));
		});
	}

	private async receive(socket: Socket, message: TransportMessage): Promise<void> {
		if (socket !== this.peer || this.closed) return;
		if (!this.authenticated) {
			if (message.type !== "hello") throw transportError("Worker must authenticate before sending any other message.");
			await this.authenticate(socket, message);
			return;
		}
		if (message.type === "hello") {
			// A reconnect may race with the old socket's close event.  The same
			// authenticated hello is harmless and gets the ready response again.
			if (message.requestId === this.helloRequestId) { this.write({ version: TRANSPORT_VERSION, type: "ready", requestId: message.requestId }); return; }
			throw transportError("Worker sent a second, different authentication handshake.");
		}
		if (message.type === "ack") { this.receiveAck(message); return; }
		if (message.type !== "event") throw transportError("Main accepts only worker events after authentication.");
		await this.receiveEvent(message);
	}

	private async authenticate(socket: Socket, message: Extract<TransportMessage, { type: "hello" }>): Promise<void> {
		const expected = exactProfile(this.options.requestedProfile);
		const reason = message.runId !== this.options.runId ? "run ID does not match"
			: message.assignmentId !== this.options.assignmentId ? "assignment ID does not match"
			: !safeEqual(message.token, this.options.token) ? "transport token does not match"
			: message.requestedProvider !== expected.provider ? "requested provider does not match"
			: message.requestedModel !== expected.model ? "requested model does not match"
			: message.requestedThinking !== this.options.requestedProfile.thinking ? "requested thinking level does not match"
			: message.effectiveProvider !== expected.provider ? "effective provider does not match"
			: message.effectiveModel !== expected.model ? "effective model does not match"
			: message.effectiveThinking !== this.options.requestedProfile.thinking ? "effective thinking level does not match"
			: undefined;
		if (reason) { this.rejectReadyWaiters(transportError(`Worker authentication failed: ${reason}`)); this.reject(socket, reason); return; }
		this.authenticated = true;
		this.identity = identityFromHello(message);
		this.helloRequestId = message.requestId;
		try {
			await (this.onReady ? this.onReady(this.identity) : undefined);
			this.write({ version: TRANSPORT_VERSION, type: "ready", requestId: message.requestId });
			this.resendPendingCommands();
		} catch (cause) {
			this.authenticated = false;
			this.rejectReadyWaiters(transportError(`Main could not persist worker readiness: ${reasonOf(cause)}`, cause));
			this.reject(socket, `Main could not persist worker readiness: ${reasonOf(cause)}`);
		}
	}

	private receiveAck(message: Extract<TransportMessage, { type: "ack" }>): void {
		// The handshake is acknowledged before it is represented as a command in
		// the coordinator's pending-command ledger.
		if (message.requestId === this.helloRequestId) {
			if (message.ok === false) throw transportError(message.error ?? "Worker rejected the transport handshake.");
			this.ready = true;
			const identity = this.identity;
			if (identity) for (const waiter of this.readyWaiters) waiter.resolve(identity);
			this.readyWaiters.clear();
			return;
		}
		const pending = this.pendingCommands.get(message.requestId);
		if (!pending) {
			if (this.acknowledgedCommands.has(message.requestId)) return;
			throw transportError("Worker acknowledged an unknown command request ID.");
		}
		if (pending.acknowledged) return;
		pending.acknowledged = true;
		this.pendingCommands.delete(message.requestId);
		this.acknowledgedCommands.add(message.requestId);
		const rejected = message.ok === false ? message.error ?? "Worker rejected a command." : undefined;
		this.completedCommands.set(message.requestId, { wire: pending.wire, receipt: pending.receipt, ...(rejected === undefined ? {} : { error: rejected }) });
		if (rejected !== undefined) {
			const failure = transportError(rejected);
			for (const waiter of pending.waiters) waiter.reject(failure);
		} else {
			for (const waiter of pending.waiters) waiter.resolve(pending.receipt);
		}
		pending.waiters.clear();
	}

	private async receiveEvent(message: TransportReportEvent | TransportSettledEvent): Promise<void> {
		const serialized = messageIdentity(message);
		const existing = this.receivedEvents.get(message.eventId);
		if (existing !== undefined) {
			if (existing !== serialized) throw transportError("Conflicting duplicate worker event ID.");
			if (this.authenticated) this.write({ version: TRANSPORT_VERSION, type: "ack", requestId: message.eventId });
			return;
		}
		const inFlight = this.eventInFlight.get(message.eventId);
		if (inFlight) {
			try { await inFlight; } catch { return; }
			if (this.authenticated) this.write({ version: TRANSPORT_VERSION, type: "ack", requestId: message.eventId });
			return;
		}
		const work = (async () => {
			if (message.event === "report") await (this.onReport ? this.onReport(message) : undefined);
			else {
				await (this.onSettled ? this.onSettled(message) : undefined);
				this.deliverSettlement(message);
			}
			this.receivedEvents.set(message.eventId, serialized);
		})();
		this.eventInFlight.set(message.eventId, work);
		try {
			await work;
			if (this.authenticated) this.write({ version: TRANSPORT_VERSION, type: "ack", requestId: message.eventId });
		} catch (cause) {
			if (cause instanceof PermanentTransportEventError && this.authenticated) {
				this.receivedEvents.set(message.eventId, serialized);
				this.write({ version: TRANSPORT_VERSION, type: "ack", requestId: message.eventId, ok: false, error: cause.message.slice(0, 4_096) });
			}
			// Other callback failures are retriable persistence failures. The
			// Worker retains and resends the exact same event ID.
		} finally { this.eventInFlight.delete(message.eventId); }
	}

	private deliverSettlement(event: TransportSettledEvent): void {
		const waiters = [...this.settlementWaiters].filter((candidate) => candidate.turn === event.turn);
		if (waiters.length > 0) {
			for (const waiter of waiters) { this.settlementWaiters.delete(waiter); waiter.resolve(event); }
			return;
		}
		this.pendingSettlements.set(event.turn, event);
	}

	private rejectReadyWaiters(cause: unknown): void {
		this.readyFailure = cause;
		for (const waiter of this.readyWaiters) waiter.reject(cause);
		this.readyWaiters.clear();
	}

	private write(message: TransportMessage): void {
		const peer = this.peer;
		if (!peer || peer.destroyed) throw transportError("Worker transport socket is unavailable.");
		peer.write(encode(message));
	}
	private reject(socket: Socket, reason: string): void {
		try { socket.end(encode({ version: TRANSPORT_VERSION, type: "reject", reason: reason.slice(0, 512) })); }
		catch { socket.destroy(); }
	}
	private resendPendingCommands(): void {
		if (!this.authenticated || !this.peer || this.peer.destroyed) return;
		for (const pending of this.pendingCommands.values()) if (!pending.acknowledged) this.peer.write(encode(pending.wire));
	}

	async waitReady(signal?: AbortSignal): Promise<TransportIdentity> {
		if (this.closed) throw transportError("Ticket Flow transport server is closed.");
		if (this.readyFailure !== undefined) throw this.readyFailure;
		if (this.ready && this.identity) return this.identity;
		return new Promise<TransportIdentity>((resolve, reject) => {
			if (signal?.aborted) { reject(abortError(signal)); return; }
			let waiter: ReadyWaiter;
			const remove = () => { this.readyWaiters.delete(waiter); signal?.removeEventListener("abort", abort); };
			const abort = () => { remove(); reject(abortError(signal)); };
			waiter = { resolve: (identity) => { remove(); resolve(identity); }, reject: (cause) => { remove(); reject(cause); } };
			this.readyWaiters.add(waiter);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}

	async send(input: SendInput | TransportCommand, signal?: AbortSignal): Promise<CommandReceipt>;
	async send(command: "task" | "steer" | "follow-up", message: string, turn?: number, signal?: AbortSignal): Promise<CommandReceipt>;
	async send(command: "abort" | "shutdown", turn?: number, signal?: AbortSignal): Promise<CommandReceipt>;
	async send(input: SendInput | TransportCommand | "task" | "steer" | "follow-up" | "abort" | "shutdown", second?: string | number | AbortSignal, third?: number | AbortSignal, fourth?: AbortSignal): Promise<CommandReceipt> {
		let normalizedInput: SendInput | TransportCommand;
		let signal: AbortSignal | undefined;
		if (typeof input === "string") {
			if (input === "task" || input === "steer" || input === "follow-up") {
				if (typeof second !== "string") throw transportError(`${input} command requires a message.`);
				const turn = typeof third === "number" ? third : 1;
				normalizedInput = { command: input, message: second, turn } as SendMessageInput | SendTaskInput;
				signal = (typeof third === "object" ? third : fourth) as AbortSignal | undefined;
			} else {
				const turn = typeof second === "number" ? second : undefined;
				normalizedInput = { command: input, ...(turn === undefined ? {} : { turn }) } as SendControlInput;
				signal = (typeof second === "object" ? second : third) as AbortSignal | undefined;
			}
		} else {
			normalizedInput = input;
			signal = second instanceof AbortSignal ? second : undefined;
		}
		const wire = this.normalizeCommand(normalizedInput);
		if (!this.authenticated || !this.ready) throw transportError("Worker is not ready for commands.");
		const completed = this.completedCommands.get(wire.requestId);
		if (completed) {
			if (messageIdentity(completed.wire) !== messageIdentity(wire)) throw transportError("Conflicting duplicate command request ID.");
			if (completed.error !== undefined) throw transportError(completed.error);
			return completed.receipt;
		}
		const existing = this.pendingCommands.get(wire.requestId);
		if (existing) {
			if (messageIdentity(existing.wire) !== messageIdentity(wire)) throw transportError("Conflicting duplicate command request ID.");
			if (existing.acknowledged) return existing.receipt;
			return new Promise<CommandReceipt>((resolve, reject) => {
				if (signal?.aborted) { reject(abortError(signal)); return; }
				let waiter: PendingWaiter;
				const remove = () => { existing.waiters.delete(waiter); signal?.removeEventListener("abort", abort); };
				const abort = () => { remove(); reject(abortError(signal)); };
				waiter = { resolve: (receipt) => { remove(); resolve(receipt); }, reject: (cause) => { remove(); reject(cause); } };
				existing.waiters.add(waiter); signal?.addEventListener("abort", abort, { once: true });
			});
		}
		const receipt: CommandReceipt = { requestId: wire.requestId, command: wire.command };
		const pending: PendingCommand = { wire, receipt, acknowledged: false, waiters: new Set() };
		this.pendingCommands.set(wire.requestId, pending);
		try { this.write(wire); }
		catch (cause) { this.pendingCommands.delete(wire.requestId); throw cause; }
		return new Promise<CommandReceipt>((resolve, reject) => {
			if (signal?.aborted) { reject(abortError(signal)); return; }
			let waiter: PendingWaiter;
			const remove = () => { pending.waiters.delete(waiter); signal?.removeEventListener("abort", abort); };
			const abort = () => { remove(); reject(abortError(signal)); };
			waiter = { resolve: (receipt) => { remove(); resolve(receipt); }, reject: (cause) => { remove(); reject(cause); } };
			pending.waiters.add(waiter); signal?.addEventListener("abort", abort, { once: true });
		});
	}

	private normalizeCommand(input: SendInput | TransportCommand): TransportCommand {
		const candidate = input as { readonly command?: string; readonly type?: string; readonly requestId?: string; readonly turn?: number; readonly message?: string; readonly prompt?: string };
		const command = candidate.command ?? candidate.type;
		const requestId = candidate.requestId ?? crypto.randomUUID();
		if (command === "task") {
			const message = candidate.message ?? candidate.prompt;
			if (message === undefined) throw transportError("Task command requires its unchanged message.");
			const wire: TransportCommand = { version: TRANSPORT_VERSION, type: "command", command: "task", requestId, turn: candidate.turn ?? 1, message };
			assertMessage(wire);
			return wire;
		}
		if (command !== "steer" && command !== "follow-up" && command !== "abort" && command !== "shutdown") throw transportError("Unknown Ticket Flow command.");
		const wire = { version: TRANSPORT_VERSION, type: "command", command, requestId, ...(candidate.turn === undefined ? {} : { turn: candidate.turn }), ...(command === "steer" || command === "follow-up" ? { message: candidate.message } : {}) } as TransportCommand;
		assertMessage(wire);
		return wire;
	}

	async waitForSettlement(turn: number, signal?: AbortSignal): Promise<TransportSettledEvent> {
		if (this.closed) throw transportError("Ticket Flow transport server is closed.");
		if (!Number.isSafeInteger(turn) || turn < 1) throw transportError("Settlement turn must be a positive safe integer.");
		const pending = this.pendingSettlements.get(turn);
		if (pending) { this.pendingSettlements.delete(turn); return pending; }
		return new Promise<TransportSettledEvent>((resolve, reject) => {
			if (signal?.aborted) { reject(abortError(signal)); return; }
			let waiter: SettlementWaiter;
			const remove = () => { this.settlementWaiters.delete(waiter); signal?.removeEventListener("abort", abort); };
			const abort = () => { remove(); reject(abortError(signal)); };
			waiter = { turn, resolve: (event) => { remove(); resolve(event); }, reject: (cause) => { remove(); reject(cause); } };
			this.settlementWaiters.add(waiter); signal?.addEventListener("abort", abort, { once: true });
		});
	}

	async abort(signal?: AbortSignal): Promise<CommandReceipt>;
	async abort(turn: number, signal?: AbortSignal): Promise<CommandReceipt>;
	async abort(turnOrSignal?: number | AbortSignal, signal?: AbortSignal): Promise<CommandReceipt> {
		const turn = typeof turnOrSignal === "number" ? turnOrSignal : undefined;
		const waitSignal = typeof turnOrSignal === "number" ? signal : turnOrSignal;
		return this.send({ command: "abort", ...(turn === undefined ? {} : { turn }) }, waitSignal);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const failure = transportError("Ticket Flow transport server closed.");
		for (const waiter of this.readyWaiters) waiter.reject(failure);
		for (const waiter of this.settlementWaiters) waiter.reject(failure);
		for (const pending of this.pendingCommands.values()) for (const waiter of pending.waiters) waiter.reject(failure);
		this.readyWaiters.clear(); this.settlementWaiters.clear(); this.pendingCommands.clear();
		const peer = this.peer; this.peer = undefined;
		if (peer && !peer.destroyed) peer.destroy();
		const server = this.server; this.server = undefined;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		this.started = false;
		await this.removeOwnedPaths();
	}
	private async removeOwnedPaths(): Promise<void> {
		const ownerFile = `${this.options.socketPath}.owner`;
		try {
			const ownerMetadata = await lstat(ownerFile);
			if (!ownerMetadata.isFile() || ownerMetadata.isSymbolicLink() || ownerMetadata.nlink !== 1 || (ownerMetadata.mode & 0o077) !== 0 || await readFile(ownerFile, "utf8") !== this.ownerMarker) return;
		} catch { return; }
		try {
			const socketMetadata = await lstat(this.options.socketPath);
			const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
			if (!socketMetadata.isSocket() || socketMetadata.isSymbolicLink() || socketMetadata.nlink !== 1 || (uid !== undefined && socketMetadata.uid !== uid) || (socketMetadata.mode & 0o077) !== 0) return;
			await rm(this.options.socketPath, { force: true });
		} catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return; }
		await rm(ownerFile, { force: true });
	}
	shutdown(): Promise<void> { return this.close(); }
}

/** Name retained for coordinators that call the Main endpoint a channel. */
export { TransportServer as MainTransportServer };
export function createTransportServer(options: TransportServerOptions): TransportServer { return new TransportServer(options); }

// These helpers are intentionally public: tests and worker.ts use the exact same
// validator, so a message cannot be emitted that the other side would reject.
export function encodeTransportMessage(message: TransportMessage): Buffer { return encode(message); }
export const encodeJsonLine = encodeTransportMessage;
export function decodeTransportMessage(value: unknown): TransportMessage { assertMessage(value); return value; }
export function reportMatchesModel(report: WorkerReport): report is WorkerReport { return Value.Check(WorkerReportSchema, report); }
export type { Assignment };
