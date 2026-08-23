import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
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
	renderDiff,
	type BashToolDetails,
	type BashToolInput,
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
	type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
	countLines,
	resultText,
	returnedLines,
	textContent,
	withMepieToolUi,
	type SummaryPart,
	type ToolView,
} from "./tool-renderer.ts";

export function registerMepieToolUi(pi: ExtensionAPI, cwd: string): void {
	pi.registerTool(withMepieToolUi(createReadToolDefinition(cwd), readView));
	pi.registerTool(withMepieToolUi(createBashToolDefinition(cwd), bashView));
	pi.registerTool(withMepieToolUi(createEditToolDefinition(cwd), editView));
	pi.registerTool(withMepieToolUi(createWriteToolDefinition(cwd), writeView));
	pi.registerTool(withMepieToolUi(createGrepToolDefinition(cwd), grepView));
	pi.registerTool(withMepieToolUi(createFindToolDefinition(cwd), findView));
	pi.registerTool(withMepieToolUi(createLsToolDefinition(cwd), listView));
}

const readView: ToolView<ReadToolInput, ReadToolDetails | undefined> = {
	label: "Read",
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

const bashView: ToolView<BashToolInput, BashToolDetails | undefined> = {
	label: "Bash",
	targetTruncation: "end",
	target: (args) => firstScriptLine(args.command),
	summary(_args, result) {
		const text = textContent(result);
		const hasOutput = text.trim() !== "" && text.trim() !== "(no output)";
		const lineCount = hasOutput
			? result.details?.truncation?.outputLines ?? outputLineCount(text)
			: 0;
		const parts: SummaryPart[] = [
			{ text: hasOutput ? `${lineCount} ${plural(lineCount, "line")}` : "no output" },
		];
		if (result.details?.truncation?.truncated) parts.push({ text: "truncated", color: "warning" });
		return parts;
	},
	expanded(_args, result, theme) {
		const component = new Container();
		const text = textContent(result);
		if (text && text.trim() !== "(no output)") {
			component.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
		}
		if (result.details?.fullOutputPath) {
			component.addChild(new Text(theme.fg("dim", `Full output: ${result.details.fullOutputPath}`), 0, 0));
		}
		return component;
	},
};

const editView: ToolView<EditToolInput, EditToolDetails | undefined> = {
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
	label: "Grep",
	targetTruncation: "end",
	target: (args, cwd) => `/${args.pattern}/ in ${displayPath(args.path ?? ".", cwd)}`,
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
	label: "Find",
	targetTruncation: "end",
	target: (args, cwd) => `${args.pattern} in ${displayPath(args.path ?? ".", cwd)}`,
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
	label: "List",
	target: (args, cwd) => displayPath(args.path ?? ".", cwd),
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

function displayPath(path: string, cwd: string): string {
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

function firstScriptLine(script: string): string {
	return script.split(/\r\n?|\n/, 1)[0] ?? "";
}

function outputLineCount(text: string): number {
	if (!text) return 0;
	const withoutFinalNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
	return countLines(withoutFinalNewline);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return count === 1 ? singular : pluralForm;
}

function formatBytes(bytes: number): string {
	if (bytes < 1_000) return `${bytes} B`;
	if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
	return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
