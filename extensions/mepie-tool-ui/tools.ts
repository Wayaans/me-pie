import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getLanguageFromPath,
	highlightCode,
	keyText,
	renderDiff,
	type BashToolDetails,
	type EditToolDetails,
	type EditToolInput,
	type ExtensionAPI,
	type FindToolDetails,
	type FindToolInput,
	type GrepToolDetails,
	type GrepToolInput,
	type LsToolDetails,
	type LsToolInput,
	type ReadToolDetails,
	type ReadToolInput,
	type Theme,
	type ToolDefinition,
	type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { Type, type Static, type TSchema } from "typebox";
import {
	countLines,
	resultText,
	returnedLines,
	sanitizeInline,
	searchTarget,
	textContent,
	withMepieToolUi,
	type SummaryPart,
	type ToolView,
} from "./tool-renderer.ts";
import { TOOL_ICONS } from "./tool-icons.ts";
import type { ToolRenderMode } from "../mepie/tool-mode.ts";

const MepieBashParams = Type.Object({
	purpose: Type.Optional(Type.String({
		description: "Short human-readable title describing what the command does",
		minLength: 1,
		maxLength: 80,
	})),
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

type MepieBashInput = Static<typeof MepieBashParams>;

export function registerMepieToolUi(pi: ExtensionAPI, cwd: string, mode: ToolRenderMode = "compact"): void {
	function register<TParams extends TSchema, TDetails, TState>(
		definition: ToolDefinition<TParams, TDetails, TState>,
		view: ToolView<Static<TParams>, TDetails>,
	): void {
		if (mode === "builtin") pi.registerTool(definition);
		else pi.registerTool(withMepieToolUi(definition, view, mode));
	}
	register(createReadToolDefinition(cwd), readView);
	register(createMepieBashDefinition(cwd), bashView);
	register(createEditToolDefinition(cwd), editView);
	register(createWriteToolDefinition(cwd), writeView);
	register(createGrepToolDefinition(cwd), grepView);
	register(createFindToolDefinition(cwd), findView);
	register(createLsToolDefinition(cwd), listView);
}

function createMepieBashDefinition(
	cwd: string,
): ToolDefinition<typeof MepieBashParams, BashToolDetails | undefined> {
	const definition = createBashToolDefinition(cwd);
	return {
		...definition,
		description: `${definition.description} Optionally set purpose to a short title describing the command.`,
		parameters: MepieBashParams,
		execute(toolCallId, args, signal, onUpdate, context) {
			return definition.execute(toolCallId, args, signal, onUpdate, context);
		},
	};
}

const readView: ToolView<ReadToolInput, ReadToolDetails | undefined> = {
	icon: TOOL_ICONS.read,
	label: "Read",
	compactCall(args, cwd, theme, nameColor) {
		const name = args.path === undefined ? undefined : skillName(args.path, cwd);
		if (!name) return undefined;
		const label = theme.fg("toolTitle", "󰚩");
		const hint = theme.fg("muted", ` (${keyText("app.tools.expand")} to expand)`);
		return new Text(`${label} ${theme.fg(nameColor, sanitizeInline(name))}${hint}`, 0, 0);
	},
	target: (args, cwd) => displayPath(args.path, cwd),
	summary(args, result) {
		if (result.content.some((item) => item.type === "image")) return [{ text: "image" }];
		const text = textContent(result);
		const lineCount = result.details?.truncation?.outputLines ?? returnedLines(text).length;
		const parts: SummaryPart[] = [];
		if (args.offset !== undefined || args.limit !== undefined) {
			const start = args.offset ?? 1;
			const end = Math.max(start, start + lineCount - 1);
			parts.push({ text: start === end ? `L${start}` : `L${start}–${end}` });
		} else {
			parts.push({ text: `${lineCount} ${plural(lineCount, "line")}` });
		}
		if (result.details?.truncation?.truncated) parts.push({ text: "truncated", color: "warning" });
		return parts;
	},
	expanded(args, result, theme) {
		const text = textContent(result);
		if (!text) return new Container();
		return numberedCode(text, args.path, args.offset ?? 1, theme);
	},
};

const bashView: ToolView<MepieBashInput, BashToolDetails | undefined> = {
	icon: TOOL_ICONS.terminal,
	label: "Bash",
	targetColor: "text",
	targetTruncation: "end",
	target(args, _cwd, argsComplete) {
		const purpose = args.purpose?.trim() || (argsComplete ? "Run shell command" : "");
		return purpose ? `· ${purpose}` : "";
	},
	summary(_args, result) {
		return result.details?.truncation?.truncated
			? [{ text: "output truncated", color: "warning" }]
			: [];
	},
	collapsed(args, _result, theme) {
		return new BashScriptTree(args.command, false, theme);
	},
	expanded(args, result, theme) {
		const component = new Container();
		component.addChild(new BashScriptTree(args.command, true, theme));
		const text = textContent(result);
		if (text && text.trim() !== "(no output)") {
			component.addChild(new Text(`\n${theme.fg("toolOutput", text)}`, 0, 0));
		}
		if (result.details?.fullOutputPath) {
			component.addChild(new Text(`\n${theme.fg("dim", `Full output: ${result.details.fullOutputPath}`)}`, 0, 0));
		}
		return component;
	},
};

const editView: ToolView<EditToolInput, EditToolDetails | undefined> = {
	icon: TOOL_ICONS.edit,
	label: "Edit",
	target: (args, cwd) => displayPath(args.path, cwd),
	summary(_args, result) {
		if (!result.details?.diff) return [{ text: "no changes" }];
		const { additions, removals } = diffStats(result.details.diff);
		return [
			{ text: `+${additions}`, color: "toolDiffAdded" },
			{ text: `−${removals}`, color: "toolDiffRemoved", separator: "space" },
		];
	},
	expanded(args, result, theme) {
		if (result.details?.diff) return new Text(renderDiff(result.details.diff, { filePath: args.path }), 0, 0);
		return resultText(result, theme);
	},
};

const writeView: ToolView<WriteToolInput, undefined> = {
	icon: TOOL_ICONS.write,
	label: "Write",
	target: (args, cwd) => displayPath(args.path, cwd),
	summary(args) {
		const lineCount = countLines(args.content);
		return [
			{ text: `${lineCount} ${plural(lineCount, "line")}` },
			{ text: formatBytes(Buffer.byteLength(args.content, "utf8")) },
		];
	},
	expanded(args, _result, theme) {
		return numberedCode(args.content, args.path, 1, theme);
	},
};

const grepView: ToolView<GrepToolInput, GrepToolDetails | undefined> = {
	icon: TOOL_ICONS.search,
	label: "Grep",
	targetTruncation: "end",
	target: (args, cwd, argsComplete) => searchTarget(
		args.pattern === undefined ? undefined : `/${args.pattern}/`,
		displayPath(args.path ?? (argsComplete ? "." : undefined), cwd),
	),
	summary(args, result) {
		const parts: SummaryPart[] = [];
		if (args.glob) parts.push({ text: args.glob, color: "muted" });
		const matches = grepMatchCount(textContent(result));
		parts.push({ text: `${matches} ${plural(matches, "result")}` });
		if (result.details?.matchLimitReached !== undefined) parts.push({ text: "limit reached", color: "warning" });
		if (result.details?.truncation?.truncated || result.details?.linesTruncated) {
			parts.push({ text: "truncated", color: "warning" });
		}
		return parts;
	},
	expanded(_args, result, theme) {
		return resultText(result, theme);
	},
};

const findView: ToolView<FindToolInput, FindToolDetails | undefined> = {
	icon: TOOL_ICONS.files,
	label: "Find",
	targetTruncation: "end",
	target: (args, cwd, argsComplete) => searchTarget(
		args.pattern,
		displayPath(args.path ?? (argsComplete ? "." : undefined), cwd),
	),
	summary(_args, result) {
		const text = textContent(result);
		const fileCount = text.trim() === "No files found matching pattern"
			? 0
			: returnedLines(text).filter(Boolean).length;
		const parts: SummaryPart[] = [{ text: `${fileCount} ${plural(fileCount, "file")}` }];
		if (result.details?.resultLimitReached !== undefined) parts.push({ text: "limit reached", color: "warning" });
		if (result.details?.truncation?.truncated) parts.push({ text: "truncated", color: "warning" });
		return parts;
	},
	expanded(_args, result, theme) {
		return resultText(result, theme);
	},
};

const listView: ToolView<LsToolInput, LsToolDetails | undefined> = {
	icon: TOOL_ICONS.list,
	label: "List",
	target: (args, cwd, argsComplete) => displayPath(args.path ?? (argsComplete ? "." : undefined), cwd),
	summary(_args, result) {
		const text = textContent(result);
		const entryCount = text.trim() === "(empty directory)"
			? 0
			: returnedLines(text).filter(Boolean).length;
		const parts: SummaryPart[] = [{ text: `${entryCount} ${plural(entryCount, "entry", "entries")}` }];
		if (result.details?.entryLimitReached !== undefined) parts.push({ text: "limit reached", color: "warning" });
		if (result.details?.truncation?.truncated) parts.push({ text: "truncated", color: "warning" });
		return parts;
	},
	expanded(_args, result, theme) {
		return resultText(result, theme);
	},
};

class BashScriptTree implements Component {
	constructor(
		private readonly script: string,
		private readonly expanded: boolean,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const lines = scriptLines(this.script);
		if (lines.length === 0) return [];
		const displayLines = this.expanded
			? highlightCode(lines.join("\n"), "bash")
			: lines.map((line) => this.theme.fg("muted", line));
		const visibleCount = this.expanded ? lines.length : Math.min(2, lines.length);
		const rendered: string[] = [];

		for (let index = 0; index < visibleCount; index += 1) {
			const isLast = index === lines.length - 1;
			const prefix = this.theme.fg("dim", isLast ? "╰─ " : "├─ ");
			const continuation = this.theme.fg("dim", isLast ? "   " : "│  ");
			const content = displayLines[index] ?? lines[index] ?? "";
			rendered.push(...renderScriptLine(content.replaceAll("\t", "   "), prefix, continuation, width, this.expanded));
		}

		const omitted = lines.length - visibleCount;
		if (omitted > 0) {
			const message = this.theme.fg("dim", `╰─ … ${omitted} more ${plural(omitted, "line")}`);
			rendered.push(truncateToWidth(message, width, "…"));
		}
		return rendered;
	}

	invalidate(): void {}
}

function renderScriptLine(
	content: string,
	prefix: string,
	continuation: string,
	width: number,
	expanded: boolean,
): string[] {
	const prefixWidth = visibleWidth(prefix);
	if (width <= prefixWidth) return [truncateToWidth(prefix, width, "")];
	const contentWidth = width - prefixWidth;
	if (!expanded) return [`${prefix}${truncateToWidth(content, contentWidth, "…")}`];
	return wrapTextWithAnsi(content, contentWidth)
		.map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
}

function scriptLines(script: string): string[] {
	if (script.length === 0) return [];
	const lines = script.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

function skillName(path: string, cwd: string): string | undefined {
	const normalizedPath = path.startsWith("@") ? path.slice(1) : path;
	const absolutePath = isAbsolute(normalizedPath) ? normalizedPath : resolve(cwd, normalizedPath);
	if (basename(absolutePath) !== "SKILL.md") return undefined;
	return basename(dirname(absolutePath)) || "SKILL.md";
}

function displayPath(path: string | undefined, cwd: string): string {
	if (path === undefined) return "";
	if (!isAbsolute(path)) return path || ".";
	const home = homedir();
	if (path === home) return "~";
	if (path.startsWith(`${cwd}/`)) return relative(cwd, path);
	if (path.startsWith(`${home}/`)) return `~/${relative(home, path)}`;
	return path;
}

function numberedCode(text: string, path: string, firstLine: number, theme: Theme): Text {
	const language = getLanguageFromPath(path);
	const lines = highlightCode(text, language);
	const lastLine = firstLine + lines.length - 1;
	const numberWidth = `${lastLine}`.length;
	const numbered = lines
		.map((line, index) => `${theme.fg("dim", `${firstLine + index}`.padStart(numberWidth))}  ${line}`)
		.join("\n");
	return new Text(numbered, 0, 0);
}

function diffStats(diff: string): { readonly additions: number; readonly removals: number } {
	let additions = 0;
	let removals = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
		if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
	}
	return { additions, removals };
}

function grepMatchCount(text: string): number {
	return returnedLines(text).filter((line) => /^.+:\d+:/.test(line)).length;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return count === 1 ? singular : pluralForm;
}

function formatBytes(bytes: number): string {
	if (bytes < 1_000) return `${bytes} B`;
	if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
	return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
