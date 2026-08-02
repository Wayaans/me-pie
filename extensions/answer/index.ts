/**
 * Q&A extraction hook - extracts questions from assistant responses
 *
 * Custom interactive TUI for answering questions.
 *
 * Demonstrates the "prompt generator" pattern with custom TUI:
 * 1. /answer command gets the last assistant message
 * 2. Shows a spinner while extracting questions as structured JSON
 * 3. Presents an interactive TUI to navigate and answer questions
 * 4. Submits the compiled answers when done
 */

import { Effect } from "effect";
import {
	getSupportedThinkingLevels,
	type Api,
	type AssistantMessage,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	fuzzyFilter,
	Input,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	type AnswerConfig,
	type AnswerThinkingLevel,
	getProjectAnswerConfigPath,
	loadMergedAnswerConfig,
	parseAnswerModelRef,
	updateProjectAnswerConfig,
} from "./config.ts";

// Structured output format for question extraction
interface ExtractedQuestion {
	question: string;
	context?: string;
	recommendation?: string;
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

const BOX_WIDTH_MAX = 120;
const BOX_WIDTH_MIN = 24;
const JSON_CODE_BLOCK_RE = /```(?:json)?\s*([\s\S]*?)```/i;

const TRANSIENT_EXTRACTION_ERROR_PATTERNS = [
	"rate limit",
	"too many requests",
	"temporarily",
	"timeout",
	"timed out",
	"service unavailable",
	"unavailable",
	"overloaded",
	"internal error",
	"internal server",
	"network",
	"connection",
	"fetch failed",
	"socket",
	"econn",
];

export const QUESTION_EXTRACTION_SYSTEM_PROMPT = `You are a decision-question extractor. Given text from a conversation, identify every unresolved question or decision that needs user input.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "A clear standalone question",
      "context": "Optional details needed to make the decision",
      "recommendation": "Optional explicit suggested answer without a label"
    }
  ]
}

Rules:
- Extract every explicit question and unresolved decision that requires user input
- Keep questions in the order they appeared
- Rewrite each decision as a clear, direct, standalone question
- Preserve the full intent: retain every option, constraint, qualifier, caveat, and default that could change the answer
- Keep the question focused; put supporting decision details in context instead of copying the entire source section
- Do not use numbered headings or section titles as questions
- Do not include markdown heading or list prefixes that are only source formatting
- Include recommendation only when the source explicitly recommends an answer or option
- Write recommendation as answer-ready text without labels such as "Recommendation:", "Recommended answer:", or "Suggested answer:"
- Preserve all requirements in the recommendation, but omit its heading and introductory preamble
- Never invent a recommendation
- If no questions are found, return {"questions": []}

Example output:
{
  "questions": [
    {
      "question": "What ownership, file-type, link-count, permission, filesystem, and symlink rules should managed paths enforce?",
      "context": "The accepted policy needs exact defaults that can be tested.",
      "recommendation": "Require current-user ownership, expected file types, one final hard link, exact modes, one supported local filesystem, and no symlinks beneath the managed directory."
    }
  ]
}`;

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function isAuthRelatedExtractionError(message: string): boolean {
	const lower = message.toLowerCase();
	return (
		lower.includes("no api key") ||
		(lower.includes("api key") && lower.includes("not found")) ||
		lower.includes("not authenticated") ||
		lower.includes("authentication")
	);
}

export function isRecoverableExtractionError(message: string): boolean {
	if (isAuthRelatedExtractionError(message)) return true;
	const lower = message.toLowerCase();
	return TRANSIENT_EXTRACTION_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Preferred models need real credentials — auth.ok alone is not enough (anthropic
 * can report ok with no apiKey). Cursor and OAuth-backed providers are always eligible.
 */
async function isExtractionModelReady(
	model: Model<Api>,
	modelRegistry: ModelRegistry,
): Promise<boolean> {
	if (model.provider === "cursor") return true;

	try {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return false;
		if (auth.apiKey) return true;
		if (modelRegistry.isUsingOAuth(model)) return true;
		return modelRegistry.getProviderAuthStatus(model.provider).configured;
	} catch {
		return false;
	}
}

export function resolveExtractionThinking(
	model: Model<Api>,
	thinking: AnswerThinkingLevel,
): AnswerThinkingLevel {
	const supported = new Set(getSupportedThinkingLevels(model).map(String));
	if (supported.has(thinking)) return thinking;
	if (thinking === "max") {
		const fallback = ["xhigh", "high", "medium", "low", "minimal", "off"].find((level) =>
			supported.has(level),
		);
		return (fallback as AnswerThinkingLevel | undefined) ?? "off";
	}
	return thinking;
}

/** Configured model with working auth, then session model (deduped). */
async function getExtractionModelCandidates(
	configuredModelRef: string,
	currentModel: Model<Api>,
	modelRegistry: ModelRegistry,
): Promise<Model<Api>[]> {
	const candidates: Model<Api>[] = [];
	const seen = new Set<string>();

	const add = (model: Model<Api>) => {
		const key = modelKey(model);
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push(model);
	};

	const configuredRef = parseAnswerModelRef(configuredModelRef);
	if (configuredRef) {
		const configuredModel = modelRegistry.find(configuredRef.provider, configuredRef.modelId);
		if (configuredModel && (await isExtractionModelReady(configuredModel, modelRegistry))) {
			add(configuredModel);
		}
	}

	add(currentModel);
	return candidates;
}

function extractFirstJsonObject(text: string): string | undefined {
	const match = text.match(JSON_CODE_BLOCK_RE);
	if (match) {
		return match[1]!.trim();
	}

	const start = text.indexOf("{");
	if (start === -1) return undefined;

	let depth = 0;
	let inString = false;
	let escaped = false;
	let jsonStart = start;

	for (let i = start; i < text.length; i++) {
		const char = text[i];

		if (escaped) {
			escaped = false;
			continue;
		}

		if (char === "\\") {
			escaped = true;
			continue;
		}

		if (char === '"') {
			inString = !inString;
			continue;
		}

		if (inString) continue;

		if (char === "{") {
			depth++;
		} else if (char === "}") {
			depth--;
			if (depth === 0) {
				return text.slice(jsonStart, i + 1).trim();
			}
		}
	}

	return undefined;
}

const RECOMMENDATION_LABEL_RE = /^\s*(?:[-*]\s*)?\*{0,2}(?:recommendation|recommended answer|suggested answer)\s*(?::|[-–—])?\*{0,2}\s*(?::|[-–—])?\s*/i;

function normalizeRecommendation(value: string): string {
	return value.trim().replace(RECOMMENDATION_LABEL_RE, "").trim();
}

function parseExtractionQuestions(value: unknown): ExtractedQuestion[] {
	if (!Array.isArray(value)) return [];

	const questions: ExtractedQuestion[] = [];

	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const item = raw as Record<string, unknown>;

		const question =
			typeof item.question === "string" ? item.question.trim() : "";
		if (!question) continue;

		const entry: ExtractedQuestion = { question };

		if (typeof item.context === "string") {
			const context = item.context.trim();
			if (context) {
				entry.context = context;
			}
		}

		if (typeof item.recommendation === "string") {
			const recommendation = normalizeRecommendation(item.recommendation);
			if (recommendation) {
				entry.recommendation = recommendation;
			}
		}

		questions.push(entry);
	}

	return questions;
}

/**
 * Parse the JSON response from the LLM
 */
export function parseExtractionResult(text: string): ExtractionResult | null {
	try {
		const jsonStr = extractFirstJsonObject(text);
		if (!jsonStr) return null;

		const parsed = JSON.parse(jsonStr);
		if (!parsed || typeof parsed !== "object") return null;
		if (!Array.isArray((parsed as { questions?: unknown }).questions)) return null;

		return {
			questions: parseExtractionQuestions((parsed as { questions: unknown }).questions),
		};
	} catch {
		return null;
	}
}

export function getRecommendationPrefill(
	currentAnswer: string,
	recommendation: string | undefined,
): string | undefined {
	if (currentAnswer.trim()) return undefined;
	const prefill = recommendation?.trim();
	return prefill || undefined;
}

/**
 * Interactive Q&A component for answering extracted questions
 */
class QnAComponent implements Component, Focusable {
	private questions: ExtractedQuestion[];
	private answers: string[];
	private currentIndex: number = 0;
	private editor: Editor;
	private tui: TUI;
	private keybindings: KeybindingsManager;
	private onDone: (result: string | null) => void;
	private showingConfirmation: boolean = false;
	private _focused: boolean = false;

	// Cache
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	// Colors - using proper reset sequences
	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
	private gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(
		questions: ExtractedQuestion[],
		tui: TUI,
		keybindings: KeybindingsManager,
		onDone: (result: string | null) => void,
	) {
		this.questions = questions;
		this.answers = questions.map(() => "");
		this.tui = tui;
		this.keybindings = keybindings;
		this.onDone = onDone;

		// Create a minimal theme for the editor
		const editorTheme: EditorTheme = {
			borderColor: this.dim,
			selectList: {
				selectedPrefix: this.cyan,
				selectedText: (s: string) => `\x1b[44m${s}\x1b[0m`,
				description: this.gray,
				scrollInfo: this.dim,
				noMatch: this.yellow,
			},
		};

		this.editor = new Editor(tui, editorTheme);
		// Disable the editor's built-in submit (which clears the editor)
		// We'll handle Enter ourselves to preserve the text
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};
	}

	private saveCurrentAnswer(): void {
		this.answers[this.currentIndex] = this.editor.getText();
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.questions.length) return;
		this.saveCurrentAnswer();
		this.currentIndex = index;
		this.editor.setText(this.answers[index] || "");
		this.invalidate();
	}

	private submit(): void {
		this.saveCurrentAnswer();

		// Build the response text
		const parts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i]!;
			const a = this.answers[i]?.trim() || "(no answer)";
			parts.push(`Q: ${q.question}`);
			if (q.context) {
				parts.push(`> ${q.context}`);
			}
			parts.push(`A: ${a}`);
			parts.push("");
		}

		this.onDone(parts.join("\n").trim());
	}

	private cancel(): void {
		this.onDone(null);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		// Handle confirmation dialog
		if (this.showingConfirmation) {
			if (this.keybindings.matches(data, "tui.select.confirm") || data.toLowerCase() === "y") {
				this.submit();
				return;
			}
			if (this.keybindings.matches(data, "tui.select.cancel") || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			return;
		}

		// Global navigation and commands
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}

		const currentQuestion = this.questions[this.currentIndex]!;
		if (currentQuestion.recommendation && matchesKey(data, Key.ctrl("r"))) {
			const prefill = getRecommendationPrefill(this.editor.getText(), currentQuestion.recommendation);
			if (prefill !== undefined) {
				this.editor.setText(prefill);
				this.saveCurrentAnswer();
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		// Tab / Shift+Tab for navigation
		if (this.keybindings.matches(data, "tui.input.tab")) {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
			}
			return;
		}

		// Up/down navigates questions when the editor is empty.
		if (this.keybindings.matches(data, "tui.editor.cursorUp") && this.editor.getText() === "") {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
				return;
			}
		}
		if (this.keybindings.matches(data, "tui.editor.cursorDown") && this.editor.getText() === "") {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
				return;
			}
		}

		// Plain submit moves to the next question or confirms the final answer.
		// The configured newline key is handled by the editor.
		if (
			this.keybindings.matches(data, "tui.input.submit") &&
			!this.keybindings.matches(data, "tui.input.newLine")
		) {
			this.saveCurrentAnswer();
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
			} else {
				this.showingConfirmation = true;
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const constrainedWidth = Math.max(BOX_WIDTH_MIN, width - 4);
		const boxWidth = Math.min(constrainedWidth, BOX_WIDTH_MAX); // Allow wider box
		const contentWidth = boxWidth - 4; // 2 chars padding on each side

		// Helper to create horizontal lines (dim the whole thing at once)
		const horizontalLine = (count: number) => "─".repeat(count);

		// Helper to create a box line
		const boxLine = (content: string, leftPad: number = 2): string => {
			const paddedContent = " ".repeat(leftPad) + content;
			const contentLen = visibleWidth(paddedContent);
			const rightPad = Math.max(0, boxWidth - contentLen - 2);
			return this.dim("│") + paddedContent + " ".repeat(rightPad) + this.dim("│");
		};

		const emptyBoxLine = (): string => {
			return this.dim("│") + " ".repeat(boxWidth - 2) + this.dim("│");
		};

		const padToWidth = (line: string): string => {
			const len = visibleWidth(line);
			return line + " ".repeat(Math.max(0, width - len));
		};

		// Title
		lines.push(padToWidth(this.dim("╭" + horizontalLine(boxWidth - 2) + "╮")));
		const title = `${this.bold(this.cyan("Questions"))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`;
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));

		// Progress indicator
		const progressParts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const answered = (this.answers[i]?.trim() || "").length > 0;
			const current = i === this.currentIndex;
			if (current) {
				progressParts.push(this.cyan("●"));
			} else if (answered) {
				progressParts.push(this.green("●"));
			} else {
				progressParts.push(this.dim("○"));
			}
		}
		lines.push(padToWidth(boxLine(progressParts.join(" "))));
		lines.push(padToWidth(emptyBoxLine()));

		// Current question
		const q = this.questions[this.currentIndex]!;
		const questionText = `${this.bold("Q:")} ${q.question}`;
		const wrappedQuestion = wrapTextWithAnsi(questionText, contentWidth);
		for (const line of wrappedQuestion) {
			lines.push(padToWidth(boxLine(line)));
		}

		// Context if present
		if (q.context) {
			lines.push(padToWidth(emptyBoxLine()));
			const contextText = this.gray(`> ${q.context}`);
			const wrappedContext = wrapTextWithAnsi(contextText, contentWidth - 2);
			for (const line of wrappedContext) {
				lines.push(padToWidth(boxLine(line)));
			}
		}

		if (q.recommendation) {
			lines.push(padToWidth(emptyBoxLine()));
			const recommendationText = `${this.yellow("Recommendation:")} ${q.recommendation}`;
			const wrappedRecommendation = wrapTextWithAnsi(recommendationText, contentWidth);
			for (const line of wrappedRecommendation) {
				lines.push(padToWidth(boxLine(line)));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Render the editor component (multi-line input) with padding
		// Skip the first and last lines (editor's own border lines)
		const answerPrefix = this.bold("A: ");
		const editorWidth = Math.max(1, contentWidth - 4 - 3); // Extra padding + space for "A: "
		const editorLines = this.editor.render(editorWidth);
		for (let i = 1; i < editorLines.length - 1; i++) {
			if (i === 1) {
				// First content line gets the "A: " prefix
				lines.push(padToWidth(boxLine(answerPrefix + editorLines[i])));
			} else {
				// Subsequent lines get padding to align with the first line
				lines.push(padToWidth(boxLine("   " + editorLines[i])));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Confirmation dialog or footer with controls
		if (this.showingConfirmation) {
			lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
			const confirmMsg = `${this.yellow("Submit all answers?")} ${this.dim("(Enter/y to confirm, Esc/n to cancel)")}`;
			lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
		} else {
			lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
			const recommendationControl = q.recommendation
				? ` · ${this.dim("Ctrl+R")} use recommendation`
				: "";
			const controls = `${this.dim("Tab/Enter")} next · ${this.dim("Shift+Tab")} prev · ${this.dim("Shift+Enter")} newline${recommendationControl} · ${this.dim("Esc")} cancel`;
			lines.push(padToWidth(boxLine(truncateToWidth(controls, contentWidth))));
		}
		lines.push(padToWidth(this.dim("╰" + horizontalLine(boxWidth - 2) + "╯")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

function isProjectTrusted(ctx: ExtensionContext): boolean {
	return (
		(ctx as ExtensionContext & { isProjectTrusted?: () => boolean }).isProjectTrusted?.() ?? false
	);
}

function hasInteractiveTui(ctx: ExtensionContext): boolean {
	const mode = (ctx as ExtensionContext & { mode?: string }).mode;
	return mode === undefined ? ctx.hasUI : mode === "tui";
}

async function searchableSelect(
	ctx: ExtensionContext,
	title: string,
	items: SelectItem[],
): Promise<string | undefined> {
	const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const input = new Input();
		let filteredItems = items;
		let list: SelectList;

		const rebuildList = () => {
			const query = input.getValue();
			filteredItems = query
				? fuzzyFilter(items, query, (item) => `${item.label} ${item.description ?? ""}`)
				: items;
			list = new SelectList(filteredItems, Math.min(filteredItems.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
		};

		rebuildList();
		input.onSubmit = () => {
			const selected = list.getSelectedItem();
			if (selected) done(selected.value);
		};
		input.onEscape = () => done(null);

		return {
			get focused() {
				return input.focused;
			},
			set focused(value: boolean) {
				input.focused = value;
			},
			render(width: number) {
				return [
					theme.fg("accent", theme.bold(truncateToWidth(title, width))),
					...input.render(width),
					...list.render(width),
					theme.fg("dim", truncateToWidth("Type to search · ↑↓ navigate · enter select · esc cancel", width)),
				];
			},
			invalidate() {
				input.invalidate();
				list.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
					list.handleInput(data);
				} else {
					const previousQuery = input.getValue();
					input.handleInput(data);
					if (input.getValue() !== previousQuery) rebuildList();
				}
				tui.requestRender();
			},
		};
	});

	return result ?? undefined;
}

async function showAnswerConfig(ctx: ExtensionContext): Promise<void> {
	if (!hasInteractiveTui(ctx)) {
		ctx.ui.notify("answer-config requires interactive mode", "error");
		return;
	}
	if (!isProjectTrusted(ctx)) {
		ctx.ui.notify("Trust this project before saving answer configuration", "error");
		return;
	}

	let currentConfig: AnswerConfig;
	try {
		currentConfig = loadMergedAnswerConfig(ctx.cwd);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}

	const modelRefs = [...new Set(ctx.modelRegistry.getAvailable().map(modelKey))].sort((a, b) => {
		if (a === currentConfig.model) return -1;
		if (b === currentConfig.model) return 1;
		return a.localeCompare(b);
	});
	if (modelRefs.length === 0) {
		ctx.ui.notify("No authenticated models are available", "error");
		return;
	}

	const selectedModelRef = await searchableSelect(
		ctx,
		`Answer model (current: ${currentConfig.model})`,
		modelRefs.map((modelRef) => ({ value: modelRef, label: modelRef })),
	);
	if (!selectedModelRef) return;

	const selectedRef = parseAnswerModelRef(selectedModelRef);
	const selectedModel = selectedRef
		? ctx.modelRegistry.find(selectedRef.provider, selectedRef.modelId)
		: undefined;
	if (!selectedModel) {
		ctx.ui.notify(`Model not found: ${selectedModelRef}`, "error");
		return;
	}

	const thinkingLevels = getSupportedThinkingLevels(selectedModel).map(String).sort((a, b) => {
		if (a === currentConfig.thinking) return -1;
		if (b === currentConfig.thinking) return 1;
		return 0;
	});
	const selectedThinking = await searchableSelect(
		ctx,
		`Answer thinking (current: ${currentConfig.thinking})`,
		thinkingLevels.map((level) => ({ value: level, label: level })),
	);
	if (!selectedThinking) return;

	const configPath = getProjectAnswerConfigPath(ctx.cwd);
	const confirmed = await ctx.ui.confirm(
		"Save answer configuration?",
		`${selectedModelRef} · thinking: ${selectedThinking}\n${configPath}`,
	);
	if (!confirmed) return;

	try {
		updateProjectAnswerConfig(ctx.cwd, {
			model: selectedModelRef,
			thinking: selectedThinking as AnswerThinkingLevel,
		});
		ctx.ui.notify(`Answer configuration saved to ${configPath}`, "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export default function (pi: ExtensionAPI) {
	const answerHandler = async (ctx: ExtensionContext) => {
			if (!hasInteractiveTui(ctx)) {
				ctx.ui.notify("answer requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}
			const sessionModel = ctx.model;

			let answerConfig: AnswerConfig;
			try {
				answerConfig = loadMergedAnswerConfig(ctx.cwd, {
					includeProject: isProjectTrusted(ctx),
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			// Find the last assistant message on the current branch
			const branch = ctx.sessionManager.getBranch();
			let lastAssistantText: string | undefined;

			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i]!;
				if (entry.type === "message") {
					const msg = entry.message;
					if ("role" in msg && msg.role === "assistant") {
						if (msg.stopReason !== "stop") {
							ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
							return;
						}
						const textParts = msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text);
						if (textParts.length > 0) {
							lastAssistantText = textParts.join("\n");
							break;
						}
					}
				}
			}

			if (!lastAssistantText) {
				ctx.ui.notify("No assistant messages found", "error");
				return;
			}

			// Run extraction with loader UI
			let extractionCancelled = false;
			const extractionResult = await ctx.ui.custom<ExtractionResult | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Extracting questions...");
				loader.onAbort = () => {
					extractionCancelled = true;
					done(null);
				};

				const doExtract = async () => {
					const candidates = await getExtractionModelCandidates(
						answerConfig.model,
						sessionModel,
						ctx.modelRegistry,
					);
					let lastError: Error | undefined;
					const userMessage: UserMessage = {
						role: "user",
						content: [{ type: "text", text: lastAssistantText! }],
						timestamp: Date.now(),
					};

					for (let i = 0; i < candidates.length; i++) {
						const model = candidates[i]!;
						const modelLabel = `${model.provider}/${model.id}`;
						let auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;
						try {
							auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							lastError = new Error(`${modelLabel} auth failed: ${message}`);
							if (i < candidates.length - 1 && isRecoverableExtractionError(message)) {
								continue;
							}
							throw lastError;
						}
						if (!auth.ok) {
							lastError = new Error(`${modelLabel} auth failed: ${auth.error}`);
							if (i < candidates.length - 1 && isRecoverableExtractionError(auth.error)) {
								continue;
							}
							throw lastError;
						}

						const reasoning = resolveExtractionThinking(model, answerConfig.thinking);
						let response: AssistantMessage;
						try {
							response = await completeSimple(
								model,
								{ systemPrompt: QUESTION_EXTRACTION_SYSTEM_PROMPT, messages: [userMessage] },
								{
									apiKey: auth.apiKey ?? "",
									...(auth.headers ? { headers: auth.headers } : {}),
									signal: loader.signal,
									...(reasoning === undefined
										? {}
										: {
												reasoning: reasoning as Exclude<
													AnswerThinkingLevel,
													"off" | "max"
												>,
											}),
								},
							);
						} catch (error) {
							if (loader.signal.aborted) {
								extractionCancelled = true;
								return null;
							}
							const message = error instanceof Error ? error.message : String(error);
							lastError = new Error(`${modelLabel} failed: ${message}`);
							if (i < candidates.length - 1 && isRecoverableExtractionError(message)) {
								continue;
							}
							throw lastError;
						}

						if (response.stopReason === "aborted") {
							extractionCancelled = true;
							return null;
						}
						if (response.stopReason === "error") {
							const message = response.errorMessage ?? "Question extraction failed";
							lastError = new Error(`${modelLabel} failed: ${message}`);
							if (i < candidates.length - 1 && isRecoverableExtractionError(message)) {
								continue;
							}
							throw lastError;
						}

						const responseText = response.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n");

						const parsed = parseExtractionResult(responseText);
						if (!parsed) {
							lastError = new Error(`${modelLabel} returned unparsable JSON`);
							if (i < candidates.length - 1) {
								continue;
							}
							throw lastError;
						}
						return parsed;
					}

					throw lastError ?? new Error("Question extraction failed");
				};

				doExtract()
					.then(done)
					.catch((err) => {
						ctx.ui.notify(
							`Question extraction failed: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
						done(null);
					});

				return loader;
			});

			if (extractionResult === null) {
				if (extractionCancelled) {
					ctx.ui.notify("Cancelled", "info");
				}
				return;
			}

			if (extractionResult.questions.length === 0) {
				ctx.ui.notify("No questions found in the last message", "info");
				return;
			}

			// Show the Q&A component
			const answersResult = await ctx.ui.custom<string | null>((tui, _theme, keybindings, done) => {
				return new QnAComponent(extractionResult.questions, tui, keybindings, done);
			});

			if (answersResult === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Submit the compiled answers as an actual user message.
			pi.sendUserMessage("I answered your questions in the following way:\n\n" + answersResult);
	};

	const runWorkflow = <A>(workflow: () => Promise<A>, signal?: AbortSignal): Promise<A> =>
		Effect.runPromise(
			Effect.tryPromise({
				try: workflow,
				catch: (error) => error instanceof Error ? error : new Error(String(error)),
			}),
			{ signal },
		);

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A",
		handler: (_args, ctx) => runWorkflow(() => answerHandler(ctx), ctx.signal),
	});

	pi.registerCommand("answer-config", {
		description: "Configure the project-specific answer model and thinking level",
		handler: (_args, ctx) => runWorkflow(() => showAnswerConfig(ctx), ctx.signal),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer questions",
		handler: (ctx) => runWorkflow(() => answerHandler(ctx), ctx.signal),
	});
}
