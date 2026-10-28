import { highlightCode, keyText, type AgentToolResult, type ExtensionAPI, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { nestedToolView, type NestedToolView } from "./nested-views.ts";
import { TOOL_ICONS } from "./tool-icons.ts";
import { fitTarget, mepieToolRenderers, sanitizeInline, toolTone, type SummaryPart, type ToolView } from "./tool-renderer.ts";
import { isRecord } from "../mepie/settings.ts";
import type { ToolRenderMode } from "../mepie/tool-mode.ts";

type NestedCallStatus = "running" | "ok" | "error" | "cancelled";
/** One entry of codemode's `details.calls`. `args` is a JSON preview that codemode cuts at 200 characters. */
interface NestedCall {
	readonly name: string;
	readonly args: string;
	readonly status: NestedCallStatus;
	readonly durationMs?: number;
	readonly error?: string;
}

interface CodemodeDetails {
	readonly calls: readonly NestedCall[];
	readonly fullOutputPath?: string;
}

type TreeItem =
	| { readonly kind: "call"; readonly call: NestedCall }
	| { readonly kind: "error"; readonly message: string }
	| { readonly kind: "hidden"; readonly count: number };

const COLLAPSED_CALL_LIMIT = 8;
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;
const SCRIPT_ERROR_MARKER = "Script error:\n";
// Closers for a JSON preview cut inside a string, an object, or an array of objects.
const PREVIEW_CLOSERS = ["", "\"}", "}", "\"]}", "]}", "\"}]}", "}]}"];

/** Draw codemode scripts as a Mepie row whose nested calls use the same labels as direct tool rows. */
export function registerCodemodeUi(pi: ExtensionAPI, cwd: string, mode: ToolRenderMode): void {
	if (mode === "builtin") return;
	const renderers = mepieToolRenderers<TSchema, unknown, unknown>("codemode", createCodemodeView(cwd), mode);
	pi.registerToolRenderer((toolName, next) => toolName === "codemode" ? renderers : next());
}

// Arguments stay unknown: renderers also draw streaming and invalid calls.
function createCodemodeView(cwd: string): ToolView<unknown, unknown> {
	return {
		icon: TOOL_ICONS.code,
		label: "Codemode",
		target: () => "",
		summary(_args, result, durationMs) {
			const { calls, fullOutputPath } = parseCodemodeDetails(result.details);
			const failed = calls.filter((call) => call.status === "error").length;
			const parts: SummaryPart[] = [{ text: `${calls.length} ${calls.length === 1 ? "call" : "calls"}` }];
			if (failed > 0) parts.push({ text: `${failed} failed`, color: "warning" });
			if (fullOutputPath) parts.push({ text: "output truncated", color: "warning" });
			if (durationMs !== undefined) parts.push({ text: formatDuration(durationMs), color: "muted" });
			return parts;
		},
		collapsed(_args, result, theme) {
			const { calls } = parseCodemodeDetails(result.details);
			return calls.length > 0 ? new NestedCallTree(treeItems(calls, false), false, cwd, theme) : new Container();
		},
		expanded(args, result, theme) {
			return expandedResult(args, result, theme, cwd, "toolOutput");
		},
		failed(args, result, theme, expanded) {
			if (expanded) return expandedResult(args, result, theme, cwd, "error");
			const { calls } = parseCodemodeDetails(result.details);
			const message = scriptErrorLine(scriptOutput(result));
			const items = treeItems(calls, false);
			const visibleCalls = items.flatMap((item) => item.kind === "call" ? [item.call] : []);
			if (!repeatsCallError(message, visibleCalls)) items.push({ kind: "error", message });
			return new NestedCallTree(items, false, cwd, theme);
		},
	};
}

function expandedResult(
	args: unknown,
	result: AgentToolResult<unknown>,
	theme: Theme,
	cwd: string,
	outputColor: ThemeColor,
): Component {
	const { calls, fullOutputPath } = parseCodemodeDetails(result.details);
	const component = new Container();
	if (calls.length > 0) component.addChild(new NestedCallTree(treeItems(calls, true), true, cwd, theme));
	const code = isRecord(args) && typeof args.code === "string" ? args.code.replaceAll("\r", "").replaceAll("\t", "   ").trimEnd() : "";
	if (code) component.addChild(new Text(`\n${highlightCode(code, "javascript").join("\n")}`, 0, 0));
	// Failed scripts end with a summary of the calls the tree already shows.
	const output = withoutCallSummary(scriptOutput(result)).trim();
	if (output) component.addChild(new Text(`\n${theme.fg(outputColor, output.replaceAll("\t", "   "))}`, 0, 0));
	if (fullOutputPath) component.addChild(new Text(`\n${theme.fg("dim", `Full output: ${fullOutputPath}`)}`, 0, 0));
	return component;
}

function treeItems(calls: readonly NestedCall[], expanded: boolean): TreeItem[] {
	const hidden = expanded ? 0 : Math.max(0, calls.length - COLLAPSED_CALL_LIMIT);
	const shown = calls.slice(hidden).map((call): TreeItem => ({ kind: "call", call }));
	return hidden > 0 ? [{ kind: "hidden", count: hidden }, ...shown] : shown;
}

class NestedCallTree implements Component {
	constructor(
		private readonly items: readonly TreeItem[],
		private readonly expanded: boolean,
		private readonly cwd: string,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		return this.items.flatMap((item, index) => {
			const isLast = index === this.items.length - 1;
			const prefix = this.theme.fg("dim", isLast ? "╰─ " : "├─ ");
			const continuation = this.theme.fg("dim", isLast ? "   " : "│  ");
			return this.renderItem(item, prefix, continuation, width);
		});
	}

	invalidate(): void {}

	private renderItem(item: TreeItem, prefix: string, continuation: string, width: number): string[] {
		const { theme } = this;
		switch (item.kind) {
			case "hidden": {
				const hint = `… ${item.count} earlier ${item.count === 1 ? "call" : "calls"} (${keyText("app.tools.expand")} to expand)`;
				return [truncateToWidth(`${prefix}${theme.fg("muted", hint)}`, width, "…")];
			}
			case "error":
				return [truncateToWidth(`${prefix}${theme.fg("error", item.message)}`, width, "…")];
			case "call":
				return [
					callRow(item.call, prefix, width, this.cwd, theme),
					...this.callDetails(item.call, continuation, width),
				];
		}
	}

	private callDetails(call: NestedCall, continuation: string, width: number): string[] {
		const { theme } = this;
		const details: string[] = [];
		if (this.expanded && call.args) details.push(theme.fg("muted", sanitizeInline(call.args)));
		const errorLines = call.status === "error" ? textLines(call.error ?? "Tool failed") : [];
		if (errorLines.length > 0) {
			const visible = this.expanded ? errorLines : errorLines.slice(-1);
			details.push(...visible.map((line) => theme.fg("error", line)));
		}
		return details.flatMap((line, index) => {
			const isLast = index === details.length - 1;
			const first = `${continuation}${theme.fg("dim", isLast ? "╰─ " : "├─ ")}`;
			const rest = `${continuation}${theme.fg("dim", isLast ? "   " : "│  ")}`;
			return renderIndented(line, first, rest, width, this.expanded);
		});
	}
}

function callRow(call: NestedCall, prefix: string, width: number, cwd: string, theme: Theme): string {
	const view = nestedToolView(call.name);
	const icon = view?.icon ?? TOOL_ICONS.tool;
	const label = view?.label ?? call.name;
	const heading = `${theme.fg("text", icon)} ${theme.fg(callTone(call.status), theme.bold(sanitizeInline(label)))}`;
	const status = call.status === "cancelled" ? "cancelled" : call.durationMs === undefined ? "" : formatDuration(call.durationMs);
	const duration = status ? ` ${theme.fg("dim", status)}` : "";
	const target = callTarget(call, view, cwd);
	const fixedWidth = visibleWidth(prefix) + visibleWidth(heading) + visibleWidth(duration) + (target ? 1 : 0);
	const fitted = fitTarget(target, Math.max(0, width - fixedWidth), view?.targetTruncation ?? "end");
	const left = `${prefix}${heading}${fitted ? ` ${theme.fg(view?.targetColor ?? "muted", fitted)}` : ""}`;
	const gap = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(duration)));
	return truncateToWidth(`${left}${gap}${duration}`, width, "…");
}

function callTarget(call: NestedCall, view: NestedToolView | undefined, cwd: string): string {
	const args = parseArgsPreview(call.args);
	if (view && args) {
		try {
			return sanitizeInline(view.target(args, cwd));
		} catch {
			// Arguments that failed the tool's validation can break its target; show them raw.
		}
	}
	return sanitizeInline(call.args);
}

function renderIndented(text: string, first: string, rest: string, width: number, wrap: boolean): string[] {
	const contentWidth = width - visibleWidth(first);
	if (contentWidth <= 0) return [truncateToWidth(first, width, "")];
	if (!wrap) return [`${first}${truncateToWidth(text, contentWidth, "…")}`];
	return wrapTextWithAnsi(text, contentWidth).map((line, index) => `${index === 0 ? first : rest}${line}`);
}

function callTone(status: NestedCallStatus): ThemeColor {
	if (status === "cancelled") return "dim";
	return toolTone({ isPartial: status === "running", isError: status === "error" });
}

/** Parse a possibly truncated JSON preview of a call's arguments. */
export function parseArgsPreview(preview: string): Readonly<Record<string, unknown>> | undefined {
	const cut = preview.endsWith("...") ? preview.slice(0, -3) : preview;
	// A preview cut after an escape character cannot be closed; drop the unpaired backslash.
	const base = cut.replace(/\\+$/, (slashes) => slashes.length % 2 === 1 ? slashes.slice(1) : slashes);
	for (const closer of PREVIEW_CLOSERS) {
		try {
			const value: unknown = JSON.parse(base + closer);
			if (isRecord(value)) return value;
		} catch {
			// Try the next closer.
		}
	}
	return undefined;
}

function parseCodemodeDetails(details: unknown): CodemodeDetails {
	if (!isRecord(details)) return { calls: [] };
	const calls = Array.isArray(details.calls) ? details.calls.flatMap(parseNestedCall) : [];
	const fullOutputPath = typeof details.fullOutputPath === "string" ? details.fullOutputPath : undefined;
	return fullOutputPath ? { calls, fullOutputPath } : { calls };
}

function parseNestedCall(value: unknown): NestedCall[] {
	if (!isRecord(value) || typeof value.name !== "string" || !isNestedCallStatus(value.status)) return [];
	return [{
		name: value.name,
		args: typeof value.args === "string" ? value.args : "",
		status: value.status,
		...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
		...(typeof value.error === "string" ? { error: value.error } : {}),
	}];
}

function isNestedCallStatus(value: unknown): value is NestedCallStatus {
	return value === "running" || value === "ok" || value === "error" || value === "cancelled";
}

/** The script's text output without codemode's "Script completed" header. */
function scriptOutput(result: AgentToolResult<unknown>): string {
	const [first, ...rest] = result.content;
	const content = first?.type === "text" && SCRIPT_HEADER.test(first.text) ? rest : result.content;
	return content.map((item) => item.type === "text" ? item.text : `[Image: ${item.mimeType}]`).join("\n");
}

function withoutCallSummary(output: string): string {
	const marker = output.lastIndexOf(SCRIPT_ERROR_MARKER);
	if (marker < 0) return output;
	const summary = output.indexOf("\n\n", marker + SCRIPT_ERROR_MARKER.length);
	return summary < 0 ? output : output.slice(0, summary);
}

/** The first line of the script's error, which names it before the stack and call summary. */
function scriptErrorLine(output: string): string {
	const marker = output.lastIndexOf(SCRIPT_ERROR_MARKER);
	const text = marker >= 0 ? output.slice(marker + SCRIPT_ERROR_MARKER.length) : output;
	return textLines(text)[0] ?? "Script failed";
}

/**
 * An uncaught failed call surfaces again as the script's error, `Error: <first line of the call's error>`;
 * show it once, under the call.
 */
function repeatsCallError(message: string, calls: readonly NestedCall[]): boolean {
	return calls.some((call) => {
		if (call.status !== "error" || !call.error) return false;
		const callError = textLines(call.error)[0];
		return callError !== undefined && (message === callError || message === `Error: ${callError}`);
	});
}

function textLines(text: string): string[] {
	return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n").map(sanitizeInline).filter(Boolean);
}

function formatDuration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
