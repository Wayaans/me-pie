import { getAskMeTranscriptSizeError, type AskMeAnswer, type AskMeDetails, type AskMeQuestion, type AskMeRequest } from "./schema.ts";
import { record } from "./telegram.ts";
import { compactTelegramLabel, type TelegramText } from "./telegram-view.ts";

export interface AskMeDraft {
	answers: AskMeAnswer[];
	overallResponse?: string;
}

export function draftDetails(request: AskMeRequest, draft: AskMeDraft, status: AskMeDetails["status"] = "cancelled"): AskMeDetails {
	return { ...request, ...draft, status };
}

export function questionOptions(question: AskMeQuestion) {
	return question.type === "confirmation" ? [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] : question.options;
}

function decisionContext(question: AskMeQuestion): string[] {
	const context: string[] = [];
	if (question.detail) context.push(question.detail);
	const options = questionOptions(question);
	if (question.type === "selection") for (const [index, option] of options.entries()) {
		context.push(`${index + 1}. ${option.label}${option.description ? `\n${option.description}` : ""}`);
	}
	if (question.recommendation) {
		const label = options.find((option) => option.value === question.recommendation?.answer)?.label ?? question.recommendation.answer;
		context.push(`Recommended: ${label}\n${question.recommendation.reason}`);
	}
	return context;
}

export function canSubmitDraft(request: AskMeRequest, draft: AskMeDraft): boolean {
	return (request.displayType === "questionnaire" && Boolean(draft.overallResponse?.trim()))
		|| request.questions.every((question) => !question.required || draft.answers.some((answer) => answer.id === question.id));
}

export function validateDraft(request: AskMeRequest, value: unknown): AskMeDraft {
	if (!record(value) || !Array.isArray(value.answers) || value.answers.length > request.questions.length
		|| (value.overallResponse !== undefined && (typeof value.overallResponse !== "string" || request.displayType !== "questionnaire"))) {
		throw new Error("Invalid ask_me draft");
	}
	const seen = new Set<string>();
	const answers: AskMeAnswer[] = [];
	for (const raw of value.answers) {
		if (!record(raw) || typeof raw.id !== "string" || typeof raw.value !== "string" || !raw.value.trim()
			|| typeof raw.label !== "string" || !raw.label.trim()
			|| (raw.source !== "typed" && raw.source !== "selected" && raw.source !== "recommended") || seen.has(raw.id)) throw new Error("Invalid ask_me answer");
		const question = request.questions.find((question) => question.id === raw.id);
		if (!question) throw new Error("Unknown ask_me question");
		if (raw.source === "recommended" && question.recommendation?.answer !== raw.value) throw new Error("Invalid ask_me recommendation");
		if (raw.source === "typed" || question.type === "question") {
			if (raw.label !== raw.value || raw.source === "selected") throw new Error("Invalid ask_me typed answer");
		} else if (!questionOptions(question).some((option) => option.value === raw.value && option.label === raw.label)) {
			throw new Error("Invalid ask_me selection");
		}
		seen.add(raw.id);
		answers.push({ id: raw.id, value: raw.value, label: raw.label, source: raw.source });
	}
	const ordered = request.questions.flatMap((question) => answers.filter((answer) => answer.id === question.id));
	const draft = { answers: ordered, ...(typeof value.overallResponse === "string" && value.overallResponse.trim() ? { overallResponse: value.overallResponse.trim() } : {}) };
	const error = getAskMeTranscriptSizeError(draftDetails(request, draft)) ?? getAskMeTranscriptSizeError(draftDetails(request, draft, "submitted"));
	if (error) throw new Error(error);
	return draft;
}

export type RemoteAction = { kind: "option"; index: number } | { kind: "write" | "recommend" | "skip" | "previous" | "next" | "review" | "submit" | "cancel" };
export interface RemoteButton { text: string; action: RemoteAction }
export interface RemoteView { heading: string; body: TelegramText[]; rows: RemoteButton[][] }

/** All mutations are synchronous. The bridge invalidates controls before awaiting I/O. */
export class RemoteDraft {
	index = 0;
	draft: AskMeDraft;
	constructor(readonly request: AskMeRequest, initial: AskMeDraft) { this.draft = validateDraft(request, initial); }

	private answer(answer: AskMeAnswer): void {
		this.draft = validateDraft(this.request, { ...this.draft, answers: [...this.draft.answers.filter((item) => item.id !== answer.id), answer] });
	}

	text(text: string): void {
		const value = text.trim();
		if (!value) throw new Error("Write an answer, or use Skip for an optional question.");
		const question = this.request.questions[this.index];
		if (question) this.answer({ id: question.id, value, label: value, source: "typed" });
		else if (this.request.displayType === "questionnaire") this.draft = validateDraft(this.request, { ...this.draft, overallResponse: value });
		else throw new Error("Use Previous to edit the answer before submitting.");
		if (question) this.index++;
	}

	act(action: RemoteAction): AskMeDetails["status"] | undefined {
		const question = this.request.questions[this.index];
		switch (action.kind) {
			case "write": break; // The bridge opens a reply prompt without changing the draft.
			case "cancel": return "cancelled";
			case "submit":
				if (this.index !== this.request.questions.length || !canSubmitDraft(this.request, this.draft)) throw new Error("Answer every required question or provide an Overall response.");
				return "submitted";
			case "review": this.index = this.request.questions.length; break;
			case "previous": this.index = Math.max(0, this.index - 1); break;
			case "next": this.index = Math.min(this.request.questions.length, this.index + 1); break;
			case "skip":
				if (!question || question.required) throw new Error("This question is required.");
				this.draft = { ...this.draft, answers: this.draft.answers.filter((answer) => answer.id !== question.id) };
				this.index++; break;
			case "option": {
				const option = question && questionOptions(question)[action.index];
				if (!question || !option || question.type === "question") throw new Error("Invalid selection.");
				this.answer({ id: question.id, ...option, source: "selected" }); this.index++; break;
			}
			case "recommend": {
				if (!question?.recommendation) throw new Error("No recommendation for this question.");
				const value = question.recommendation.answer;
				const label = questionOptions(question).find((option) => option.value === value)?.label ?? value;
				this.answer({ id: question.id, value, label, source: "recommended" }); this.index++; break;
			}
		}
		return undefined;
	}

	view(): RemoteView {
		const question = this.request.questions[this.index];
		const body: TelegramText[] = [];
		const rows: RemoteButton[][] = [];
		const navigation: RemoteButton[] = [];
		const paragraph = (text: string, bold = false) => {
			if (body.length) body.push({ text: "\n\n" });
			body.push({ text, bold });
		};
		if (this.request.title) paragraph(this.request.title);
		if (this.index > 0) navigation.push({ text: "Previous", action: { kind: "previous" } });
		if (question) {
			paragraph(question.question, true);
			for (const context of decisionContext(question)) paragraph(context);
			const options = questionOptions(question);
			const optionButtons: RemoteButton[] = options.map((option, index) => ({
				text: question.type === "selection" ? `${index + 1}. ${compactTelegramLabel(option.label)}` : option.label, action: { kind: "option", index },
			}));
			if (question.type === "confirmation") rows.push(optionButtons);
			else for (const button of optionButtons) rows.push([button]);
			rows.push([{ text: question.type === "question" ? "Write answer" : "Write another answer", action: { kind: "write" } }]);
			if (question.recommendation) rows.push([{ text: "Use recommendation", action: { kind: "recommend" } }]);
			const answer = this.draft.answers.find((answer) => answer.id === question.id);
			if (answer) paragraph(`Current answer: ${answer.label}`);
			if (!question.required) navigation.push({ text: "Skip", action: { kind: "skip" } });
			if (this.index < this.request.questions.length - 1) navigation.push({ text: "Next", action: { kind: "next" } });
			navigation.push({ text: "Review", action: { kind: "review" } });
		} else {
			for (const [index, item] of this.request.questions.entries()) {
				paragraph(`${index + 1}. ${item.question}`, true);
				for (const context of decisionContext(item)) paragraph(context);
				body.push({ text: `\nAnswer: ${this.draft.answers.find((answer) => answer.id === item.id)?.label ?? "Not answered"}` });
			}
			if (this.request.displayType === "questionnaire") {
				paragraph(`Overall response: ${this.draft.overallResponse ?? "Not answered"}`);
				paragraph("An overall response can answer the whole questionnaire instead of individual questions.");
				rows.push([{ text: "Write overall response", action: { kind: "write" } }]);
			}
			if (canSubmitDraft(this.request, this.draft)) rows.push([{ text: "Submit", action: { kind: "submit" } }]);
			else paragraph(this.request.displayType === "questionnaire" ? "Answer the required questions or write an overall response to submit." : "Go back and answer the question to submit.");
		}
		// Keep navigation rows small on phone screens.
		for (let index = 0; index < navigation.length; index += 3) rows.push(navigation.slice(index, index + 3));
		rows.push([{ text: "Cancel interview", action: { kind: "cancel" } }]);
		return { heading: question ? `Question ${this.index + 1}/${this.request.questions.length} · ${question.required ? "required" : "optional"}` : "Review answers", body, rows };
	}
}
