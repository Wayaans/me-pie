import type { AuthoritativeWorkerContext, WorkerFeedback, WorkerIdentity, WorkflowRun, WorkItem } from "../domain.ts";
import type { ProtocolClient } from "../protocol/client.ts";

export const WORKER_CONTEXT_MAX_BYTES = 40 * 1024;
export const REPORT_SCHEMA_VERSION = 1 as const;

export const EXPECTED_REPORT_CONTRACT: AuthoritativeWorkerContext["expectedReport"] = {
	schemaVersion: REPORT_SCHEMA_VERSION,
	statuses: ["progress", "completed", "blocked", "failed"],
	commonFields: [
		"status", "summary", "requirements", "filesChanged", "filesChangedExplanation", "checks",
		"caveats", "blockers", "questions", "userInterventionRequired",
	],
	completedRequirements: [
		"non-empty summary",
		"one unique result for every planned requirement",
		"filesChanged (empty only with filesChangedExplanation)",
		"at least one validation check; not-run requires a reason",
		"caveats and blockers arrays",
	],
};

export function requirementId(index: number): string {
	return `requirement-${index + 1}`;
}

export function normalizeRequirementReference(requirement: string): string {
	return requirement.trim().replace(/\s+/g, " ");
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value) <= maxBytes) return value;
	const notice = "…[truncated]";
	let output = "";
	let bytes = Buffer.byteLength(notice);
	for (const character of value) {
		const size = Buffer.byteLength(character);
		if (bytes + size > maxBytes) break;
		output += character;
		bytes += size;
	}
	return `${output}${notice}`;
}

function contextBytes(context: AuthoritativeWorkerContext): number {
	return Buffer.byteLength(JSON.stringify(context));
}

/**
 * Bound non-authoritative prose before transport. Path and requirement text is
 * never changed because the worker must be able to cite it exactly in reports.
 */
export function boundAuthoritativeContext(context: AuthoritativeWorkerContext): AuthoritativeWorkerContext {
	if (contextBytes(context) <= WORKER_CONTEXT_MAX_BYTES) return context;
	let bounded: AuthoritativeWorkerContext = {
		...context,
		workItemTitle: truncateUtf8(context.workItemTitle, 2_048),
		userResolutions: context.userResolutions.map((entry) => ({
			...entry,
			question: truncateUtf8(entry.question, 1_024),
			answer: truncateUtf8(entry.answer, 2_048),
		})),
		truncated: true,
	};
	for (const limit of [2_048, 1_024, 512, 256, 128, 64]) {
		if (contextBytes(bounded) <= WORKER_CONTEXT_MAX_BYTES) return bounded;
		bounded = {
			...bounded,
			workItemTitle: truncateUtf8(bounded.workItemTitle, limit),
			userResolutions: bounded.userResolutions.map((entry) => ({ ...entry, question: truncateUtf8(entry.question, limit), answer: truncateUtf8(entry.answer, limit) })),
		};
	}
	if (contextBytes(bounded) > WORKER_CONTEXT_MAX_BYTES) {
		throw new Error("Exact delegation, path, and requirement context exceeds the native protocol bound and cannot be truncated safely.");
	}
	return bounded;
}

export function makeAuthoritativeWorkerContext(run: WorkflowRun, item: WorkItem, identity: WorkerIdentity): AuthoritativeWorkerContext {
	if (!run.requestedLaunchProfile) throw new Error("The active worker has no requested launch profile.");
	if (identity.runId !== run.id || identity.workItemId !== item.id) throw new Error("Worker identity does not match authoritative workflow context.");
	return boundAuthoritativeContext({
		runId: run.id,
		workItemId: item.id,
		workItemTitle: item.title,
		sourcePaths: item.sourcePaths,
		specificationPaths: item.specificationPaths,
		requirements: item.requirements.map((requirement, index) => ({ id: requirementId(index), requirement })),
		userResolutions: run.plan.userResolutions,
		delegationPrompt: item.delegationPrompt,
		requestedLaunchProfile: run.requestedLaunchProfile,
		actualLaunchProfile: { provider: identity.provider, model: identity.model, thinking: identity.thinking },
		expectedReport: EXPECTED_REPORT_CONTRACT,
		truncated: false,
	});
}

export class WorkerContextRuntime {
	constructor(private readonly client: ProtocolClient) {}

	get(): AuthoritativeWorkerContext {
		const context = this.client.authoritativeContext;
		if (!context) throw new Error("Authoritative worker context is unavailable until authenticated delegation arrives.");
		return context;
	}

	waitForFeedback(signal?: AbortSignal, timeoutMs?: number): Promise<WorkerFeedback> {
		return this.client.waitForFeedback(signal, timeoutMs);
	}
}
