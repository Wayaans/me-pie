import type { CheckResult, RequirementResult, ThinkingLevel, WorkerIdentity, WorkerReport } from "../domain.ts";

export const PROTOCOL_VERSION = 1 as const;
export const WORKER_MESSAGE_TYPES = ["worker-connected", "worker-ready", "worker-progress", "worker-report", "worker-blocked", "worker-failed", "worker-shutdown"] as const;
export const ORCHESTRATOR_MESSAGE_TYPES = ["delegate", "feedback", "accepted", "shutdown", "ping"] as const;
export type WorkerMessageType = (typeof WORKER_MESSAGE_TYPES)[number];
export type OrchestratorMessageType = (typeof ORCHESTRATOR_MESSAGE_TYPES)[number];
export type ProtocolMessageType = WorkerMessageType | OrchestratorMessageType;

export interface ProtocolEnvelope<T = unknown> {
	readonly version: typeof PROTOCOL_VERSION;
	readonly messageId: string;
	readonly runId: string;
	readonly workItemId: string;
	readonly type: ProtocolMessageType;
	readonly payload: T;
}
export interface WorkerConnectedPayload { readonly token: string; readonly provider: string; readonly model: string; readonly thinking: ThinkingLevel; readonly sessionId?: string; readonly sessionFile?: string; }
export interface DelegatePayload { readonly prompt: string; readonly requestId: string; }
export interface FeedbackPayload { readonly message: string; readonly requestId: string; }
export interface AcceptedPayload { readonly requestId: string; }
export interface ShutdownPayload { readonly requestId: string; readonly reason?: "identity-rejected"; }
export interface WorkerReportPayload { readonly report: WorkerReport; }
export type WorkerEventPayload = Record<string, never> | WorkerReportPayload;

export type WorkflowProtocolEvent =
	| { readonly type: "worker-connected"; readonly identity: WorkerIdentity; readonly messageId: string }
	| { readonly type: "worker-ready" | "worker-shutdown"; readonly workItemId: string; readonly payload: Record<string, never>; readonly messageId: string }
	| { readonly type: "worker-progress" | "worker-report" | "worker-blocked" | "worker-failed"; readonly workItemId: string; readonly payload: WorkerReportPayload; readonly messageId: string };

export class ProtocolMessageError extends Error { constructor(message: string) { super(message); this.name = "ProtocolMessageError"; } }
const thinking = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const allTypes = new Set<string>([...WORKER_MESSAGE_TYPES, ...ORCHESTRATOR_MESSAGE_TYPES]);
function record(value: unknown, name: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new ProtocolMessageError(`${name} must be an object`);
	return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
	if (Object.keys(value).some((key) => !keys.includes(key))) throw new ProtocolMessageError(`${name} contains an unsupported field`);
}
function identifier(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.length || value !== value.trim() || /[\0\r\n]/.test(value)) throw new ProtocolMessageError(`${name} must be a non-empty control-free string`);
	return value;
}
function optionalIdentifier(value: unknown, name: string): string | undefined { return value === undefined ? undefined : identifier(value, name); }
function text(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new ProtocolMessageError(`${name} must be a non-empty text string`);
	return value;
}
function strings(value: unknown, name: string): readonly string[] {
	if (!Array.isArray(value)) throw new ProtocolMessageError(`${name} must be an array`);
	return value.map((entry, index) => text(entry, `${name}[${index}]`));
}
function reportStatus(value: unknown, name: string): WorkerReport["status"] {
	if (value === "progress" || value === "completed" || value === "blocked" || value === "failed") return value;
	throw new ProtocolMessageError(`${name} is invalid`);
}
function requirement(value: unknown, name: string): RequirementResult {
	const input = record(value, name); exactKeys(input, ["requirement", "result", "evidence"], name);
	if (input.result !== "satisfied" && input.result !== "unsatisfied" && input.result !== "not-applicable") throw new ProtocolMessageError(`${name}.result is invalid`);
	return { requirement: text(input.requirement, `${name}.requirement`), result: input.result, evidence: text(input.evidence, `${name}.evidence`) };
}
function check(value: unknown, name: string): CheckResult {
	const input = record(value, name); exactKeys(input, ["command", "result", "output"], name);
	if (input.result !== "passed" && input.result !== "failed" && input.result !== "skipped") throw new ProtocolMessageError(`${name}.result is invalid`);
	return { command: text(input.command, `${name}.command`), result: input.result, ...(input.output === undefined ? {} : { output: text(input.output, `${name}.output`) }) };
}
export function decodeWorkerReport(payload: unknown): WorkerReport {
	const input = record(payload, "worker report");
	exactKeys(input, ["status", "summary", "requirements", "filesChanged", "checks", "caveats", "blockers", "questions"], "worker report");
	return {
		status: reportStatus(input.status, "worker report.status"), summary: text(input.summary, "worker report.summary"),
		...(input.requirements === undefined ? {} : { requirements: input.requirements instanceof Array ? input.requirements.map((entry, index) => requirement(entry, `worker report.requirements[${index}]`)) : (() => { throw new ProtocolMessageError("worker report.requirements must be an array"); })() }),
		...(input.filesChanged === undefined ? {} : { filesChanged: strings(input.filesChanged, "worker report.filesChanged") }),
		...(input.checks === undefined ? {} : { checks: input.checks instanceof Array ? input.checks.map((entry, index) => check(entry, `worker report.checks[${index}]`)) : (() => { throw new ProtocolMessageError("worker report.checks must be an array"); })() }),
		...(input.caveats === undefined ? {} : { caveats: strings(input.caveats, "worker report.caveats") }),
		...(input.blockers === undefined ? {} : { blockers: strings(input.blockers, "worker report.blockers") }),
		...(input.questions === undefined ? {} : { questions: strings(input.questions, "worker report.questions") }),
	};
}
export function decodeWorkerConnected(payload: unknown): WorkerConnectedPayload {
	const input = record(payload, "worker-connected.payload"); exactKeys(input, ["token", "provider", "model", "thinking", "sessionId", "sessionFile"], "worker-connected.payload");
	const level = identifier(input.thinking, "worker-connected.payload.thinking") as ThinkingLevel;
	if (!thinking.has(level)) throw new ProtocolMessageError(`Unsupported thinking level: ${level}`);
	const sessionId = optionalIdentifier(input.sessionId, "worker-connected.payload.sessionId");
	const sessionFile = optionalIdentifier(input.sessionFile, "worker-connected.payload.sessionFile");
	if (sessionFile !== undefined && !sessionFile.startsWith("/")) throw new ProtocolMessageError("worker-connected.payload.sessionFile must be absolute");
	return { token: identifier(input.token, "worker-connected.payload.token"), provider: identifier(input.provider, "worker-connected.payload.provider"), model: identifier(input.model, "worker-connected.payload.model"), thinking: level, ...(sessionId === undefined ? {} : { sessionId }), ...(sessionFile === undefined ? {} : { sessionFile }) };
}
function decodePayload(message: ProtocolEnvelope): void {
	if (message.type === "worker-connected") { decodeWorkerConnected(message.payload); return; }
	const input = record(message.payload, `${message.type}.payload`);
	switch (message.type) {
		case "delegate": exactKeys(input, ["prompt", "requestId"], "delegate.payload"); text(input.prompt, "delegate.payload.prompt"); identifier(input.requestId, "delegate.payload.requestId"); return;
		case "feedback": exactKeys(input, ["message", "requestId"], "feedback.payload"); text(input.message, "feedback.payload.message"); identifier(input.requestId, "feedback.payload.requestId"); return;
		case "accepted": exactKeys(input, ["requestId"], "accepted.payload"); identifier(input.requestId, "accepted.payload.requestId"); return;
		case "shutdown": exactKeys(input, ["requestId", "reason"], "shutdown.payload"); identifier(input.requestId, "shutdown.payload.requestId"); if (input.reason !== undefined && input.reason !== "identity-rejected") throw new ProtocolMessageError("shutdown.payload.reason is invalid"); return;
		case "ping": exactKeys(input, [], "ping.payload"); return;
		case "worker-ready": case "worker-shutdown": exactKeys(input, [], `${message.type}.payload`); return;
		case "worker-progress": case "worker-report": case "worker-blocked": case "worker-failed": {
			exactKeys(input, ["report"], `${message.type}.payload`);
			const report = decodeWorkerReport(input.report);
			const expected = message.type === "worker-progress" ? "progress" : message.type === "worker-report" ? "completed" : message.type === "worker-blocked" ? "blocked" : "failed";
			if (report.status !== expected) throw new ProtocolMessageError(`${message.type}.payload.report.status must be ${expected}`);
			return;
		}
	}
}
export function decodeProtocolMessage(input: unknown): ProtocolEnvelope {
	const value = record(input, "message"); exactKeys(value, ["version", "messageId", "runId", "workItemId", "type", "payload"], "message");
	if (value.version !== PROTOCOL_VERSION) throw new ProtocolMessageError(`Unsupported protocol version: ${String(value.version)}`);
	const type = identifier(value.type, "message.type"); if (!allTypes.has(type)) throw new ProtocolMessageError(`Unsupported protocol message type: ${type}`);
	const message: ProtocolEnvelope = { version: PROTOCOL_VERSION, messageId: identifier(value.messageId, "message.messageId"), runId: identifier(value.runId, "message.runId"), workItemId: identifier(value.workItemId, "message.workItemId"), type: type as ProtocolMessageType, payload: value.payload };
	decodePayload(message); return message;
}
export function workerIdentity(message: ProtocolEnvelope): WorkerIdentity {
	if (message.type !== "worker-connected") throw new ProtocolMessageError("Expected worker-connected handshake");
	const payload = decodeWorkerConnected(message.payload);
	return { runId: message.runId, workItemId: message.workItemId, provider: payload.provider, model: payload.model, thinking: payload.thinking, ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }), ...(payload.sessionFile === undefined ? {} : { sessionFile: payload.sessionFile }) };
}
export function toWorkflowEvent(message: ProtocolEnvelope): WorkflowProtocolEvent | undefined {
	if (message.type === "worker-connected") return { type: "worker-connected", identity: workerIdentity(message), messageId: message.messageId };
	if (message.type === "worker-ready" || message.type === "worker-shutdown") return { type: message.type, workItemId: message.workItemId, payload: {}, messageId: message.messageId };
	if (message.type === "worker-progress" || message.type === "worker-report" || message.type === "worker-blocked" || message.type === "worker-failed") return { type: message.type, workItemId: message.workItemId, payload: { report: decodeWorkerReport((message.payload as { report: unknown }).report) }, messageId: message.messageId };
	return undefined;
}
export function makeMessage<T>(runId: string, workItemId: string, type: ProtocolMessageType, payload: T, messageId: string = crypto.randomUUID()): ProtocolEnvelope<T> { return { version: PROTOCOL_VERSION, messageId, runId, workItemId, type, payload }; }
