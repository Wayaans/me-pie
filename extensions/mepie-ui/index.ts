/**
 * Theme-aware Mepie dashboard footer, adapted with permission from
 * https://github.com/davis7dotsh/my-pi-setup.
 */
import { homedir } from "node:os";
import { relative } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	GIT_INFO_CHANNEL,
	MODEL_INFO_CHANNEL,
	REFRESH_CHANNEL,
	emptyGitInfoState,
	emptyModelInfoState,
	isGitInfoState,
	isModelInfoState,
} from "./dashboard-state.ts";
import registerGitInfo from "./git-info.ts";
import registerModelInfo from "./model-info.ts";

// eslint-disable-next-line no-control-regex
const OSC_PATTERN = /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

export function sanitizeTerminalLabel(text: string): string {
	return text
		.replace(OSC_PATTERN, "")
		.replace(CSI_PATTERN, "")
		.replace(ESCAPE_PATTERN, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

export function formatTokens(tokens: number): string {
	if (tokens < 1_000) return `${tokens}`;
	if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}m`;
}

const THINKING_COLORS = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
} as const;

export function thinkingColorToken(level: string): (typeof THINKING_COLORS)[keyof typeof THINKING_COLORS] {
	return THINKING_COLORS[level as keyof typeof THINKING_COLORS] ?? "thinkingOff";
}

export function formatDirectory(cwd: string): string {
	const home = homedir();
	if (cwd === home) return "~";
	const display = cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
	return sanitizeTerminalLabel(display);
}

export function columns(left: string, right: string, width: number): string {
	if (!right) return truncateToWidth(left, width);
	const naturalGap = width - visibleWidth(left) - visibleWidth(right);
	if (naturalGap >= 1) return `${left}${" ".repeat(naturalGap)}${right}`;

	const leftWidth = Math.max(1, Math.floor(width * 0.45));
	const rightWidth = Math.max(1, width - leftWidth - 1);
	const fittedLeft = truncateToWidth(left, leftWidth);
	const fittedRight = truncateToWidth(right, rightWidth);
	const gap = Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(fittedRight));
	return truncateToWidth(`${fittedLeft}${" ".repeat(gap)}${fittedRight}`, width);
}

export function extensionStatusValues(statuses: ReadonlyMap<string, string>): string[] {
	return [...statuses.entries()]
		.sort(([first], [second]) => first.localeCompare(second))
		.flatMap(([, status]) => status.split("\n"))
		.filter((status) => status.length > 0);
}

export default function mepieUi(pi: ExtensionAPI): void {
	registerModelInfo(pi);
	registerGitInfo(pi);

	let title = "mepie";
	let modelInfo = emptyModelInfoState();
	let gitInfo = emptyGitInfoState();
	let requestRender: (() => void) | undefined;

	const stopModelListener = pi.events.on(MODEL_INFO_CHANNEL, (value) => {
		if (!isModelInfoState(value)) return;
		modelInfo = value;
		requestRender?.();
	});
	const stopGitListener = pi.events.on(GIT_INFO_CHANNEL, (value) => {
		if (!isGitInfoState(value)) return;
		gitInfo = value;
		requestRender?.();
	});

	function install(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
			requestRender = () => tui.requestRender();
			return {
				invalidate() {},
				render(width: number) {
					const directory = theme.fg("text", formatDirectory(ctx.cwd));
					const fileLabel = gitInfo.changedFiles === 1 ? "file" : "files";
					let git = !gitInfo.isRepository
						? theme.fg("muted", "No Git repository detected")
						: gitInfo.branch
							? theme.fg("text", sanitizeTerminalLabel(gitInfo.branch)) +
								theme.fg("muted", ` · ${gitInfo.changedFiles} ${fileLabel} changed`)
							: "";
					if (gitInfo.pullRequest) {
						const prLabel = `PR #${gitInfo.pullRequest.number}`;
						const linkedPr = getCapabilities().hyperlinks
							? hyperlink(prLabel, gitInfo.pullRequest.url)
							: prLabel;
						git += theme.fg("muted", " · ") + theme.fg("text", linkedPr);
					}

					const contextPercent =
						modelInfo.contextPercent === null ? "?" : `${Math.round(modelInfo.contextPercent)}`;
					const contextWindow =
						modelInfo.contextWindow > 0 ? formatTokens(modelInfo.contextWindow) : "?";
					const tps =
						modelInfo.tokensPerSecond === null
							? "— tok/s"
							: `${Math.round(modelInfo.tokensPerSecond)} tok/s`;
					const usage = `${contextPercent}%/${contextWindow} · $${modelInfo.cost.toFixed(2)} · ${tps}`;
					const modelIdentity = modelInfo.provider
						? `${modelInfo.provider}/${modelInfo.modelId}`
						: modelInfo.modelId;
					const model =
						theme.fg("text", modelIdentity) +
						theme.fg("muted", " · ") +
						theme.fg(thinkingColorToken(modelInfo.thinking), modelInfo.thinking);
					const separator = theme.fg("muted", " · ");
					const statuses = extensionStatusValues(footerData.getExtensionStatuses());
					const usageAndStatuses =
						theme.fg("muted", usage) + (statuses.length > 0 ? separator + statuses.join(separator) : "");
					return [
						columns(directory, model, width),
						columns(usageAndStatuses, git, width),
					];
				},
			};
		});

		ctx.ui.setTitle(`mepie · ${title}`);
	}

	pi.on("session_start", (_event, ctx) => {
		title = formatDirectory(ctx.cwd);
		modelInfo = emptyModelInfoState();
		gitInfo = emptyGitInfoState();
		install(ctx);
		// model-info's session handler runs before this UI handler. Request a fresh
		// snapshot after resetting the dashboard so the footer does not stay on
		// the empty "no-model" state.
		pi.events.emit(REFRESH_CHANNEL, undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopModelListener();
		stopGitListener();
		requestRender = undefined;
		if (ctx.mode === "tui") {
			ctx.ui.setFooter(undefined);
		}
	});
}
