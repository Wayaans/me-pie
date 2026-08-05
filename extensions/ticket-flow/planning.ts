import { createHash } from "node:crypto";
import type { PlanningQuestion, UserResolution } from "./domain.ts";

/** Normalize only presentation whitespace; question wording remains durable evidence. */
export function normalizeQuestion(question: string): string {
	return question.trim().replace(/\s+/g, " ");
}

/** Stable linkage key for a planning question. */
export function questionIdFor(question: string): string {
	const normalized = normalizeQuestion(question);
	return `question-${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

function nonEmpty(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${field} must not be empty.`);
	return normalized;
}

function resolutionFor(
	question: PlanningQuestion,
	resolutions: readonly UserResolution[],
): UserResolution | undefined {
	return resolutions.find((resolution) =>
		resolution.id === question.id || normalizeQuestion(resolution.question) === normalizeQuestion(question.question),
	);
}

function mergeResolutions(
	existing: readonly UserResolution[],
	incoming: readonly UserResolution[],
): UserResolution[] {
	const merged = new Map<string, UserResolution>();
	for (const resolution of [...existing, ...incoming]) {
		const question = nonEmpty(resolution.question, "Resolution question");
		const answer = nonEmpty(resolution.answer, "Resolution answer");
		const normalized: UserResolution = { ...resolution, question, answer, id: nonEmpty(resolution.id, "Resolution ID") };
		const prior = merged.get(normalized.id);
		if (prior && (normalizeQuestion(prior.question) !== normalizeQuestion(normalized.question) || prior.answer !== normalized.answer)) {
			throw new Error(`Resolution ID ${normalized.id} is linked to conflicting answers.`);
		}
		merged.set(normalized.id, normalized);
	}
	const byQuestion = new Map<string, UserResolution>();
	for (const resolution of merged.values()) {
		const key = normalizeQuestion(resolution.question);
		const prior = byQuestion.get(key);
		if (prior && prior.id !== resolution.id) throw new Error(`Question has multiple durable answers: ${resolution.question}`);
		byQuestion.set(key, resolution);
	}
	return [...merged.values()];
}

function mergeLedger(
	existing: readonly PlanningQuestion[],
	questions: readonly string[],
	resolutions: readonly UserResolution[],
	now: string,
): PlanningQuestion[] {
	const merged = new Map<string, PlanningQuestion>();
	const byQuestion = new Map<string, PlanningQuestion>();
	const add = (question: PlanningQuestion): void => {
		const text = nonEmpty(question.question, "Planning question");
		const normalized: PlanningQuestion = { ...question, question: text, id: nonEmpty(question.id, "Planning question ID"), askedAt: nonEmpty(question.askedAt, "Planning question timestamp") };
		const priorById = merged.get(normalized.id);
		if (priorById && normalizeQuestion(priorById.question) !== normalizeQuestion(normalized.question)) {
			throw new Error(`Planning question ID ${normalized.id} is linked to conflicting questions.`);
		}
		const priorByText = byQuestion.get(normalizeQuestion(normalized.question));
		if (priorByText && priorByText.id !== normalized.id) {
			// Preserve the original durable ID when an older snapshot used a random
			// resolution ID. Text is still an explicit, auditable linkage.
			return;
		}
		merged.set(normalized.id, normalized);
		byQuestion.set(normalizeQuestion(normalized.question), normalized);
	};
	for (const question of existing) add(question);
	for (const question of questions) {
		const text = nonEmpty(question, "Planning question");
		const existingQuestion = byQuestion.get(normalizeQuestion(text));
		if (existingQuestion) continue;
		add({ id: questionIdFor(text), question: text, askedAt: now });
	}
	for (const resolution of resolutions) {
		const text = nonEmpty(resolution.question, "Resolution question");
		if (!byQuestion.has(normalizeQuestion(text))) add({ id: questionIdFor(text), question: text, askedAt: resolution.resolvedAt || now });
	}
	return [...merged.values()];
}

export interface ReconciledPlanningQuestions {
	readonly questionLedger: readonly PlanningQuestion[];
	readonly unresolvedQuestions: readonly string[];
	readonly userResolutions: readonly UserResolution[];
}

/**
 * Planning questions are append-only. A caller can only remove a question by
 * supplying a durable answer linked by question ID or exact normalized text.
 */
export function reconcilePlanningQuestions(input: {
	readonly existingLedger: readonly PlanningQuestion[] | undefined;
	readonly existingUnresolved: readonly string[];
	readonly existingResolutions: readonly UserResolution[];
	readonly incomingResolutions: readonly UserResolution[];
	readonly requestedQuestions: readonly string[];
	readonly now: string;
}): ReconciledPlanningQuestions {
	const userResolutions = mergeResolutions(input.existingResolutions, input.incomingResolutions);
	const questionLedger = mergeLedger(input.existingLedger ?? [], [...input.existingUnresolved, ...input.requestedQuestions], userResolutions, input.now);
	const unresolvedQuestions = questionLedger
		.filter((question) => resolutionFor(question, userResolutions) === undefined)
		.map((question) => question.question);
	return { questionLedger, unresolvedQuestions, userResolutions };
}

export function hasDurableResolution(question: string, resolutions: readonly UserResolution[]): boolean {
	const normalized = normalizeQuestion(question);
	return resolutions.some((resolution) =>
		normalizeQuestion(resolution.question) === normalized && resolution.answer.trim().length > 0,
	);
}
