import { StringEnum } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";

export const ASK_ME_QUESTION_TYPES = ["question", "selection", "confirmation"] as const;

const AskMeOptionSchema = Type.Object({
	value: Type.String({ description: "Stable value returned when this option is selected" }),
	label: Type.String({ description: "Short option label shown to the user" }),
	description: Type.Optional(Type.String({ description: "Explanation shown below the option" })),
});

const AskMeRecommendationSchema = Type.Object({
	answer: Type.String({
		description: "Suggested text, selection option value, or yes/no confirmation answer",
	}),
	reason: Type.String({ description: "Why this answer is recommended" }),
});

const AskMeQuestionSchema = Type.Object({
	id: Type.String({ description: "Unique stable identifier for this question" }),
	type: StringEnum(ASK_ME_QUESTION_TYPES, {
		description: "question for free-form text, selection for one option, confirmation for yes/no",
	}),
	question: Type.String({ description: "Direct question shown to the user" }),
	detail: Type.Optional(Type.String({ description: "Context, constraints, or consequences" })),
	options: Type.Optional(Type.Array(AskMeOptionSchema, {
		description: "Required only for selection questions",
		minItems: 1,
		maxItems: 20,
	})),
	allowOther: Type.Optional(Type.Boolean({
		description: "Allow a custom answer for a selection question (default: false)",
	})),
	required: Type.Optional(Type.Boolean({ description: "Require an answer before submission (default: true)" })),
	recommendation: Type.Optional(AskMeRecommendationSchema),
});

export const AskMeParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Optional short title for the interview" })),
	questions: Type.Array(AskMeQuestionSchema, {
		description: "One or more related questions to ask in one interaction",
		minItems: 1,
		maxItems: 20,
	}),
});

export type AskMeParamsInput = Static<typeof AskMeParams>;
export type AskMeQuestionType = (typeof ASK_ME_QUESTION_TYPES)[number];
export type AskMeDisplayType = AskMeQuestionType | "questionnaire";
export type AskMeStatus = "submitted" | "cancelled";
export type AskMeAnswerSource = "typed" | "selected" | "recommended";

export interface AskMeOption {
	value: string;
	label: string;
	description?: string;
}

export interface AskMeRecommendation {
	answer: string;
	reason: string;
}

export interface AskMeQuestion {
	id: string;
	type: AskMeQuestionType;
	question: string;
	detail?: string;
	options: AskMeOption[];
	allowOther: boolean;
	required: boolean;
	recommendation?: AskMeRecommendation;
}

export interface AskMeRequest {
	title?: string;
	displayType: AskMeDisplayType;
	questions: AskMeQuestion[];
}

export interface AskMeAnswer {
	id: string;
	value: string;
	label: string;
	source: AskMeAnswerSource;
}

export interface AskMeDetails extends AskMeRequest {
	status: AskMeStatus;
	answers: AskMeAnswer[];
}

function nonEmpty(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`ask_me requires a non-empty ${field}`);
	return normalized;
}

function normalizeOption(
	option: AskMeParamsInput["questions"][number]["options"] extends Array<infer Item> | undefined ? Item : never,
	questionId: string,
): AskMeOption {
	const value = nonEmpty(option.value, `option value for ${questionId}`);
	const label = nonEmpty(option.label, `option label for ${questionId}`);
	const description = option.description?.trim();
	return {
		value,
		label,
		...(description ? { description } : {}),
	};
}

function normalizeRecommendation(
	recommendation: AskMeParamsInput["questions"][number]["recommendation"],
	questionType: AskMeQuestionType,
	questionId: string,
	options: AskMeOption[],
): AskMeRecommendation | undefined {
	if (!recommendation) return undefined;
	let answer = nonEmpty(recommendation.answer, `recommendation answer for ${questionId}`);
	const reason = nonEmpty(recommendation.reason, `recommendation reason for ${questionId}`);

	if (questionType === "confirmation") {
		answer = answer.toLowerCase();
		if (answer !== "yes" && answer !== "no") {
			throw new Error(`ask_me confirmation recommendation for ${questionId} must be yes or no`);
		}
	}
	if (questionType === "selection" && !options.some((option) => option.value === answer)) {
		throw new Error(`ask_me recommendation for ${questionId} must match a selection option value`);
	}

	return { answer, reason };
}

export function normalizeAskMeRequest(input: AskMeParamsInput): AskMeRequest {
	if (input.questions.length === 0) throw new Error("ask_me requires at least one question");

	const ids = new Set<string>();
	const questions = input.questions.map((rawQuestion) => {
		const id = nonEmpty(rawQuestion.id, "question id");
		if (ids.has(id)) throw new Error(`ask_me question id must be unique: ${id}`);
		ids.add(id);

		const question = nonEmpty(rawQuestion.question, `question text for ${id}`);
		const detail = rawQuestion.detail?.trim();
		const options = (rawQuestion.options ?? []).map((option) => normalizeOption(option, id));
		const optionValues = new Set(options.map((option) => option.value));
		if (optionValues.size !== options.length) {
			throw new Error(`ask_me selection option values must be unique for ${id}`);
		}
		if (rawQuestion.type === "selection" && options.length === 0) {
			throw new Error(`ask_me selection question ${id} requires options`);
		}
		if (rawQuestion.type !== "selection" && options.length > 0) {
			throw new Error(`ask_me ${rawQuestion.type} question ${id} cannot define options`);
		}

		const recommendation = normalizeRecommendation(
			rawQuestion.recommendation,
			rawQuestion.type,
			id,
			options,
		);

		return {
			id,
			type: rawQuestion.type,
			question,
			...(detail ? { detail } : {}),
			options,
			allowOther: rawQuestion.type === "selection" && rawQuestion.allowOther === true,
			required: rawQuestion.required !== false,
			...(recommendation ? { recommendation } : {}),
		} satisfies AskMeQuestion;
	});

	const title = input.title?.trim();
	return {
		...(title ? { title } : {}),
		displayType: questions.length === 1 ? questions[0]!.type : "questionnaire",
		questions,
	};
}

export function formatAskMeTranscript(details: AskMeDetails): string {
	const answerById = new Map(details.answers.map((answer) => [answer.id, answer]));
	const heading = details.status === "submitted"
		? `The user submitted ${details.answers.length} answer${details.answers.length === 1 ? "" : "s"} for ${details.questions.length} question${details.questions.length === 1 ? "" : "s"}.`
		: `The user cancelled after answering ${details.answers.length} of ${details.questions.length} questions. Do not infer answers for unanswered questions.`;
	const lines = details.title
		? [`Interview: ${details.title}`, "", heading, ""]
		: [heading, ""];

	for (let index = 0; index < details.questions.length; index++) {
		const question = details.questions[index]!;
		const answer = answerById.get(question.id);
		lines.push(`Q${index + 1}. ${question.question}`);
		if (question.detail) lines.push(`    ${question.detail}`);
		lines.push(`A${index + 1}. ${answer?.label || "(not answered)"}`);
		if (answer?.source === "recommended" && question.recommendation) {
			lines.push(`    Used recommendation: ${question.recommendation.reason}`);
		}
		lines.push("");
	}

	return lines.join("\n").trimEnd();
}

export function getAskMeTranscriptSizeError(details: AskMeDetails): string | undefined {
	const transcript = formatAskMeTranscript(details);
	const bytes = new TextEncoder().encode(transcript).byteLength;
	const lines = transcript.split("\n").length;
	if (bytes > DEFAULT_MAX_BYTES || lines > DEFAULT_MAX_LINES) {
		return `The complete question-and-answer transcript exceeds Pi's ${DEFAULT_MAX_BYTES}-byte or ${DEFAULT_MAX_LINES}-line limit. Shorten the questions or answers.`;
	}
	return undefined;
}
