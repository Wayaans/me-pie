import {
	ToolExecutionComponent,
	type AgentToolResult,
	type ExtensionAPI,
	type Theme,
	type ThemeColor,
	type ToolDefinition,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, sliceByColumn, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";

export interface SummaryPart {
	readonly text: string;
	readonly color?: ThemeColor;
	readonly separator?: "dot" | "space";
}

export interface ToolView<TArgs, TDetails> {
	readonly icon: string;
	readonly label: string;
	readonly targetTruncation?: "end" | "middle";
	compactCall?(args: TArgs, cwd: string, theme: Theme): Component | undefined;
	target(args: TArgs, cwd: string): string;
	summary(args: TArgs, result: AgentToolResult<TDetails>): readonly SummaryPart[];
	expanded(args: TArgs, result: AgentToolResult<TDetails>, theme: Theme): Component;
}

const HORIZONTAL_PADDING = 1;
const mepieToolCallComponents = new WeakSet<object>();

type ToolExecutionRender = (this: ToolExecutionComponent, width: number) => string[];

let compactSpacingUsers = 0;
let originalToolExecutionRender: ToolExecutionRender | undefined;
let compactToolExecutionRender: ToolExecutionRender | undefined;

interface ToolUiState {
	finalSummary?: readonly SummaryPart[];
}

interface ToolStateContext {
	readonly executionStarted: boolean;
	readonly isPartial: boolean;
	readonly isError: boolean;
}

interface SummaryLineInput {
	readonly icon: string;
	readonly label: string;
	readonly target: string;
	readonly targetTruncation: "end" | "middle";
	readonly theme: Theme;
	readonly context: ToolStateContext;
	readonly state: ToolUiState;
}

export function registerMepieToolSpacing(pi: ExtensionAPI): void {
	let active = false;

	pi.on("session_start", (_event, ctx) => {
		if (active) deactivateCompactToolSpacing();
		active = ctx.mode === "tui";
		if (active) activateCompactToolSpacing();
	});

	pi.on("session_shutdown", () => {
		if (!active) return;
		active = false;
		deactivateCompactToolSpacing();
	});
}

export function withMepieToolUi<
	TParams extends TSchema,
	TDetails,
	TOriginalState,
>(
	definition: ToolDefinition<TParams, TDetails, TOriginalState>,
	view: ToolView<Static<TParams>, TDetails>,
): ToolDefinition<TParams, TDetails, ToolUiState> {
	return {
		...definition,
		renderShell: "self",
		renderCall(args, theme, context) {
			const compactCall = context.expanded ? undefined : view.compactCall?.(args, context.cwd, theme);
			if (compactCall) {
				const insetCall = new HorizontalInset(compactCall);
				mepieToolCallComponents.add(insetCall);
				return insetCall;
			}

			const line = context.lastComponent instanceof SummaryLine
				? context.lastComponent
				: new SummaryLine();
			line.update({
				icon: view.icon,
				label: view.label,
				target: sanitizeInline(view.target(args, context.cwd)),
				targetTruncation: view.targetTruncation ?? "middle",
				theme,
				context,
				state: context.state,
			});
			mepieToolCallComponents.add(line);
			return line;
		},
		renderResult(result, options, theme, context) {
			if (!options.isPartial && !context.isError) {
				context.state.finalSummary = view.summary(context.args, result);
			}
			if (context.isError) return renderErrorResult(result, options, theme);
			if (!options.expanded) return new Container();
			return new HorizontalInset(view.expanded(context.args, result, theme));
		},
	};
}

function activateCompactToolSpacing(): void {
	compactSpacingUsers += 1;
	if (compactSpacingUsers > 1) return;

	const originalRender = ToolExecutionComponent.prototype.render;
	const compactRender: ToolExecutionRender = function (width) {
		const lines = originalRender.call(this, width);
		// Pi owns the leading spacer outside custom renderers, so identify our call component at runtime.
		const callComponent = Reflect.get(this, "callRendererComponent");
		const isMepieTool = typeof callComponent === "object"
			&& callComponent !== null
			&& mepieToolCallComponents.has(callComponent);
		return isMepieTool && lines[0] === "" ? lines.slice(1) : lines;
	};

	originalToolExecutionRender = originalRender;
	compactToolExecutionRender = compactRender;
	ToolExecutionComponent.prototype.render = compactRender;
}

function deactivateCompactToolSpacing(): void {
	if (compactSpacingUsers === 0) return;
	compactSpacingUsers -= 1;
	if (compactSpacingUsers > 0) return;

	if (
		originalToolExecutionRender
		&& compactToolExecutionRender
		&& ToolExecutionComponent.prototype.render === compactToolExecutionRender
	) {
		ToolExecutionComponent.prototype.render = originalToolExecutionRender;
	}
	originalToolExecutionRender = undefined;
	compactToolExecutionRender = undefined;
}

export function textContent<TDetails>(result: AgentToolResult<TDetails>): string {
	return result.content
		.filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

export function returnedLines(text: string): string[] {
	const content = text.split("\n\n[")[0] ?? "";
	if (content.length === 0) return [];
	return content.split("\n");
}

export function countLines(text: string): number {
	if (text.length === 0) return 0;
	return text.split("\n").length;
}

export function resultText(result: AgentToolResult<unknown>, theme: Theme): Component {
	const text = textContent(result);
	return text ? new Text(theme.fg("toolOutput", text), 0, 0) : new Container();
}

function renderErrorResult<TDetails>(
	result: AgentToolResult<TDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Component {
	return new ErrorResult(textContent(result) || "Unknown tool error", options.expanded, theme);
}

class SummaryLine implements Component {
	private input: SummaryLineInput | undefined;

	update(input: SummaryLineInput): void {
		this.input = input;
	}

	render(width: number): string[] {
		if (!this.input || width <= 0) return [];
		const contentWidth = insetContentWidth(width);
		const { context, icon, label, state, target, targetTruncation, theme } = this.input;
		const heading = `${theme.fg("text", icon)} ${theme.fg(toolTone(context), theme.bold(label))}`;
		const summary = summaryText(context, state.finalSummary, theme);
		const targetPrefix = target ? " " : "";
		const fixedWidth = visibleWidth(heading) + visibleWidth(targetPrefix) + visibleWidth(summary);
		const targetWidth = Math.max(0, contentWidth - fixedWidth);
		const fittedTarget = fitTarget(target, targetWidth, targetTruncation);
		const line = `${heading}${fittedTarget ? `${targetPrefix}${theme.fg("muted", fittedTarget)}` : ""}${summary}`;
		return insetLines([truncateToWidth(line, contentWidth, "…")], width);
	}

	invalidate(): void {}
}

class ErrorResult implements Component {
	constructor(
		private readonly message: string,
		private readonly expanded: boolean,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const lines = this.message
			.replaceAll("\r\n", "\n")
			.replaceAll("\r", "\n")
			.split("\n")
			.map((line) => sanitizeInline(line).trim())
			.filter(Boolean);
		const visibleLines = this.expanded ? lines : [lines.at(-1) ?? "Unknown tool error"];
		const content = visibleLines
			.map((line, index) => `${this.theme.fg("dim", index === 0 ? "╰─ " : "   ")}${this.theme.fg("error", line)}`)
			.join("\n");
		const contentWidth = insetContentWidth(width);
		if (this.expanded) return insetLines(new Text(content, 0, 0).render(contentWidth), width);
		return insetLines([truncateToWidth(content, contentWidth, "…")], width);
	}

	invalidate(): void {}
}

class HorizontalInset implements Component {
	constructor(private readonly component: Component) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		return insetLines(this.component.render(insetContentWidth(width)), width);
	}

	invalidate(): void {
		this.component.invalidate();
	}
}

function insetContentWidth(width: number): number {
	return Math.max(1, width - HORIZONTAL_PADDING * 2);
}

function insetLines(lines: readonly string[], width: number): string[] {
	if (width <= HORIZONTAL_PADDING * 2) {
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}
	const margin = " ".repeat(HORIZONTAL_PADDING);
	const contentWidth = insetContentWidth(width);
	return lines.map((line) => `${margin}${truncateToWidth(line, contentWidth, "…")}${margin}`);
}

function summaryText(
	context: ToolStateContext,
	parts: readonly SummaryPart[] | undefined,
	theme: Theme,
): string {
	if (context.isError) return theme.fg("dim", " · ") + theme.fg("error", "failed");
	if (context.isPartial || !parts || parts.length === 0) return "";
	return parts.reduce((text, part, index) => {
		const separator = index === 0 || part.separator !== "space" ? " · " : " ";
		return text + theme.fg("dim", separator) + theme.fg(part.color ?? "success", part.text);
	}, "");
}

function toolTone(context: ToolStateContext): ThemeColor {
	if (context.isError) return "error";
	if (!context.isPartial) return "toolTitle";
	if (context.executionStarted) return "accent";
	return "dim";
}

function fitTarget(text: string, width: number, mode: "end" | "middle"): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (mode === "end" || width < 4) return truncateToWidth(text, width, "…");
	const contentWidth = width - 1;
	const tailWidth = Math.max(1, Math.ceil(contentWidth * 0.6));
	const headWidth = contentWidth - tailWidth;
	const totalWidth = visibleWidth(text);
	return `${sliceByColumn(text, 0, headWidth, true)}…${sliceByColumn(text, totalWidth - tailWidth, tailWidth, true)}`;
}

function sanitizeInline(value: string): string {
	return value
		.replace(/(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g, "")
		.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
