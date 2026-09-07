import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getAskMeTranscriptSizeError } from "./schema.ts";
import { validateDraft, type AskMeDraft } from "./draft.ts";
import type {
	AskMeAnswer,
	AskMeDetails,
	AskMeOption,
	AskMeQuestion,
	AskMeRequest,
} from "./schema.ts";

type Finish = (result: AskMeDetails) => void;

interface DisplayOption extends AskMeOption {
	custom?: true;
}

export class AskMeQuestionnaire implements Focusable {
	private readonly answers = new Map<string, AskMeAnswer>();
	private readonly cursors = new Map<string, number>();
	private readonly recommendationPrimed = new Set<string>();
	private readonly editor: Editor;
	private currentIndex = 0;
	private overallResponse: string | undefined;
	private customInput = false;
	private validationMessage: string | undefined;
	private contextScrollOffset = 0;
	private contextLineCount = 0;
	private contextViewportHeight = 0;
	private cachedWidth: number | undefined;
	private cachedRows: number | undefined;
	private cachedLines: string[] | undefined;
	private _focused = false;

	constructor(
		private readonly request: AskMeRequest,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly finish: Finish,
		private readonly remote?: { draft: AskMeDraft; send: () => boolean },
	) {
		if (remote) {
			const draft = validateDraft(request, remote.draft);
			for (const answer of draft.answers) this.answers.set(answer.id, answer);
			this.overallResponse = draft.overallResponse;
		}
		const editorTheme: EditorTheme = {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		};
		this.editor = new Editor(tui, editorTheme);
		this.editor.disableSubmit = true;
		this.editor.onChange = () => this.refresh();
		this.loadCurrentEditor();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedRows = undefined;
		this.cachedLines = undefined;
		this.editor.invalidate();
	}

	cancel(): void {
		if (!this.currentQuestion() && this.request.displayType === "questionnaire") {
			this.overallResponse = this.editor.getText().trim() || undefined;
		}
		this.finish(this.result("cancelled"));
	}

	private result(status: AskMeDetails["status"]): AskMeDetails {
		return {
			...this.request,
			status,
			answers: this.request.questions
				.map((question) => this.answers.get(question.id))
				.filter((answer): answer is AskMeAnswer => answer !== undefined),
			...(this.overallResponse ? { overallResponse: this.overallResponse } : {}),
		};
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private currentQuestion(): AskMeQuestion | undefined {
		return this.request.questions[this.currentIndex];
	}

	private displayOptions(question: AskMeQuestion): DisplayOption[] {
		const options = question.type === "confirmation"
			? [
					{ value: "yes", label: "Yes" },
					{ value: "no", label: "No" },
				]
			: question.options;
		return [
			...options,
			{ value: "__other__", label: "Write another answer", custom: true },
		];
	}

	private loadCurrentEditor(): void {
		const question = this.currentQuestion();
		if (!question) {
			this.editor.setText(this.request.displayType === "questionnaire" ? this.overallResponse ?? "" : "");
			return;
		}
		if (question.type !== "question") {
			this.editor.setText("");
			return;
		}
		this.editor.setText(this.answers.get(question.id)?.value ?? "");
	}

	private storeAnswer(answer: AskMeAnswer): boolean {
		const previous = this.answers.get(answer.id);
		this.answers.set(answer.id, answer);
		const sizeError = getAskMeTranscriptSizeError(this.result("submitted"))
			?? getAskMeTranscriptSizeError(this.result("cancelled"));
		if (sizeError) {
			if (previous) this.answers.set(answer.id, previous);
			else this.answers.delete(answer.id);
			this.validationMessage = sizeError;
			return false;
		}
		return true;
	}

	private saveTextAnswer(question: AskMeQuestion): boolean {
		const value = this.editor.getText().trim();
		if (!value) {
			this.answers.delete(question.id);
			if (question.required && this.request.displayType !== "questionnaire") {
				this.validationMessage = "An answer is required.";
				return false;
			}
			return true;
		}
		const existing = this.answers.get(question.id);
		const source = existing?.source === "recommended" && existing.value === value ? "recommended" : "typed";
		return this.storeAnswer({ id: question.id, value, label: value, source });
	}

	private moveTo(index: number): void {
		if (index < 0 || index > this.request.questions.length) return;
		const current = this.currentQuestion();
		if (current?.type === "question") {
			const hasDraft = this.editor.getText().trim().length > 0;
			if (hasDraft && !this.saveTextAnswer(current)) {
				this.refresh();
				return;
			}
			if (!hasDraft) {
				this.answers.delete(current.id);
				if (this.request.displayType !== "questionnaire" && current.required) {
					this.validationMessage = "An answer is required.";
					this.refresh();
					return;
				}
			}
		}
		if (current && this.customInput) {
			const value = this.editor.getText().trim();
			if (value && !this.storeAnswer({ id: current.id, value, label: value, source: "typed" })) {
				this.refresh();
				return;
			}
		}
		this.currentIndex = index;
		this.contextScrollOffset = 0;
		this.customInput = false;
		this.validationMessage = undefined;
		this.loadCurrentEditor();
		this.refresh();
	}

	private advance(): void {
		this.moveTo(Math.min(this.currentIndex + 1, this.request.questions.length));
	}

	private retreat(): void {
		this.moveTo(Math.max(0, this.currentIndex - 1));
	}

	private useRecommendation(question: AskMeQuestion): void {
		const recommendation = question.recommendation;
		if (!recommendation) return;

		if (question.type === "question") {
			if (this.editor.getText().trim()) return;
			this.editor.setText(recommendation.answer);
			if (!this.storeAnswer({
				id: question.id,
				value: recommendation.answer,
				label: recommendation.answer,
				source: "recommended",
			})) return;
		} else {
			if (this.answers.has(question.id)) return;
			const optionIndex = this.displayOptions(question).findIndex(
				(option) => option.value === recommendation.answer,
			);
			if (optionIndex < 0) return;
			this.customInput = false;
			this.editor.setText("");
			this.cursors.set(question.id, optionIndex);
			this.recommendationPrimed.add(question.id);
		}
		this.validationMessage = undefined;
		this.refresh();
	}

	private selectCurrent(question: AskMeQuestion): void {
		const options = this.displayOptions(question);
		const cursor = this.cursors.get(question.id) ?? 0;
		const option = options[cursor];
		if (!option) return;
		if (option.custom) {
			this.customInput = true;
			const existing = this.answers.get(question.id);
			this.editor.setText(existing?.source === "typed" ? existing.value : "");
			this.validationMessage = undefined;
			this.refresh();
			return;
		}

		const recommended = this.recommendationPrimed.has(question.id)
			&& question.recommendation?.answer === option.value;
		if (!this.storeAnswer({
			id: question.id,
			value: option.value,
			label: option.label,
			source: recommended ? "recommended" : "selected",
		})) {
			this.refresh();
			return;
		}
		this.recommendationPrimed.delete(question.id);
		this.advance();
	}

	private submitCustomAnswer(question: AskMeQuestion): void {
		const value = this.editor.getText().trim();
		if (!value) {
			this.validationMessage = "An answer is required.";
			this.refresh();
			return;
		}
		if (!this.storeAnswer({ id: question.id, value, label: value, source: "typed" })) {
			this.refresh();
			return;
		}
		this.customInput = false;
		this.advance();
	}

	private allRequiredAnswered(): boolean {
		return this.request.questions.every((question) => !question.required || this.answers.has(question.id));
	}

	private canSubmit(): boolean {
		return this.allRequiredAnswered() || Boolean(this.overallResponse);
	}

	private scrollContext(delta: number): void {
		if (this.contextLineCount <= this.contextViewportHeight) return;
		const maximumOffset = this.contextLineCount - this.contextViewportHeight;
		const nextOffset = Math.min(maximumOffset, Math.max(0, this.contextScrollOffset + delta));
		if (nextOffset === this.contextScrollOffset) return;
		this.contextScrollOffset = nextOffset;
		this.refresh();
	}

	private fitContextToTerminal(
		lines: string[],
		contextStart: number,
		contextEnd: number,
		width: number,
	): string[] {
		const contextLines = lines.slice(contextStart, contextEnd);
		const maximumLines = Math.max(1, this.tui.terminal.rows - 2);
		const fixedLineCount = lines.length - contextLines.length;
		const availableLines = maximumLines - fixedLineCount;
		this.contextLineCount = contextLines.length;

		if (contextLines.length <= availableLines) {
			this.contextScrollOffset = 0;
			this.contextViewportHeight = contextLines.length;
			return lines;
		}

		const viewportHeight = Math.max(1, availableLines - 1);
		const maximumOffset = Math.max(0, contextLines.length - viewportHeight);
		this.contextScrollOffset = Math.min(this.contextScrollOffset, maximumOffset);
		this.contextViewportHeight = viewportHeight;
		const visibleEnd = Math.min(contextLines.length, this.contextScrollOffset + viewportHeight);
		const indicator = truncateToWidth(this.theme.fg(
			"dim",
			` Context ${this.contextScrollOffset + 1}–${visibleEnd} of ${contextLines.length} · Shift+↑/↓ scroll context`,
		), width, "");

		return [
			...lines.slice(0, contextStart),
			...contextLines.slice(this.contextScrollOffset, visibleEnd),
			indicator,
			...lines.slice(contextEnd),
		];
	}

	private submitAll(): void {
		if (this.request.displayType === "questionnaire") {
			this.overallResponse = this.editor.getText().trim() || undefined;
		}
		if (!this.canSubmit()) {
			this.validationMessage = "Answer every required question or provide an Overall response.";
			this.refresh();
			return;
		}
		const result = this.result("submitted");
		const sizeError = getAskMeTranscriptSizeError(result);
		if (sizeError) {
			this.validationMessage = sizeError;
			this.refresh();
			return;
		}
		this.finish(result);
	}

	private sendToTelegram(): void {
		if (!this.remote) return;
		const question = this.currentQuestion();
		const value = this.editor.getText().trim();
		if (question && (question.type === "question" || this.customInput) && value) {
			const existing = this.answers.get(question.id);
			const source = existing?.source === "recommended" && existing.value === value ? "recommended" : "typed";
			if (!this.storeAnswer({ id: question.id, value, label: value, source })) { this.refresh(); return; }
		} else if (!question && this.request.displayType === "questionnaire") this.overallResponse = value || undefined;
		const result = this.result("cancelled");
		const error = getAskMeTranscriptSizeError(result);
		if (error) { this.validationMessage = error; this.refresh(); return; }
		if (this.remote.send()) this.finish(result);
	}

	handleInput(data: string): void {
		if (this.remote && matchesKey(data, Key.ctrl("t"))) { this.sendToTelegram(); return; }
		if (matchesKey(data, Key.shift("up"))) {
			this.scrollContext(-1);
			return;
		}
		if (matchesKey(data, Key.shift("down"))) {
			this.scrollContext(1);
			return;
		}

		if (this.keybindings.matches(data, "tui.select.cancel")) {
			if (this.customInput) {
				this.customInput = false;
				this.editor.setText("");
				this.validationMessage = undefined;
				this.refresh();
			} else {
				this.cancel();
			}
			return;
		}

		const question = this.currentQuestion();
		if (!question) {
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				this.overallResponse = this.editor.getText().trim() || undefined;
				this.retreat();
			} else if (this.keybindings.matches(data, "tui.input.submit") && !this.keybindings.matches(data, "tui.input.newLine")) {
				this.submitAll();
			} else if (this.request.displayType === "questionnaire") {
				this.editor.handleInput(data);
			}
			return;
		}

		if (matchesKey(data, Key.ctrl("r"))) {
			this.useRecommendation(question);
			return;
		}

		if (matchesKey(data, Key.shift("tab"))) {
			this.retreat();
			return;
		}

		if (this.customInput) {
			if (this.keybindings.matches(data, "tui.input.submit") && !this.keybindings.matches(data, "tui.input.newLine")) {
				this.submitCustomAnswer(question);
				return;
			}
			this.editor.handleInput(data);
			return;
		}

		if (question.type === "question") {
			if (this.keybindings.matches(data, "tui.input.tab")) {
				if (this.saveTextAnswer(question)) this.advance();
				else this.refresh();
				return;
			}
			if (this.keybindings.matches(data, "tui.input.submit") && !this.keybindings.matches(data, "tui.input.newLine")) {
				if (this.saveTextAnswer(question)) this.advance();
				else this.refresh();
				return;
			}
			this.editor.handleInput(data);
			return;
		}

		const options = this.displayOptions(question);
		const cursor = this.cursors.get(question.id) ?? 0;
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.cursors.set(question.id, Math.max(0, cursor - 1));
			this.recommendationPrimed.delete(question.id);
			this.refresh();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.cursors.set(question.id, Math.min(options.length - 1, cursor + 1));
			this.recommendationPrimed.delete(question.id);
			this.refresh();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.selectCurrent(question);
			return;
		}
		if (this.keybindings.matches(data, "tui.input.tab")) this.advance();
	}

	render(width: number): string[] {
		const terminalRows = this.tui.terminal.rows;
		if (this.cachedLines && this.cachedWidth === width && this.cachedRows === terminalRows) {
			return this.cachedLines;
		}
		const renderWidth = Math.max(1, width);
		const lines: string[] = [];
		let contextStart: number | undefined;
		let contextEnd: number | undefined;
		const add = (text: string, prefix = " ") => {
			const prefixWidth = visibleWidth(prefix);
			if (prefixWidth >= renderWidth) {
				lines.push(...wrapTextWithAnsi(prefix + text, renderWidth));
				return;
			}
			const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
			for (let index = 0; index < wrapped.length; index++) {
				lines.push(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${wrapped[index]}`);
			}
		};

		lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
		const title = this.request.title ?? "Questions";
		const position = this.currentIndex < this.request.questions.length
			? `${this.currentIndex + 1}/${this.request.questions.length}`
			: "Review";
		add(`${this.theme.bold(title)} ${this.theme.fg("dim", `· ${position}`)}`);
		add(this.request.questions.map((question, index) => {
			if (index === this.currentIndex) return this.theme.fg("accent", "●");
			return this.answers.has(question.id) ? this.theme.fg("success", "●") : this.theme.fg("dim", "○");
		}).join(" "));
		lines.push("");

		const question = this.currentQuestion();
		if (!question) {
			add(this.theme.fg("accent", this.theme.bold("Review answers")));
			lines.push("");
			for (let index = 0; index < this.request.questions.length; index++) {
				const item = this.request.questions[index]!;
				const answer = this.answers.get(item.id);
				add(`${this.theme.fg("muted", `Q${index + 1}.`)} ${item.question}`);
				add(`${this.theme.fg(answer ? "success" : "warning", `A${index + 1}.`)} ${answer?.label ?? "(not answered)"}`);
				lines.push("");
			}
			if (this.request.displayType === "questionnaire") {
				add(this.theme.bold("Overall response"));
				add(this.theme.fg("muted", "Optionally answer the whole questionnaire at once."));
				for (const line of this.editor.render(Math.max(1, renderWidth - 1))) {
					lines.push(renderWidth > 1 ? ` ${line}` : truncateToWidth(line, renderWidth, ""));
				}
				lines.push("");
			}
			add(this.canSubmit()
				? this.theme.fg("success", "Press Enter to submit all answers.")
				: this.theme.fg("warning", "Answer required questions or provide an Overall response."));
		} else {
			contextStart = lines.length;
			add(this.theme.bold(question.question));
			if (question.detail) add(this.theme.fg("muted", question.detail));
			if (question.recommendation) {
				lines.push("");
				add(`${this.theme.fg("warning", "Recommended:")} ${question.recommendation.answer}`);
				add(this.theme.fg("muted", question.recommendation.reason));
			}
			contextEnd = lines.length;
			lines.push("");

			if (question.type === "question" || this.customInput) {
				add(this.theme.fg("muted", this.customInput ? "Your other answer:" : "Your answer:"));
				for (const line of this.editor.render(Math.max(1, renderWidth - 1))) {
					lines.push(renderWidth > 1 ? ` ${line}` : truncateToWidth(line, renderWidth, ""));
				}
			} else {
				const options = this.displayOptions(question);
				const cursor = this.cursors.get(question.id) ?? 0;
				for (let index = 0; index < options.length; index++) {
					const option = options[index]!;
					const selected = index === cursor;
					const recommended = question.recommendation?.answer === option.value;
					const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
					const suffix = recommended ? this.theme.fg("warning", " · Recommended") : "";
					add(`${this.theme.fg(selected ? "accent" : "text", option.label)}${suffix}`, prefix);
					if (option.description) add(this.theme.fg("muted", option.description), "    ");
				}
			}
		}

		if (this.validationMessage) {
			lines.push("");
			add(this.theme.fg("warning", this.validationMessage));
		}
		lines.push("");
		const controls = question
			? `${question.type === "question" || this.customInput ? "Enter/Tab next" : "↑↓ select · Enter next"} · Shift+Tab previous${question.recommendation ? " · Ctrl+R use recommendation" : ""} · Esc cancel`
			: "Enter submit · Shift+Tab/← previous · Esc cancel";
		add(this.theme.fg("dim", truncateToWidth(controls, Math.max(1, renderWidth - 1))));
		if (this.remote) add(this.theme.fg("dim", "Ctrl+T send this draft to Telegram and enable AFK"));
		lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));

		const visibleLines = contextStart !== undefined && contextEnd !== undefined
			? this.fitContextToTerminal(lines, contextStart, contextEnd, renderWidth)
			: lines;
		this.cachedWidth = width;
		this.cachedRows = terminalRows;
		this.cachedLines = visibleLines;
		return visibleLines;
	}
}
