import type {
	AuthoritativeWorkerContext,
	CheckResult,
	RequirementResult,
	ThinkingLevel,
	WorkerFeedback,
	WorkerIdentity,
	WorkerReport,
} from "../domain.ts";

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

export interface WorkerConnectedPayload {
	readonly token: string;
	readonly provider: string;
	readonly model: string;
	readonly thinking: ThinkingLevel;
	readonly sessionId?: string;
	readonly sessionFile?: string;
}
export interface DelegatePayload { readonly prompt: string; readonly context: AuthoritativeWorkerContext; readonly requestId: string }
export interface FeedbackPayload {
	readonly kind: "message" | "revision" | "user-answer";
	readonly message: string;
	readonly requestId: string;
	readonly missingRequirements?: readonly string[];
	readonly questions?: readonly string[];
}
export interface AcceptedPayload { readonly requestId: string }
export interface ShutdownPayload { readonly requestId: string; readonly reason?: "identity-rejected" }
export interface WorkerReportPayload { readonly report: WorkerReport }
export type WorkerEventPayload = Record<string, never> | WorkerReportPayload;

export type WorkflowProtocolEvent =
	| { readonly type: "worker-connected"; readonly identity: WorkerIdentity; readonly messageId: string }
	| { readonly type: "worker-ready" | "worker-shutdown"; readonly workItemId: string; readonly payload: Record<string, never>; readonly messageId: string }
	| { readonly type: "worker-progress" | "worker-report" | "worker-blocked" | "worker-failed"; readonly workItemId: string; readonly payload: WorkerReportPayload; readonly messageId: string };

export class ProtocolMessageError extends Error {
	constructor(message: string) { super(message); this.name = "ProtocolMessageError"; }
}

const thinking = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const allTypes = new Set<string>([...WORKER_MESSAGE_TYPES, ...ORCHESTRATOR_MESSAGE_TYPES]);

function record(value: unknown, name: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
		throw new ProtocolMessageError(`${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
	if (Object.keys(value).some((key) => !keys.includes(key))) throw new ProtocolMessageError(`${name} contains an unsupported field`);
}

function identifier(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.length || value !== value.trim() || /[\0\r\n]/.test(value)) {
		throw new ProtocolMessageError(`${name} must be a non-empty control-free string`);
	}
	return value;
}

function optionalIdentifier(value: unknown, name: string): string | undefined {
	return value === undefined ? undefined : identifier(value, name);
}

function text(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new ProtocolMessageError(`${name} must be a non-empty text string`);
	return value;
}

function optionalText(value: unknown, name: string): string | undefined {
	return value === undefined ? undefined : text(value, name);
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
	const input = record(value, name);
	exactKeys(input, ["requirementId", "requirement", "result", "evidence"], name);
	if (input.result !== "satisfied" && input.result !== "not-satisfied" && input.result !== "not-applicable") {
		throw new ProtocolMessageError(`${name}.result is invalid`);
	}
	const requirementId = optionalIdentifier(input.requirementId, `${name}.requirementId`);
	const reference = optionalText(input.requirement, `${name}.requirement`);
	if (requirementId === undefined && reference === undefined) throw new ProtocolMessageError(`${name} requires requirementId or requirement`);
	return {
		...(requirementId === undefined ? {} : { requirementId }),
		...(reference === undefined ? {} : { requirement: reference }),
		result: input.result,
		evidence: text(input.evidence, `${name}.evidence`),
	};
}

function check(value: unknown, name: string): CheckResult {
	const input = record(value, name);
	exactKeys(input, ["command", "result", "output", "reason"], name);
	if (input.result !== "passed" && input.result !== "failed" && input.result !== "not-run") {
		throw new ProtocolMessageError(`${name}.result is invalid`);
	}
	const output = optionalText(input.output, `${name}.output`);
	const reason = optionalText(input.reason, `${name}.reason`);
	return {
		command: text(input.command, `${name}.command`),
		result: input.result,
		...(output === undefined ? {} : { output }),
		...(reason === undefined ? {} : { reason }),
	};
}

export function decodeWorkerReport(payload: unknown): WorkerReport {
	const input = record(payload, "worker report");
	exactKeys(input, [
		"status", "summary", "commitIds", "auditVerdicts", "auditFindings", "requirements", "filesChanged", "filesChangedExplanation", "checks",
		"caveats", "blockers", "questions", "userInterventionRequired",
	], "worker report");
	if (input.userInterventionRequired !== undefined && typeof input.userInterventionRequired !== "boolean") {
		throw new ProtocolMessageError("worker report.userInterventionRequired must be a boolean");
	}
	const commitIds = input.commitIds === undefined ? undefined : strings(input.commitIds, "worker report.commitIds");
	const auditVerdicts = input.auditVerdicts === undefined ? undefined : (() => {
		if (!Array.isArray(input.auditVerdicts)) throw new ProtocolMessageError("worker report.auditVerdicts must be an array");
		return input.auditVerdicts.map((entry, index) => {
			const verdict = record(entry, `worker report.auditVerdicts[${index}]`);
			exactKeys(verdict, ["requirement", "verdict", "evidence", "fixes"], `worker report.auditVerdicts[${index}]`);
			if (verdict.verdict !== "pass" && verdict.verdict !== "fail" && verdict.verdict !== "not-applicable") throw new ProtocolMessageError("audit verdict is invalid");
			return { requirement: text(verdict.requirement, "audit verdict.requirement"), verdict: verdict.verdict as "pass" | "fail" | "not-applicable", evidence: text(verdict.evidence, "audit verdict.evidence"), ...(verdict.fixes === undefined ? {} : { fixes: strings(verdict.fixes, "audit verdict.fixes") }) };
		});
	})();
	const auditFindings = input.auditFindings === undefined ? undefined : (() => {
		if (!Array.isArray(input.auditFindings)) throw new ProtocolMessageError("worker report.auditFindings must be an array");
		return input.auditFindings.map((entry, index) => {
			const finding = record(entry, `worker report.auditFindings[${index}]`);
			exactKeys(finding, ["id", "severity", "finding", "evidence", "fixLink", "resolved"], `worker report.auditFindings[${index}]`);
			if (!["critical", "high", "medium", "low"].includes(String(finding.severity))) throw new ProtocolMessageError("audit finding severity is invalid");
			if (finding.resolved !== undefined && typeof finding.resolved !== "boolean") throw new ProtocolMessageError("audit finding resolved must be a boolean");
			return { id: identifier(finding.id, "audit finding.id"), severity: finding.severity as "critical" | "high" | "medium" | "low", finding: text(finding.finding, "audit finding.finding"), evidence: text(finding.evidence, "audit finding.evidence"), ...(finding.fixLink === undefined ? {} : { fixLink: text(finding.fixLink, "audit finding.fixLink") }), ...(finding.resolved === undefined ? {} : { resolved: finding.resolved }) };
		});
	})();
	return {
		status: reportStatus(input.status, "worker report.status"),
		summary: text(input.summary, "worker report.summary"),
		...(commitIds === undefined ? {} : { commitIds }),
		...(auditVerdicts === undefined ? {} : { auditVerdicts }),
		...(auditFindings === undefined ? {} : { auditFindings }),
		...(input.requirements === undefined ? {} : { requirements: Array.isArray(input.requirements) ? input.requirements.map((entry, index) => requirement(entry, `worker report.requirements[${index}]`)) : (() => { throw new ProtocolMessageError("worker report.requirements must be an array"); })() }),
		...(input.filesChanged === undefined ? {} : { filesChanged: strings(input.filesChanged, "worker report.filesChanged") }),
		...(input.filesChangedExplanation === undefined ? {} : { filesChangedExplanation: text(input.filesChangedExplanation, "worker report.filesChangedExplanation") }),
		...(input.checks === undefined ? {} : { checks: Array.isArray(input.checks) ? input.checks.map((entry, index) => check(entry, `worker report.checks[${index}]`)) : (() => { throw new ProtocolMessageError("worker report.checks must be an array"); })() }),
		...(input.caveats === undefined ? {} : { caveats: strings(input.caveats, "worker report.caveats") }),
		...(input.blockers === undefined ? {} : { blockers: strings(input.blockers, "worker report.blockers") }),
		...(input.questions === undefined ? {} : { questions: strings(input.questions, "worker report.questions") }),
		...(input.userInterventionRequired === undefined ? {} : { userInterventionRequired: input.userInterventionRequired }),
	};
}

export function decodeWorkerConnected(payload: unknown): WorkerConnectedPayload {
	const input = record(payload, "worker-connected.payload");
	exactKeys(input, ["token", "provider", "model", "thinking", "sessionId", "sessionFile"], "worker-connected.payload");
	const level = identifier(input.thinking, "worker-connected.payload.thinking") as ThinkingLevel;
	if (!thinking.has(level)) throw new ProtocolMessageError(`Unsupported thinking level: ${level}`);
	const sessionId = optionalIdentifier(input.sessionId, "worker-connected.payload.sessionId");
	const sessionFile = optionalIdentifier(input.sessionFile, "worker-connected.payload.sessionFile");
	if (sessionFile !== undefined && !sessionFile.startsWith("/")) throw new ProtocolMessageError("worker-connected.payload.sessionFile must be absolute");
	return {
		token: identifier(input.token, "worker-connected.payload.token"),
		provider: identifier(input.provider, "worker-connected.payload.provider"),
		model: identifier(input.model, "worker-connected.payload.model"),
		thinking: level,
		...(sessionId === undefined ? {} : { sessionId }),
		...(sessionFile === undefined ? {} : { sessionFile }),
	};
}

function launchProfile(value: unknown, name: string, actual: boolean): AuthoritativeWorkerContext["requestedLaunchProfile"] | AuthoritativeWorkerContext["actualLaunchProfile"] {
	const input = record(value, name);
	exactKeys(input, actual ? ["provider", "model", "thinking"] : ["model", "thinking"], name);
	const level = identifier(input.thinking, `${name}.thinking`) as ThinkingLevel;
	if (!thinking.has(level)) throw new ProtocolMessageError(`${name}.thinking is invalid`);
	return {
		...(actual ? { provider: identifier(input.provider, `${name}.provider`) } : {}),
		model: identifier(input.model, `${name}.model`),
		thinking: level,
	};
}

export function decodeWorkerContext(value: unknown): AuthoritativeWorkerContext {
	const input = record(value, "worker context");
	exactKeys(input, [
		"runId", "workItemKind", "readOnly", "workItemId", "workItemTitle", "sourcePaths", "specificationPaths", "requirements",
		"userResolutions", "delegationPrompt", "requestedLaunchProfile", "actualLaunchProfile", "expectedReport", "truncated",
	], "worker context");
	if (typeof input.truncated !== "boolean") throw new ProtocolMessageError("worker context.truncated must be a boolean");
	if (!Array.isArray(input.requirements)) throw new ProtocolMessageError("worker context.requirements must be an array");
	if (!Array.isArray(input.userResolutions)) throw new ProtocolMessageError("worker context.userResolutions must be an array");
	const expected = record(input.expectedReport, "worker context.expectedReport");
	exactKeys(expected, ["schemaVersion", "statuses", "commonFields", "completedRequirements"], "worker context.expectedReport");
	if (!Number.isSafeInteger(expected.schemaVersion) || (expected.schemaVersion as number) < 1) throw new ProtocolMessageError("worker context.expectedReport.schemaVersion is invalid");
	const statuses = strings(expected.statuses, "worker context.expectedReport.statuses") as WorkerReport["status"][];
	if (statuses.some((status) => !["progress", "completed", "blocked", "failed"].includes(status))) throw new ProtocolMessageError("worker context.expectedReport.statuses contains an invalid status");
	const workItemKind = input.workItemKind === undefined ? undefined : identifier(input.workItemKind, "worker context.workItemKind");
	if (workItemKind !== undefined && !["implementation", "audit", "fix"].includes(workItemKind)) throw new ProtocolMessageError("worker context.workItemKind is invalid");
	if (input.readOnly !== undefined && typeof input.readOnly !== "boolean") throw new ProtocolMessageError("worker context.readOnly must be a boolean");
	return {
		runId: identifier(input.runId, "worker context.runId"),
		...(workItemKind === undefined ? {} : { workItemKind: workItemKind as "implementation" | "audit" | "fix" }),
		...(input.readOnly === undefined ? {} : { readOnly: input.readOnly }),
		workItemId: identifier(input.workItemId, "worker context.workItemId"),
		workItemTitle: text(input.workItemTitle, "worker context.workItemTitle"),
		sourcePaths: strings(input.sourcePaths, "worker context.sourcePaths"),
		specificationPaths: strings(input.specificationPaths, "worker context.specificationPaths"),
		requirements: input.requirements.map((entry, index) => {
			const requirementInput = record(entry, `worker context.requirements[${index}]`);
			exactKeys(requirementInput, ["id", "requirement"], `worker context.requirements[${index}]`);
			return { id: identifier(requirementInput.id, `worker context.requirements[${index}].id`), requirement: text(requirementInput.requirement, `worker context.requirements[${index}].requirement`) };
		}),
		userResolutions: input.userResolutions.map((entry, index) => {
			const resolution = record(entry, `worker context.userResolutions[${index}]`);
			exactKeys(resolution, ["id", "question", "answer", "resolvedAt"], `worker context.userResolutions[${index}]`);
			return { id: identifier(resolution.id, `worker context.userResolutions[${index}].id`), question: text(resolution.question, `worker context.userResolutions[${index}].question`), answer: text(resolution.answer, `worker context.userResolutions[${index}].answer`), resolvedAt: identifier(resolution.resolvedAt, `worker context.userResolutions[${index}].resolvedAt`) };
		}),
		delegationPrompt: text(input.delegationPrompt, "worker context.delegationPrompt"),
		requestedLaunchProfile: launchProfile(input.requestedLaunchProfile, "worker context.requestedLaunchProfile", false) as AuthoritativeWorkerContext["requestedLaunchProfile"],
		actualLaunchProfile: launchProfile(input.actualLaunchProfile, "worker context.actualLaunchProfile", true) as AuthoritativeWorkerContext["actualLaunchProfile"],
		expectedReport: {
			schemaVersion: expected.schemaVersion as number,
			statuses,
			commonFields: strings(expected.commonFields, "worker context.expectedReport.commonFields"),
			completedRequirements: strings(expected.completedRequirements, "worker context.expectedReport.completedRequirements"),
		},
		truncated: input.truncated,
	};
}

export function decodeFeedback(payload: unknown): FeedbackPayload {
	const input = record(payload, "feedback.payload");
	exactKeys(input, ["kind", "message", "requestId", "missingRequirements", "questions"], "feedback.payload");
	if (input.kind !== undefined && input.kind !== "message" && input.kind !== "revision" && input.kind !== "user-answer") throw new ProtocolMessageError("feedback.payload.kind is invalid");
	return {
		kind: input.kind ?? "message",
		message: text(input.message, "feedback.payload.message"),
		requestId: identifier(input.requestId, "feedback.payload.requestId"),
		...(input.missingRequirements === undefined ? {} : { missingRequirements: strings(input.missingRequirements, "feedback.payload.missingRequirements") }),
		...(input.questions === undefined ? {} : { questions: strings(input.questions, "feedback.payload.questions") }),
	};
}

export function feedbackFromPayload(payload: FeedbackPayload): WorkerFeedback {
	return {
		type: "feedback",
		kind: payload.kind,
		message: payload.message,
		...(payload.missingRequirements === undefined ? {} : { missingRequirements: payload.missingRequirements }),
		...(payload.questions === undefined ? {} : { questions: payload.questions }),
	};
}

function decodePayload(message: ProtocolEnvelope): void {
	if (message.type === "worker-connected") { decodeWorkerConnected(message.payload); return; }
	const input = record(message.payload, `${message.type}.payload`);
	switch (message.type) {
		case "delegate": {
			exactKeys(input, ["prompt", "context", "requestId"], "delegate.payload");
			const prompt = text(input.prompt, "delegate.payload.prompt");
			identifier(input.requestId, "delegate.payload.requestId");
			const context = decodeWorkerContext(input.context);
			if (context.delegationPrompt !== prompt) throw new ProtocolMessageError("delegate prompt does not match authoritative worker context");
			return;
		}
		case "feedback": decodeFeedback(input); return;
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
	const value = record(input, "message");
	exactKeys(value, ["version", "messageId", "runId", "workItemId", "type", "payload"], "message");
	if (value.version !== PROTOCOL_VERSION) throw new ProtocolMessageError(`Unsupported protocol version: ${String(value.version)}`);
	const type = identifier(value.type, "message.type");
	if (!allTypes.has(type)) throw new ProtocolMessageError(`Unsupported protocol message type: ${type}`);
	const message: ProtocolEnvelope = {
		version: PROTOCOL_VERSION,
		messageId: identifier(value.messageId, "message.messageId"),
		runId: identifier(value.runId, "message.runId"),
		workItemId: identifier(value.workItemId, "message.workItemId"),
		type: type as ProtocolMessageType,
		payload: value.payload,
	};
	decodePayload(message);
	return message;
}

export function workerIdentity(message: ProtocolEnvelope): WorkerIdentity {
	if (message.type !== "worker-connected") throw new ProtocolMessageError("Expected worker-connected handshake");
	const payload = decodeWorkerConnected(message.payload);
	return {
		runId: message.runId,
		workItemId: message.workItemId,
		provider: payload.provider,
		model: payload.model,
		thinking: payload.thinking,
		...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
		...(payload.sessionFile === undefined ? {} : { sessionFile: payload.sessionFile }),
	};
}

export function toWorkflowEvent(message: ProtocolEnvelope): WorkflowProtocolEvent | undefined {
	if (message.type === "worker-connected") return { type: "worker-connected", identity: workerIdentity(message), messageId: message.messageId };
	if (message.type === "worker-ready" || message.type === "worker-shutdown") return { type: message.type, workItemId: message.workItemId, payload: {}, messageId: message.messageId };
	if (message.type === "worker-progress" || message.type === "worker-report" || message.type === "worker-blocked" || message.type === "worker-failed") {
		return { type: message.type, workItemId: message.workItemId, payload: { report: decodeWorkerReport((message.payload as { report: unknown }).report) }, messageId: message.messageId };
	}
	return undefined;
}

export function makeMessage<T>(runId: string, workItemId: string, type: ProtocolMessageType, payload: T, messageId: string = crypto.randomUUID()): ProtocolEnvelope<T> {
	return { version: PROTOCOL_VERSION, messageId, runId, workItemId, type, payload };
}
