import type {
	AgentToolResult,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import type { WaitResult } from "./coordinator.ts";
import type { WorkerReport } from "./model.ts";

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const PROGRESS_INTERVAL_MS = 160;

export interface TicketflowProgressDetails {
	readonly ticketflowUi: {
		readonly label: string;
		readonly elapsedMs: number;
		readonly frame: number;
	};
}

interface TicketflowRenderContext {
	readonly isError: boolean;
}

interface TicketflowFinalView {
	readonly label: string;
	readonly meta?: string;
	readonly markdown?: string;
	readonly tone?: "success" | "warning";
}

type TicketflowUpdate = (partial: AgentToolResult<TicketflowProgressDetails>) => void;

function textContent(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function progressDetails(details: unknown): TicketflowProgressDetails["ticketflowUi"] | undefined {
	if (!details || typeof details !== "object" || !("ticketflowUi" in details)) return undefined;
	const candidate = details.ticketflowUi;
	if (!candidate || typeof candidate !== "object") return undefined;
	if (!("label" in candidate) || typeof candidate.label !== "string") return undefined;
	if (!("elapsedMs" in candidate) || typeof candidate.elapsedMs !== "number") return undefined;
	if (!("frame" in candidate) || typeof candidate.frame !== "number") return undefined;
	return candidate as TicketflowProgressDetails["ticketflowUi"];
}

export function formatElapsed(elapsedMs: number): string {
	const seconds = Math.max(0, elapsedMs) / 1_000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${Math.floor(seconds % 60).toString().padStart(2, "0")}s`;
}

export async function runWithTicketflowProgress<A>(
	label: string,
	onUpdate: TicketflowUpdate | undefined,
	work: () => Promise<A>,
): Promise<{ readonly value: A; readonly elapsedMs: number }> {
	const startedAt = Date.now();
	let frame = 0;
	const publish = (): void => {
		const elapsedMs = Date.now() - startedAt;
		onUpdate?.({
			content: [{ type: "text", text: `${label} · ${formatElapsed(elapsedMs)}` }],
			details: { ticketflowUi: { label, elapsedMs, frame } },
		});
		frame = (frame + 1) % SPINNER_FRAMES.length;
	};
	publish();
	const timer = onUpdate ? setInterval(publish, PROGRESS_INTERVAL_MS) : undefined;
	timer?.unref();
	try {
		return { value: await work(), elapsedMs: Date.now() - startedAt };
	} finally {
		if (timer) clearInterval(timer);
	}
}

export function renderTicketflowCall(icon: string, label: string, meta: string | undefined, theme: Theme): Component {
	let text = theme.fg("toolTitle", theme.bold(`${icon} ${label}`));
	if (meta) text += theme.fg("muted", ` · ${meta}`);
	return new Text(text, 0, 0);
}

export function renderTicketflowResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: TicketflowRenderContext,
	view: TicketflowFinalView,
): Component {
	if (options.isPartial) {
		const progress = progressDetails(result.details);
		const frame = SPINNER_FRAMES[(progress?.frame ?? 0) % SPINNER_FRAMES.length]!;
		const label = progress?.label ?? "Working";
		const elapsed = formatElapsed(progress?.elapsedMs ?? 0);
		return new Text(`${theme.fg("accent", frame)} ${theme.fg("muted", `${label} · ${elapsed}`)}`, 0, 0);
	}
	if (context.isError) {
		const message = textContent(result).trim();
		const component = new Container();
		component.addChild(new Text(theme.fg("error", `${theme.bold("✕ Failed")}${message ? ` · ${message}` : ""}`), 0, 0));
		return component;
	}

	const tone = view.tone ?? "success";
	const icon = tone === "warning" ? "!" : "✓";
	const component = new Container();
	let status = theme.fg(tone, theme.bold(`${icon} ${view.label}`));
	if (view.meta) status += theme.fg("muted", ` · ${view.meta}`);
	component.addChild(new Text(status, 0, 0));
	if (view.markdown?.trim()) {
		component.addChild(new Spacer(1));
		component.addChild(new Markdown(view.markdown, 0, 0, getMarkdownTheme(), {
			color: (text) => theme.fg("toolOutput", text),
		}));
	}
	return component;
}

function inlineCode(value: string): string {
	return `\`${value.replaceAll("`", "\\`")}\``;
}

function reportTitle(report: WorkerReport): string {
	if (report.status === "completed") return "✓ Completed";
	if (report.status === "blocked") return "! Blocked";
	if (report.status === "failed") return "✕ Failed";
	return "◇ Audit";
}

export function formatWorkerReportMarkdown(report: WorkerReport): string {
	const lines = [`### ${reportTitle(report)}`, "", report.summary.trim()];
	if (report.status === "completed") {
		lines.push("", "**Commits**", "", ...report.commitIds.map((commitId) => `- ${inlineCode(commitId)}`));
	} else if (report.status === "blocked") {
		lines.push("", "**Questions**", "", ...report.questions.map((question, index) => `${index + 1}. ${question}`));
	} else if (report.status === "audit") {
		lines.push("", "**Audited commits**", "");
		lines.push(...(report.auditedCommitIds.length > 0 ? report.auditedCommitIds.map((commitId) => `- ${inlineCode(commitId)}`) : ["- None"]));
		lines.push("", "**Verdicts**", "");
		for (const verdict of report.verdicts) {
			const icon = verdict.verdict === "pass" ? "✓" : verdict.verdict === "fail" ? "✕" : "–";
			lines.push(`- ${icon} **${verdict.requirement}** — ${verdict.evidence}`);
			for (const fix of verdict.fixes ?? []) lines.push(`  - Fix: ${fix}`);
		}
		lines.push("", "**Findings**", "");
		if (report.findings.length === 0) lines.push("- None");
		for (const finding of report.findings) {
			lines.push(`- **${finding.severity.toUpperCase()} · ${finding.id}** — ${finding.finding}`);
			lines.push(`  - Evidence: ${finding.evidence}`);
			if (finding.requirement) lines.push(`  - Requirement: ${finding.requirement}`);
			if (finding.fix) lines.push(`  - Fix: ${finding.fix}`);
		}
	}
	return lines.join("\n");
}

export function formatWaitResultMarkdown(result: WaitResult): string {
	if (result.status === "unreported" || !result.report) {
		return "### ! No report\n\nThe Worker settled without a durable report.";
	}
	return formatWorkerReportMarkdown(result.report);
}
