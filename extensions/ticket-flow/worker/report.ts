import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import type {
	AuthoritativeWorkerContext,
	PiLaunchProfile,
	PlannedRequirement,
	WorkerIdentity,
	WorkerReport,
} from "../domain.ts";
import type { ProtocolClient } from "../protocol/client.ts";
import type { WorkflowPaths } from "../paths.ts";
import { atomicWriteJson, containsCredential, ensureRunDirectories } from "../state-store.ts";
import { normalizeRequirementReference, REPORT_SCHEMA_VERSION } from "./context.ts";

export interface WorkerReportAttempt {
	readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
	readonly attempt: number;
	readonly submittedAt: string;
	readonly runId: string;
	readonly workItemId: string;
	readonly workerSession: {
		readonly sessionId?: string;
		readonly sessionFile?: string;
	};
	readonly requestedLaunchProfile: PiLaunchProfile;
	readonly actualLaunchProfile: {
		readonly provider: string;
		readonly model: string;
		readonly thinking: PiLaunchProfile["thinking"];
	};
	readonly report: WorkerReport;
}

export interface AcceptedWorkerReport extends WorkerReportAttempt {
	readonly acceptedAt: string;
}

export interface PersistReportInput {
	readonly paths: WorkflowPaths;
	readonly runId: string;
	readonly workItemId: string;
	readonly submittedAt: string;
	readonly identity: WorkerIdentity;
	readonly requestedLaunchProfile: PiLaunchProfile;
	readonly report: WorkerReport;
}

export interface ReportValidationResult {
	readonly matchedRequirements: number;
	readonly plannedRequirements: number;
}

function requireText(value: string | undefined, field: string): string {
	if (value === undefined || !value.trim()) throw new Error(`${field} must be non-empty.`);
	return value;
}

function throwIfAborted(...signals: readonly (AbortSignal | undefined)[]): void {
	const signal = signals.find((candidate) => candidate?.aborted);
	if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function ensureTextArray(values: readonly string[] | undefined, field: string, required: boolean): readonly string[] {
	if (values === undefined) {
		if (required) throw new Error(`${field} is required.`);
		return [];
	}
	if (values.some((value) => !value.trim())) throw new Error(`${field} must not contain empty values.`);
	return values;
}

function matchRequirement(
	result: NonNullable<WorkerReport["requirements"]>[number],
	planned: readonly PlannedRequirement[],
): PlannedRequirement {
	const byId = result.requirementId === undefined ? undefined : planned.find((entry) => entry.id === result.requirementId);
	let byReference: PlannedRequirement | undefined;
	if (result.requirement !== undefined) {
		const normalized = normalizeRequirementReference(result.requirement);
		const matches = planned.filter((entry) => normalizeRequirementReference(entry.requirement) === normalized);
		if (matches.length > 1 && result.requirementId === undefined) {
			throw new Error(`Requirement reference is ambiguous; use a stable requirementId: ${result.requirement}`);
		}
		byReference = matches[0];
	}
	if (byId === undefined && byReference === undefined) {
		throw new Error(`Report contains an unknown requirement: ${result.requirementId ?? result.requirement ?? "missing reference"}`);
	}
	if (byId !== undefined && byReference !== undefined && byId.id !== byReference.id) {
		throw new Error(`Requirement ID ${byId.id} does not match its requirement reference.`);
	}
	return byId ?? byReference!;
}

export function validateWorkerReport(
	report: WorkerReport,
	planned: readonly PlannedRequirement[],
): ReportValidationResult {
	requireText(report.summary, `${report.status} report summary`);
	ensureTextArray(report.questions, "questions", false);
	ensureTextArray(report.caveats, "caveats", false);
	ensureTextArray(report.blockers, "blockers", false);
	if (report.commitIds !== undefined && report.commitIds.some((commit) => !commit.trim() || /[\s\0]/.test(commit))) throw new Error("commitIds must contain exact non-empty commit identifiers.");

	if (report.status === "progress") return { matchedRequirements: 0, plannedRequirements: planned.length };
	if (report.status === "blocked") {
		const blockers = ensureTextArray(report.blockers, "blocked report blockers", true);
		if (blockers.length === 0) throw new Error("A blocked report requires at least one blocker.");
		if (report.userInterventionRequired === undefined) throw new Error("A blocked report must state whether user intervention is required.");
		return { matchedRequirements: 0, plannedRequirements: planned.length };
	}
	if (report.status === "failed") {
		const summary = requireText(report.summary, "Failed report failure summary").trim();
		if (summary.length < 8) throw new Error("A failed report requires a useful failure summary of at least 8 characters.");
		return { matchedRequirements: 0, plannedRequirements: planned.length };
	}

	const results = report.requirements;
	if (results === undefined) throw new Error("A completed report requires requirement results.");
	const seen = new Set<string>();
	for (const result of results) {
		requireText(result.evidence, "Requirement evidence");
		const matched = matchRequirement(result, planned);
		if (seen.has(matched.id)) throw new Error(`Duplicate result for planned requirement ${matched.id}.`);
		seen.add(matched.id);
	}
	const missing = planned.filter((requirement) => !seen.has(requirement.id));
	if (missing.length > 0) throw new Error(`Completed report is missing requirement results: ${missing.map((entry) => entry.id).join(", ")}.`);
	if (results.length !== planned.length) throw new Error("Completed report must contain exactly one result for every planned requirement.");

	const files = ensureTextArray(report.filesChanged, "completed report filesChanged", true);
	if (files.length === 0) requireText(report.filesChangedExplanation, "filesChangedExplanation when no files changed");
	const checks = report.checks;
	if (checks === undefined || checks.length === 0) throw new Error("A completed report requires at least one validation check.");
	for (const check of checks) {
		requireText(check.command, "Validation check command");
		if (check.result === "not-run") requireText(check.reason, `Reason for not running ${check.command}`);
	}
	ensureTextArray(report.caveats, "completed report caveats", true);
	ensureTextArray(report.blockers, "completed report blockers", true);
	return { matchedRequirements: seen.size, plannedRequirements: planned.length };
}

export function protocolEventType(report: WorkerReport): "worker-progress" | "worker-report" | "worker-blocked" | "worker-failed" {
	switch (report.status) {
		case "progress": return "worker-progress";
		case "completed": return "worker-report";
		case "blocked": return "worker-blocked";
		case "failed": return "worker-failed";
	}
}

export function safeReportItemId(workItemId: string): string {
	const readable = workItemId
		.normalize("NFKD")
		.replace(/[^A-Za-z0-9_.-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 64);
	if (readable === workItemId && readable.length > 0 && readable !== "." && readable !== "..") return readable;
	const hash = createHash("sha256").update(workItemId).digest("hex").slice(0, 10);
	return `${readable || "item"}-${hash}`;
}

async function nextAttempt(reportsDirectory: string, safeId: string, signal?: AbortSignal): Promise<number> {
	throwIfAborted(signal);
	let names: readonly string[] = [];
	try {
		names = await readdir(reportsDirectory);
		throwIfAborted(signal);
	} catch (cause) {
		throwIfAborted(signal);
		if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
	}
	const escaped = safeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`^${escaped}-attempt-(\\d+)\\.json$`);
	return names.reduce((highest, name) => {
		const match = name.match(pattern);
		return match ? Math.max(highest, Number(match[1])) : highest;
	}, 0) + 1;
}

export function persistReportAttempt(input: PersistReportInput, signal?: AbortSignal): Effect.Effect<{ readonly path: string; readonly attempt: WorkerReportAttempt }, Error> {
	return Effect.gen(function* () {
		throwIfAborted(signal);
		if (input.identity.runId !== input.runId || input.identity.workItemId !== input.workItemId) {
			return yield* Effect.fail(new Error("Worker identity does not match the report destination."));
		}
		if (input.report.status === "progress") return yield* Effect.fail(new Error("Progress reports are events and are not persisted as final attempts."));
		if (containsCredential(input.report)) return yield* Effect.fail(new Error("Worker reports must not contain credentials."));
		yield* ensureRunDirectories(input.paths, undefined, signal);
		const safeId = safeReportItemId(input.workItemId);
		const attemptNumber = yield* Effect.tryPromise({
			try: async (effectSignal) => {
				throwIfAborted(signal, effectSignal);
				const attempt = await nextAttempt(input.paths.reportsDir, safeId, effectSignal);
				throwIfAborted(signal, effectSignal);
				return attempt;
			},
			catch: (cause) => new Error(`Could not determine report attempt number: ${cause instanceof Error ? cause.message : String(cause)}`),
		});
		const attempt: WorkerReportAttempt = {
			schemaVersion: REPORT_SCHEMA_VERSION,
			attempt: attemptNumber,
			submittedAt: input.submittedAt,
			runId: input.runId,
			workItemId: input.workItemId,
			workerSession: {
				...(input.identity.sessionId === undefined ? {} : { sessionId: input.identity.sessionId }),
				...(input.identity.sessionFile === undefined ? {} : { sessionFile: input.identity.sessionFile }),
			},
			requestedLaunchProfile: input.requestedLaunchProfile,
			actualLaunchProfile: { provider: input.identity.provider, model: input.identity.model, thinking: input.identity.thinking },
			report: input.report,
		};
		const destination = path.join(input.paths.reportsDir, `${safeId}-attempt-${attemptNumber}.json`);
		throwIfAborted(signal);
		yield* atomicWriteJson(destination, attempt, undefined, signal);
		return { path: destination, attempt };
	});
}

function reportAttemptPath(paths: WorkflowPaths, workItemId: string, attemptNumber: number): string {
	return path.join(paths.reportsDir, `${safeReportItemId(workItemId)}-attempt-${attemptNumber}.json`);
}

export function readReportAttempt(
	paths: WorkflowPaths,
	workItemId: string,
	attemptNumber: number,
	signal?: AbortSignal,
): Effect.Effect<WorkerReportAttempt, Error> {
	return Effect.gen(function* () {
		if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) return yield* Effect.fail(new Error("Report attempt number must be a positive integer."));
		throwIfAborted(signal);
		const filePath = reportAttemptPath(paths, workItemId, attemptNumber);
		const value = yield* Effect.tryPromise({
			try: async (effectSignal) => {
				throwIfAborted(signal, effectSignal);
				const content = await readFile(filePath, { encoding: "utf8", signal: effectSignal });
				throwIfAborted(signal, effectSignal);
				return JSON.parse(content) as unknown;
			},
			catch: (cause) => new Error(`Could not read report attempt ${attemptNumber}: ${cause instanceof Error ? cause.message : String(cause)}`),
		});
		throwIfAborted(signal);
		if (value === null || typeof value !== "object") return yield* Effect.fail(new Error("Report attempt is not an object."));
		const attempt = value as WorkerReportAttempt;
		if (attempt.runId === undefined || attempt.workItemId !== workItemId || attempt.attempt !== attemptNumber) {
			return yield* Effect.fail(new Error("Report attempt identity or numbering is invalid."));
		}
		return attempt;
	});
}

export function readLatestReportAttempt(
	paths: WorkflowPaths,
	workItemId: string,
	signal?: AbortSignal,
): Effect.Effect<WorkerReportAttempt | undefined, Error> {
	return Effect.gen(function* () {
		const safeId = safeReportItemId(workItemId);
		const names = yield* Effect.tryPromise({
			try: async (effectSignal) => {
				throwIfAborted(signal, effectSignal);
				try {
					const values = await readdir(paths.reportsDir);
					throwIfAborted(signal, effectSignal);
					return values;
				} catch (cause) {
					throwIfAborted(signal, effectSignal);
					if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
					throw cause;
				}
			},
			catch: (cause) => new Error(`Could not list report attempts: ${cause instanceof Error ? cause.message : String(cause)}`),
		});
		const escaped = safeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(`^${escaped}-attempt-(\\d+)\\.json$`);
		const attempts = names
			.map((name) => ({ name, match: name.match(pattern) }))
			.filter((entry): entry is { readonly name: string; readonly match: RegExpMatchArray } => entry.match !== null)
			.sort((left, right) => Number(right.match[1]) - Number(left.match[1]));
		const latest = attempts[0];
		if (!latest) return undefined;
		return yield* readReportAttempt(paths, workItemId, Number(latest.match[1]), signal);
	});
}

export function persistAcceptedReport(paths: WorkflowPaths, attempt: WorkerReportAttempt, acceptedAt: string, signal?: AbortSignal): Effect.Effect<string, Error> {
	return Effect.gen(function* () {
		throwIfAborted(signal);
		yield* ensureRunDirectories(paths, undefined, signal);
		const destination = path.join(paths.reportsDir, `${safeReportItemId(attempt.workItemId)}-accepted.json`);
		const accepted: AcceptedWorkerReport = { ...attempt, acceptedAt };
		throwIfAborted(signal);
		yield* atomicWriteJson(destination, accepted, undefined, signal);
		return destination;
	});
}

export class WorkerReportRuntime {
	constructor(private readonly client: ProtocolClient) {}

	async submit(report: WorkerReport, context: AuthoritativeWorkerContext, signal?: AbortSignal): Promise<ReportValidationResult> {
		// Audit workers speak in audit verdicts. Transport still carries the
		// common requirement result shape so the controller can use one durable
		// report schema without weakening implementation validation.
		const normalized = context.workItemKind === "audit" && report.requirements === undefined && report.auditVerdicts !== undefined
			? { ...report, requirements: report.auditVerdicts.map((verdict) => ({ requirement: verdict.requirement, result: verdict.verdict === "pass" ? "satisfied" as const : verdict.verdict === "fail" ? "not-satisfied" as const : "not-applicable" as const, evidence: verdict.evidence })) }
			: report;
		const validation = validateWorkerReport(normalized, context.requirements);
		await this.client.submitWorkerEvent(protocolEventType(normalized), { report: normalized }, signal);
		return validation;
	}
}
