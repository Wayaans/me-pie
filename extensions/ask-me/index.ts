import { Effect } from "effect";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { AskMeQuestionnaire } from "./questionnaire.ts";
import {
	AskMeParams,
	type AskMeAnswer,
	type AskMeDetails,
	type AskMeDisplayType,
	type AskMeParamsInput,
	type AskMeQuestion,
	type AskMeRequest,
	formatAskMeTranscript,
	getAskMeTranscriptSizeError,
	normalizeAskMeRequest,
} from "./schema.ts";

interface AskMeRenderState {
	header?: Text;
}

type HeaderStatus = "creating" | "waiting" | "done" | "cancelled" | "failed";

const HEADER_STATUS: Record<HeaderStatus, { icon: string; color: "dim" | "warning" | "success" | "error" }> = {
	creating: { icon: "◌", color: "dim" },
	waiting: { icon: "?", color: "warning" },
	done: { icon: "✓", color: "success" },
	cancelled: { icon: "⊘", color: "warning" },
	failed: { icon: "✗", color: "error" },
};

function rawDisplayType(args: unknown): AskMeDisplayType {
	if (!args || typeof args !== "object") return "question";
	const questions = (args as { questions?: unknown }).questions;
	if (!Array.isArray(questions) || questions.length === 0) return "question";
	if (questions.length > 1) return "questionnaire";
	const type = (questions[0] as { type?: unknown } | undefined)?.type;
	return type === "selection" || type === "confirmation" ? type : "question";
}

function headerText(theme: Theme, displayType: AskMeDisplayType, status: HeaderStatus): string {
	const presentation = HEADER_STATUS[status];
	return [
		theme.fg("toolTitle", theme.bold("ask-me")),
		theme.fg("dim", "·"),
		theme.fg("accent", displayType),
		theme.fg("dim", "·"),
		theme.fg(presentation.color, `${presentation.icon} ${status}`),
	].join(" ");
}

function dialogTitle(question: AskMeQuestion, index: number, total: number): string {
	const lines = [`Q${index + 1}/${total}: ${question.question}`];
	if (question.detail) lines.push(question.detail);
	if (question.recommendation) {
		lines.push(`Recommended: ${question.recommendation.answer}`);
		lines.push(`Why: ${question.recommendation.reason}`);
	}
	return lines.join("\n");
}

function cancelledDetails(request: AskMeRequest, answers: AskMeAnswer[]): AskMeDetails {
	return { ...request, status: "cancelled", answers };
}

interface RpcQuestionResult {
	cancelled: boolean;
	answer?: AskMeAnswer;
}

async function askQuestionWithRpc(
	ctx: ExtensionContext,
	question: AskMeQuestion,
	index: number,
	total: number,
	signal: AbortSignal | undefined,
): Promise<RpcQuestionResult> {
	if (signal?.aborted) return { cancelled: true };
	const title = dialogTitle(question, index, total);
	const dialogOptions = signal ? { signal } : undefined;

	if (question.type === "question") {
		const value = await ctx.ui.input(title, "Type your answer", dialogOptions);
		if (signal?.aborted || value === undefined) return { cancelled: true };
		const normalized = value.trim();
		return normalized
			? { cancelled: false, answer: { id: question.id, value: normalized, label: normalized, source: "typed" } }
			: { cancelled: false };
	}

	const options = question.type === "confirmation"
		? [
				{ value: "yes", label: "Yes" },
				{ value: "no", label: "No" },
			]
		: question.options;
	const displays = options.map((option, optionIndex) => {
		const description = option.description ? ` — ${option.description}` : "";
		return `${optionIndex + 1}. ${option.label}${description}`;
	});
	const customIndex = question.type === "selection" && question.allowOther ? displays.length : -1;
	if (customIndex >= 0) displays.push(`${displays.length + 1}. Write another answer`);
	const skipIndex = question.required ? -1 : displays.length;
	if (skipIndex >= 0) displays.push(`${displays.length + 1}. Skip this question`);

	const selected = await ctx.ui.select(title, displays, dialogOptions);
	if (signal?.aborted || selected === undefined) return { cancelled: true };
	const selectedIndex = displays.indexOf(selected);
	if (selectedIndex === skipIndex) return { cancelled: false };
	if (selectedIndex === customIndex) {
		const custom = await ctx.ui.input(`${title}\nYour other answer:`, "Type your answer", dialogOptions);
		if (signal?.aborted || custom === undefined) return { cancelled: true };
		const value = custom.trim();
		return value
			? { cancelled: false, answer: { id: question.id, value, label: value, source: "typed" } }
			: { cancelled: false };
	}
	const option = options[selectedIndex];
	return option
		? { cancelled: false, answer: { id: question.id, value: option.value, label: option.label, source: "selected" } }
		: { cancelled: true };
}

async function runRpcQuestionnaire(
	ctx: ExtensionContext,
	request: AskMeRequest,
	signal: AbortSignal | undefined,
): Promise<AskMeDetails> {
	const answers: AskMeAnswer[] = [];
	for (let index = 0; index < request.questions.length; index++) {
		const question = request.questions[index]!;
		let response = await askQuestionWithRpc(ctx, question, index, request.questions.length, signal);
		while (!response.cancelled && question.required && !response.answer) {
			ctx.ui.notify("An answer is required.", "warning");
			response = await askQuestionWithRpc(ctx, question, index, request.questions.length, signal);
		}
		if (response.cancelled) return cancelledDetails(request, answers);
		if (response.answer) {
			const candidate = [...answers, response.answer];
			const sizeError = getAskMeTranscriptSizeError({ ...request, status: "submitted", answers: candidate })
				?? getAskMeTranscriptSizeError({ ...request, status: "cancelled", answers: candidate });
			if (sizeError) throw new Error(sizeError);
			answers.push(response.answer);
		}
	}
	return { ...request, status: "submitted", answers };
}

async function runTuiQuestionnaire(
	ctx: ExtensionContext,
	request: AskMeRequest,
	signal: AbortSignal | undefined,
): Promise<AskMeDetails> {
	if (signal?.aborted) return cancelledDetails(request, []);
	let component: AskMeQuestionnaire | undefined;
	let abortListener: (() => void) | undefined;

	try {
		return await ctx.ui.custom<AskMeDetails>((tui, theme, keybindings, done) => {
			let finished = false;
			const finish = (result: AskMeDetails) => {
				if (finished) return;
				finished = true;
				done(result);
			};
			component = new AskMeQuestionnaire(request, tui, theme, keybindings, finish);
			abortListener = () => component?.cancel();
			signal?.addEventListener("abort", abortListener, { once: true });
			if (signal?.aborted) abortListener();
			return component;
		});
	} finally {
		if (abortListener) signal?.removeEventListener("abort", abortListener);
	}
}

async function executeAskMe(
	params: AskMeParamsInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: AskMeDetails }> {
	const request = normalizeAskMeRequest(params);
	const requestSizeError = getAskMeTranscriptSizeError(cancelledDetails(request, []));
	if (requestSizeError) throw new Error(requestSizeError);
	if (!ctx.hasUI || ctx.mode === "json" || ctx.mode === "print") {
		throw new Error(`ask_me requires interactive input; UI is unavailable in ${ctx.mode} mode`);
	}

	const details = ctx.mode === "tui"
		? await runTuiQuestionnaire(ctx, request, signal)
		: await runRpcQuestionnaire(ctx, request, signal);
	const transcriptSizeError = getAskMeTranscriptSizeError(details);
	if (transcriptSizeError) throw new Error(transcriptSizeError);
	const transcript = formatAskMeTranscript(details);
	return { content: [{ type: "text", text: transcript }], details };
}

export default function askMe(pi: ExtensionAPI): void {
	pi.registerTool(defineTool<typeof AskMeParams, AskMeDetails, AskMeRenderState>({
		name: "ask_me",
		label: "ask-me",
		description:
			"Interview the user with one or more free-form, single-selection, or yes/no questions. Use whenever progress requires user input, clarification, a choice, or confirmation. Related questions should be asked in one call. The completed tool result prints every question and answer. Recommendations require an answer and a reason and are never accepted automatically.",
		promptSnippet: "Ask the user interactive questions, selections, or confirmations",
		promptGuidelines: [
			"Use ask_me whenever progress requires user input, clarification, selection, interviewing, or confirmation instead of asking only in prose.",
			"Group related questions into one ask_me call, use detail for decision context, and include a recommendation only when its reason can be explained.",
			"Treat a cancelled ask_me result as no decision; never infer approval or silently use a recommendation.",
		],
		parameters: AskMeParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return Effect.runPromise(
				Effect.tryPromise({
					try: () => executeAskMe(params, signal, ctx),
					catch: (error) => error instanceof Error ? error : new Error(String(error)),
				}),
			);
		},

		renderCall(args, theme, context) {
			const header = context.state.header ?? new Text("", 0, 0);
			const status: HeaderStatus = context.argsComplete && context.executionStarted ? "waiting" : "creating";
			header.setText(headerText(theme, rawDisplayType(args), status));
			context.state.header = header;
			return header;
		},

		renderResult(result, options, theme, context) {
			const details = result.details as AskMeDetails | undefined;
			const displayType = details?.displayType ?? rawDisplayType(context.args);
			const status: HeaderStatus = options.isPartial
				? "waiting"
				: context.isError
					? "failed"
					: details?.status === "cancelled"
						? "cancelled"
						: "done";
			const header = context.state.header;
			header?.setText(headerText(theme, displayType, status));
			if (options.isPartial) return new Text("", 0, 0);

			const content = result.content.find((item) => item.type === "text");
			const transcript = content?.type === "text" ? content.text : "ask_me produced no result";
			return new Text(transcript, 0, 0);
		},
	}));
}
