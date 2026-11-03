import {
	type AgentToolResult,
	type Theme,
	type ThemeColor,
	type ToolRenderers,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { describeCall, inline } from "./activity.ts";

type CallStatus = "running" | "ok" | "error" | "cancelled";

/** One entry of codemode's `details.calls`, which codemode republishes as each nested call starts and ends. */
export interface NestedCall {
	readonly name: string;
	readonly args: string;
	readonly status: CallStatus;
	readonly durationMs?: number;
	readonly error?: string;
}

/** Row-local state shared by `renderCall` and `renderResult`. Pi starts it as an empty object. */
export interface CodemodeRowState {
	calls?: readonly NestedCall[];
	failure?: string | undefined;
	startedAt?: number;
	timer?: ReturnType<typeof setInterval> | undefined;
}

// Pi does not export `ToolRenderContext`; derive it from the renderer signature and type our own state.
type RowContext = Omit<Parameters<NonNullable<ToolRenderers["renderCall"]>>[2], "state" | "args"> & {
	readonly state: CodemodeRowState;
	readonly args: unknown;
};

const CALL_ERROR_LINES = 5;
const SCRIPT_ERROR_MARKER = "Script error:\n";

/**
 * The header is a live activity line. Pi calls `renderCall` before `renderResult` in each update, so the
 * header reads the calls lazily at render time, after `renderResult` has stored them.
 */
export const codemodeRenderers: ToolRenderers = {
	renderCall(_args: unknown, theme: Theme, context: RowContext): Component {
		syncTimer(context);
		return new Lines((width) => [truncateToWidth(headerText(context, theme), width, "…")]);
	},
	renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: RowContext): Component {
		syncTimer(context);
		const calls = parseCalls(result.details);
		const failure = failureText(calls, result, context);
		context.state.calls = calls;
		context.state.failure = failure;
		if (!options.expanded) {
			return new Lines((width) => (failure ? [branchLine(theme.fg("dim", "╰─ "), theme.fg("error", failure), width)] : []));
		}
		return new Lines((width) => expandedLines(calls, failure, context, theme, width));
	},
};

/** A component whose lines are computed at render time. */
class Lines implements Component {
	constructor(private readonly build: (width: number) => string[]) {}

	render(width: number): string[] {
		return width > 0 ? this.build(width) : [];
	}

	invalidate(): void {}
}

/**
 * Redraw the row every second while the script runs, for the elapsed time. The timer stops as soon as
 * the result is final, and rows that are already final, such as resumed ones, never start one.
 */
function syncTimer(context: RowContext): void {
	const state = context.state;
	if (context.executionStarted && context.isPartial && !context.isError) {
		state.startedAt ??= Date.now();
		state.timer ??= setInterval(context.invalidate, 1000);
		return;
	}
	if (state.timer !== undefined) {
		clearInterval(state.timer);
		state.timer = undefined;
	}
}

function headerText(context: RowContext, theme: Theme): string {
	const calls: readonly NestedCall[] = context.state.calls ?? [];
	const count = calls.length > 0 ? `${calls.length} ${calls.length === 1 ? "tool" : "tools"}` : undefined;
	if (context.isPartial && !context.isError) {
		if (!context.executionStarted) return theme.fg("toolTitle", theme.bold("Preparing script"));
		const startedAt = context.state.startedAt;
		const elapsed = startedAt === undefined ? undefined : formatDuration(Date.now() - startedAt);
		return header(theme.fg("toolTitle", theme.bold(runningStatus(calls, context.cwd))), [count, elapsed], theme);
	}
	const failed = calls.filter((call) => call.status === "error").length;
	const cancelled = calls.filter((call) => call.status === "cancelled").length;
	const title = count ? `Ran ${count}` : context.isError ? "Script failed" : "Ran script";
	const titleColor: ThemeColor = context.isError || failed > 0 ? "error" : "toolTitle";
	return header(theme.fg(titleColor, theme.bold(title)), [
		failed > 0 ? theme.fg("error", `${failed} failed`) : undefined,
		cancelled > 0 ? `${cancelled} cancelled` : undefined,
		context.durationMs === undefined ? undefined : formatDuration(context.durationMs),
	], theme);
}

function header(title: string, meta: readonly (string | undefined)[], theme: Theme): string {
	const parts = meta.filter((part) => part !== undefined);
	return parts.length > 0 ? `${title} ${theme.fg("muted", `· ${parts.join(" · ")}`)}` : title;
}

/** The newest running call describes what the script is doing; between calls it is running its own code. */
function runningStatus(calls: readonly NestedCall[], cwd: string): string {
	const running = calls.filter((call) => call.status === "running").at(-1);
	return running ? describeCall(running.name, running.args, cwd).status : "Executing script";
}

/** The newest failed call, or the script's own error when no call failed. */
function failureText(calls: readonly NestedCall[], result: AgentToolResult<unknown>, context: RowContext): string | undefined {
	const failedCall = calls.filter((call) => call.status === "error").at(-1);
	if (failedCall) return `${inline(failedCall.name)}: ${firstLine(failedCall.error ?? "") ?? "failed"}`;
	if (context.isError && !context.isPartial) return scriptError(result);
	return undefined;
}

function expandedLines(
	calls: readonly NestedCall[],
	failure: string | undefined,
	context: RowContext,
	theme: Theme,
	width: number,
): string[] {
	const nameWidth = Math.max(0, ...calls.map((call) => visibleWidth(inline(call.name))));
	const scriptFailed = failure !== undefined && !calls.some((call) => call.status === "error");
	const lines = calls.flatMap((call, index) => {
		const isLast = index === calls.length - 1 && !scriptFailed;
		return callLines(call, isLast, nameWidth, context.cwd, theme, width);
	});
	if (scriptFailed) lines.push(branchLine(theme.fg("dim", "╰─ "), theme.fg("error", failure), width));
	return lines;
}

function callLines(call: NestedCall, isLast: boolean, nameWidth: number, cwd: string, theme: Theme, width: number): string[] {
	const name = inline(call.name);
	const duration = call.status === "cancelled" ? "cancelled" : call.durationMs === undefined ? "" : formatDuration(call.durationMs);
	const head = `${theme.fg("dim", isLast ? "╰─ " : "├─ ")}${statusIcon(call.status, theme)} ${theme.fg("toolTitle", name)}${" ".repeat(nameWidth - visibleWidth(name))}`;
	const target = describeCall(call.name, call.args, cwd).target;
	const durationWidth = duration ? visibleWidth(duration) + 1 : 0;
	const targetWidth = width - visibleWidth(head) - 2 - durationWidth;
	const fitted = target && targetWidth > 0 ? `  ${theme.fg("muted", truncateToWidth(target, targetWidth, "…"))}` : "";
	const left = `${head}${fitted}`;
	const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(duration)));
	const row = truncateToWidth(duration ? `${left}${gap}${theme.fg("dim", duration)}` : left, width, "…");
	if (call.status !== "error") return [row];
	const errorLines = textLines(call.error ?? "").slice(0, CALL_ERROR_LINES);
	const continuation = theme.fg("dim", isLast ? "   " : "│  ");
	return [
		row,
		...errorLines.map((line, index) =>
			branchLine(`${continuation}${theme.fg("dim", index === errorLines.length - 1 ? "╰─ " : "├─ ")}`, theme.fg("error", line), width),
		),
	];
}

function branchLine(prefix: string, text: string, width: number): string {
	return truncateToWidth(`${prefix}${text}`, width, "…");
}

function statusIcon(status: CallStatus, theme: Theme): string {
	switch (status) {
		case "running":
			return theme.fg("warning", "…");
		case "ok":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
		case "cancelled":
			return theme.fg("muted", "⊘");
	}
}

/** The first line of the script's error, which names the failure before its stack and call summary. */
function scriptError(result: AgentToolResult<unknown>): string {
	const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
	const marker = text.lastIndexOf(SCRIPT_ERROR_MARKER);
	if (marker >= 0) return firstLine(text.slice(marker + SCRIPT_ERROR_MARKER.length)) ?? "Script failed";
	const lines = textLines(text).filter((line) => !/^(Script (completed|failed)|Wall time .*|Output:)$/.test(line));
	return lines[0] ?? "Script failed";
}

function parseCalls(details: unknown): NestedCall[] {
	if (!isRecord(details) || !Array.isArray(details.calls)) return [];
	return details.calls.flatMap((value: unknown): NestedCall[] => {
		if (!isRecord(value) || typeof value.name !== "string" || !isCallStatus(value.status)) return [];
		return [{
			name: value.name,
			args: typeof value.args === "string" ? value.args : "",
			status: value.status,
			...(typeof value.durationMs === "number" ? { durationMs: value.durationMs } : {}),
			...(typeof value.error === "string" ? { error: value.error } : {}),
		}];
	});
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCallStatus(value: unknown): value is CallStatus {
	return value === "running" || value === "ok" || value === "error" || value === "cancelled";
}

function textLines(text: string): string[] {
	return text.split(/\r?\n|\r/).map(inline).filter((line) => line !== "");
}

function firstLine(text: string): string | undefined {
	return textLines(text)[0];
}

function formatDuration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
