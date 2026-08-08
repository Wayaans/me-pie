import {
	getMarkdownTheme,
	type AgentToolResult,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { closeTargetKindFromId, type TerminalTarget, type WorkspaceResult } from "./model.ts";
import type { WorkspaceParameters } from "./schema.ts";

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const PROGRESS_INTERVAL_MS = 160;
const NARROW_WIDTH = 32;
const WAIT_BOUNDARY = "Wait listens on the selected target inbox; the signal reports its source pane.";
const WAIT_TIMEOUT_GUIDANCE = "After a timeout, call workspace wait again with the returned sequence.";

export interface WorkspaceProgressDetails {
	readonly workspaceUi: {
		readonly action: "wait";
		readonly elapsedMs: number;
		readonly frame: number;
	};
}

export type WorkspaceToolDetails = WorkspaceResult | WorkspaceProgressDetails | undefined;
type WorkspaceToolResult = AgentToolResult<WorkspaceToolDetails>;
type WorkspaceUpdate = (partial: WorkspaceToolResult) => void;
interface WorkspaceRenderContext {
	readonly args: WorkspaceParameters;
	readonly isError: boolean;
}

interface WorkspaceView {
	readonly icon: string;
	readonly tone: "success" | "warning" | "error" | "accent";
	readonly status: string;
	readonly meta?: string;
	readonly details: readonly string[];
	readonly preview?: string;
	readonly markdown?: string;
}

export async function runWithWorkspaceWaitProgress<A>(
	onUpdate: WorkspaceUpdate | undefined,
	work: () => Promise<A>,
): Promise<A> {
	const startedAt = Date.now();
	let frame = 0;
	const publish = (): void => {
		const elapsedMs = Date.now() - startedAt;
		onUpdate?.({
			content: [{ type: "text", text: `Waiting for a workspace inbox signal · ${formatElapsed(elapsedMs)}` }],
			details: { workspaceUi: { action: "wait", elapsedMs, frame } },
		});
		frame = (frame + 1) % SPINNER_FRAMES.length;
	};
	publish();
	const timer = onUpdate ? setInterval(publish, PROGRESS_INTERVAL_MS) : undefined;
	timer?.unref();
	try {
		return await work();
	} finally {
		if (timer) clearInterval(timer);
	}
}

export function renderWorkspaceCall(args: WorkspaceParameters, theme: Theme): Component {
	const meta = formatCallMeta(args).join(" · ");
	return new ResponsiveComponent((width) => width < NARROW_WIDTH
		? new Text(theme.fg("toolTitle", theme.bold(formatNarrowCall(args))), 0, 0)
		: new Text(
			`${theme.fg("toolTitle", theme.bold("◆ Workspace"))}${theme.fg("muted", ` · ${titleCase(args.action)} · ${meta}`)}`,
			0,
			0,
		));
}

export function renderWorkspaceResult(
	result: WorkspaceToolResult,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: WorkspaceRenderContext,
): Component {
	const view = createResultView(result, options, context);
	return new ResponsiveComponent((width) => {
		const component = new Container();
		const meta = width < NARROW_WIDTH ? formatNarrowResultMeta(result, context) : view.meta;
		component.addChild(new Text(formatStatus(view, meta, theme), 0, 0));
		if (width >= NARROW_WIDTH) {
			if (options.expanded) addDetails(component, view, theme);
			addPreview(component, view, options.expanded, theme);
		}
		return component;
	});
}

export function formatElapsed(elapsedMs: number): string {
	const seconds = Math.max(0, elapsedMs) / 1_000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${Math.floor(seconds % 60).toString().padStart(2, "0")}s`;
}

function createResultView(
	result: WorkspaceToolResult,
	options: ToolRenderResultOptions,
	context: WorkspaceRenderContext,
): WorkspaceView {
	const message = sanitizeInline(textContent(result).trim());
	if (context.isError) return createErrorView(context.args.action, message);
	if (options.isPartial) return createPartialView(context.args, result.details);
	if (!isWorkspaceResult(result.details)) {
		return {
			icon: "!",
			tone: "warning",
			status: `${titleCase(context.args.action)} returned no details`,
			...(message ? { meta: message } : {}),
			details: [],
		};
	}
	return createFinalView(result.details, context.args);
}

function createErrorView(action: WorkspaceParameters["action"], message: string): WorkspaceView {
	const cancelledWait = action === "wait" && /cancel|abort/i.test(message);
	return {
		icon: "✕",
		tone: "error",
		status: cancelledWait ? "Wait cancelled" : `${titleCase(action)} failed`,
		...(message ? { meta: message } : {}),
		details: [],
	};
}

function createPartialView(args: WorkspaceParameters, details: WorkspaceToolDetails): WorkspaceView {
	if (args.action !== "wait") {
		return { icon: "◐", tone: "accent", status: `${titleCase(args.action)} in progress`, details: [] };
	}
	const progress = workspaceProgress(details);
	const frame = SPINNER_FRAMES[(progress?.frame ?? 0) % SPINNER_FRAMES.length]!;
	return {
		icon: frame,
		tone: "accent",
		status: "Waiting for inbox signal",
		meta: `${sanitizeInline(args.wait?.targetId ?? "?")} · ${formatElapsed(progress?.elapsedMs ?? 0)}`,
		details: [WAIT_BOUNDARY, WAIT_TIMEOUT_GUIDANCE],
	};
}

function createFinalView(result: WorkspaceResult, args: WorkspaceParameters): WorkspaceView {
	switch (result.action) {
		case "spawn": return createSpawnView(result.target, args);
		case "run": return createRunView(result, args);
		case "send": return createSendView(result, args);
		case "wait": return createWaitView(result);
		case "close": return createCloseView(result);
	}
}

function createSpawnView(target: TerminalTarget, args: WorkspaceParameters): WorkspaceView {
	const kind = titleCase(args.action === "spawn" ? (args.spawn?.kind ?? "window") : "window");
	return {
		icon: "✓",
		tone: "success",
		status: `${kind} ready`,
		meta: targetHierarchy(target),
		details: targetDetails(target),
	};
}

function createRunView(result: Extract<WorkspaceResult, { action: "run" }>, args: WorkspaceParameters): WorkspaceView {
	const run = args.action === "run" ? args.run : undefined;
	const model = run?.model ? sanitizeInline(run.model) : undefined;
	const thinking = run?.thinking;
	return {
		icon: "✓",
		tone: "success",
		status: `${titleCase(result.agent)} launched`,
		meta: `${sanitizeInline(result.target.paneId)} · ${result.spawnedTarget ? "new target" : "existing target"}`,
		details: [
			...(model ? [`model ${model}${thinking ? ` · thinking ${thinking}` : ""}`] : thinking ? [`thinking ${thinking}`] : []),
			...targetDetails(result.target),
		],
	};
}

function createSendView(result: Extract<WorkspaceResult, { action: "send" }>, args: WorkspaceParameters): WorkspaceView {
	const send = args.action === "send" ? args.send : undefined;
	const source = sanitizeMultiline(send?.text ?? "");
	const firstLine = source.split("\n").find((line) => line.trim())?.trim();
	return {
		icon: "✓",
		tone: "success",
		status: `${titleCase(result.input)} ${send?.submit === false ? "pasted" : "sent"}`,
		meta: `${sanitizeInline(result.sourcePaneId)} → ${sanitizeInline(result.target.paneId)} · recipient sequence ${result.sequence} · ${result.bytes} B`,
		details: [
			...targetDetails(result.target),
			`wait on ${sanitizeInline(result.sourcePaneId)} for reply from ${sanitizeInline(result.target.paneId)} after sequence ${result.replyAfterSequence}`,
			`delivery ${sanitizeInline(result.deliveryId)}`,
		],
		...(firstLine ? { preview: firstLine } : {}),
		...(source ? { markdown: source } : {}),
	};
}

function createCloseView(result: Extract<WorkspaceResult, { action: "close" }>): WorkspaceView {
	return {
		icon: "✓",
		tone: "success",
		status: `${titleCase(result.kind)} closed`,
		meta: targetHierarchy(result.target),
		details: [
			`closed ${sanitizeInline(closedTargetId(result))}`,
			...targetDetails(result.target).slice(0, 3),
			`command ${sanitizeInline(result.target.currentCommand)} before close`,
		],
	};
}

function createWaitView(result: Extract<WorkspaceResult, { action: "wait" }>): WorkspaceView {
	const route = result.reason === "signaled"
		? `${sanitizeInline(result.sourcePaneId)} → ${sanitizeInline(result.target.paneId)}`
		: `inbox ${sanitizeInline(result.target.paneId)}`;
	const meta = `${route} · sequence ${result.sequence} · ${formatElapsed(result.elapsedMs)}`;
	const details = [...targetDetails(result.target), WAIT_BOUNDARY];
	if (result.reason === "signaled") {
		return { icon: "✓", tone: "success", status: "Inbox signal received", meta, details };
	}
	return {
		icon: "!",
		tone: "warning",
		status: "No inbox signal before timeout",
		meta,
		details: [...details, WAIT_TIMEOUT_GUIDANCE],
	};
}

function formatCallMeta(args: WorkspaceParameters): string[] {
	switch (args.action) {
		case "spawn": {
			const spawn = args.spawn;
			const kind = spawn?.kind ?? "window";
			return compact([
				titleCase(kind),
				spawn?.targetId ? `from ${sanitizeInline(spawn.targetId)}` : undefined,
				spawn?.cwd ? sanitizeInline(spawn.cwd) : undefined,
				kind === "pane" ? spawn?.direction : undefined,
				spawn?.focus ? "focus" : undefined,
			]);
		}
		case "run": {
			const run = args.run;
			return compact([
				titleCase(run?.agent ?? "pi"),
				run?.targetId ? sanitizeInline(run.targetId) : "new target",
				run?.model ? sanitizeInline(run.model) : undefined,
				run?.thinking,
				run?.replace ? "replace" : undefined,
			]);
		}
		case "send": return [
			titleCase(args.send?.input ?? "input"),
			sanitizeInline(args.send?.targetId ?? "?"),
			args.send?.submit === false ? "paste only" : "submit",
		];
		case "wait": return compact([
			"Inbox",
			sanitizeInline(args.wait?.targetId ?? "?"),
			args.wait?.afterSequence === undefined ? undefined : `after ${args.wait.afterSequence}`,
			args.wait?.timeoutMs === undefined ? undefined : `timeout ${formatElapsed(args.wait.timeoutMs)}`,
		]);
		case "close": return [
			titleCase(closeTargetKindFromId(args.close?.targetId ?? "")),
			sanitizeInline(args.close?.targetId ?? "?"),
		];
	}
}

function formatNarrowCall(args: WorkspaceParameters): string {
	switch (args.action) {
		case "spawn": return `Workspace · Spawn ${args.spawn?.kind ?? "window"}`;
		case "run": return `Workspace · Run ${titleCase(args.run?.agent ?? "pi")} → ${sanitizeInline(args.run?.targetId ?? "new")}`;
		case "send": return `Workspace · Send ${args.send?.input ?? "input"} → ${sanitizeInline(args.send?.targetId ?? "?")}`;
		case "wait": return `Workspace · Wait inbox ${sanitizeInline(args.wait?.targetId ?? "?")}`;
		case "close": return `Workspace · Close ${sanitizeInline(args.close?.targetId ?? "?")}`;
	}
}

function formatNarrowResultMeta(result: WorkspaceToolResult, context: WorkspaceRenderContext): string | undefined {
	if (context.isError) return targetId(context.args);
	const progress = workspaceProgress(result.details);
	if (progress) return `${targetId(context.args) ?? "?"} · ${formatElapsed(progress.elapsedMs)}`;
	if (!isWorkspaceResult(result.details)) return undefined;
	switch (result.details.action) {
		case "spawn": return sanitizeInline(result.details.target.paneId);
		case "run": return sanitizeInline(result.details.target.paneId);
		case "send": return `${sanitizeInline(result.details.sourcePaneId)} → ${sanitizeInline(result.details.target.paneId)} · seq ${result.details.sequence}`;
		case "wait": return result.details.reason === "signaled"
			? `${sanitizeInline(result.details.sourcePaneId)} → ${sanitizeInline(result.details.target.paneId)} · ${formatElapsed(result.details.elapsedMs)}`
			: `${sanitizeInline(result.details.target.paneId)} · ${formatElapsed(result.details.elapsedMs)}`;
		case "close": return sanitizeInline(closedTargetId(result.details));
	}
}

function formatStatus(view: WorkspaceView, meta: string | undefined, theme: Theme): string {
	const status = theme.fg(view.tone, theme.bold(`${view.icon} ${view.status}`));
	return meta ? `${status}${theme.fg("muted", ` · ${meta}`)}` : status;
}

function addDetails(component: Container, view: WorkspaceView, theme: Theme): void {
	for (const detail of view.details) component.addChild(new Text(theme.fg("dim", `  ${detail}`), 0, 0));
}

function addPreview(component: Container, view: WorkspaceView, expanded: boolean, theme: Theme): void {
	if (!view.markdown) return;
	component.addChild(new Spacer(1));
	if (expanded) {
		component.addChild(new Markdown(view.markdown, 0, 0, getMarkdownTheme(), {
			color: (text) => theme.fg("toolOutput", text),
		}));
	} else if (view.preview) {
		component.addChild(new Text(theme.fg("toolOutput", `  ${view.preview}`), 0, 0));
	}
}

function workspaceProgress(details: WorkspaceToolDetails): WorkspaceProgressDetails["workspaceUi"] | undefined {
	if (!details || typeof details !== "object" || !("workspaceUi" in details)) return undefined;
	const progress = details.workspaceUi;
	if (!progress || progress.action !== "wait") return undefined;
	if (!Number.isFinite(progress.elapsedMs) || progress.elapsedMs < 0) return undefined;
	if (!Number.isInteger(progress.frame) || progress.frame < 0) return undefined;
	return progress;
}

function isWorkspaceResult(details: WorkspaceToolDetails): details is WorkspaceResult {
	if (!details || typeof details !== "object" || !("action" in details)) return false;
	const candidate = details as unknown as Record<string, unknown>;
	if (!isTerminalTarget(candidate.target)) return false;
	switch (candidate.action) {
		case "spawn": return true;
		case "run": return typeof candidate.agent === "string" &&
			typeof candidate.executable === "string" && typeof candidate.spawnedTarget === "boolean";
		case "send": return typeof candidate.sourcePaneId === "string" && /^%[0-9]+$/.test(candidate.sourcePaneId) &&
			typeof candidate.deliveryId === "string" && Number.isInteger(candidate.sequence) &&
			Number.isInteger(candidate.replyAfterSequence) && Number.isInteger(candidate.bytes) &&
			(candidate.input === "prompt" || candidate.input === "command");
		case "wait": return (candidate.reason === "signaled" || candidate.reason === "timeout") &&
			(candidate.reason !== "signaled" || (typeof candidate.sourcePaneId === "string" && /^%[0-9]+$/.test(candidate.sourcePaneId))) &&
			Number.isInteger(candidate.sequence) && typeof candidate.elapsedMs === "number" && Number.isFinite(candidate.elapsedMs);
		case "close": return candidate.kind === "window" || candidate.kind === "pane";
		default: return false;
	}
}

function isTerminalTarget(value: unknown): value is TerminalTarget {
	if (!value || typeof value !== "object") return false;
	const target = value as Record<string, unknown>;
	return target.environment === "tmux" &&
		typeof target.sessionId === "string" && typeof target.sessionName === "string" &&
		typeof target.windowId === "string" && typeof target.windowName === "string" &&
		typeof target.paneId === "string" && typeof target.cwd === "string" &&
		typeof target.currentCommand === "string" && typeof target.dead === "boolean";
}

function targetId(args: WorkspaceParameters): string | undefined {
	switch (args.action) {
		case "spawn": return args.spawn?.targetId ? sanitizeInline(args.spawn.targetId) : undefined;
		case "run": return args.run?.targetId ? sanitizeInline(args.run.targetId) : undefined;
		case "send": return args.send?.targetId ? sanitizeInline(args.send.targetId) : undefined;
		case "wait": return args.wait?.targetId ? sanitizeInline(args.wait.targetId) : undefined;
		case "close": return args.close?.targetId ? sanitizeInline(args.close.targetId) : undefined;
	}
}

function targetDetails(target: TerminalTarget): readonly string[] {
	return [
		`pane ${sanitizeInline(target.paneId)} · window ${sanitizeInline(target.windowId)}/${sanitizeInline(target.windowName)}`,
		`session ${sanitizeInline(target.sessionId)}/${sanitizeInline(target.sessionName)}`,
		`cwd ${sanitizeInline(target.cwd)}`,
		`command ${sanitizeInline(target.currentCommand)} · ${target.dead ? "dead" : "alive"}`,
	];
}

function targetHierarchy(target: TerminalTarget): string {
	return `${sanitizeInline(target.paneId)} · ${sanitizeInline(target.windowId)}/${sanitizeInline(target.windowName)} · ${sanitizeInline(target.sessionId)}/${sanitizeInline(target.sessionName)}`;
}

function textContent(result: WorkspaceToolResult): string {
	return result.content
		.filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function sanitizeMultiline(value: string): string {
	return value
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.replaceAll("\t", "  ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "�");
}

function sanitizeInline(value: string): string {
	return sanitizeMultiline(value).replaceAll("\n", " ↵ ");
}

function closedTargetId(result: Extract<WorkspaceResult, { action: "close" }>): string {
	return result.kind === "window" ? result.target.windowId : result.target.paneId;
}

function titleCase(value: string): string {
	return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function compact(values: readonly (string | undefined)[]): string[] {
	return values.filter((value): value is string => value !== undefined);
}

class ResponsiveComponent implements Component {
	constructor(private readonly build: (width: number) => Component) {}
	render(width: number): string[] { return this.build(width).render(width); }
	invalidate(): void {}
}
