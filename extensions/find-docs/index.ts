import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	formatSize,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_CTX7_TIMEOUT_MS = 60_000;

const FindDocsParams = Type.Object({
	query: Type.String({ description: "Documentation question or search query" }),
	library: Type.Optional(Type.String({ description: "Library/framework/package name, e.g. react, nextjs, prisma" })),
	libraryId: Type.Optional(Type.String({ description: "Optional Context7 library ID like /facebook/react" })),
});

type FindDocsToolParams = {
	query: string;
	library?: string;
	libraryId?: string;
};

import {
	extractContext7LibraryId,
	formatFindDocsSummary,
	formatFindDocsTarget,
	isCtx7Bash,
	type FindDocsDetails,
} from "./utils.ts";

function renderTextResult(result: { content: Array<{ type: string; text?: string }> }) {
	const text = result.content.find((content) => content.type === "text");
	return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
}

async function makeTextToolResult(text: string, details: Record<string, unknown>) {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	const resultDetails: Record<string, unknown> = { ...details };
	let resultText = truncation.content;

	if (truncation.truncated) {
		const tempDir = await mkdtemp(path.join(tmpdir(), "find-docs-"));
		const tempFile = path.join(tempDir, "output.txt");
		await withFileMutationQueue(tempFile, async () => {
			await writeFile(tempFile, text, "utf8");
		});
		resultDetails.truncation = truncation;
		resultDetails.fullOutputPath = tempFile;
		resultText += `\n\n[Output truncated to ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tempFile}]`;
	}

	return {
		content: [{ type: "text" as const, text: resultText || "No output" }],
		details: resultDetails,
	};
}

async function runCtx7(pi: ExtensionAPI, args: string[], signal?: AbortSignal): Promise<string> {
	try {
		const direct = await pi.exec("ctx7", args, {
			...(signal ? { signal } : {}),
			timeout: DEFAULT_CTX7_TIMEOUT_MS,
		});
		if (direct.code === 0 && direct.stdout.trim()) {
			return direct.stdout.trim();
		}
	} catch {
		// Fall through to bunx when ctx7 is not installed.
	}

	const fallback = await pi.exec("bunx", ["--bun", "ctx7@latest", ...args], {
		...(signal ? { signal } : {}),
		timeout: DEFAULT_CTX7_TIMEOUT_MS * 2,
	});
	const output = [fallback.stdout, fallback.stderr].filter(Boolean).join("\n").trim();
	if (fallback.code !== 0) {
		if (/quota|monthly quota reached|quota exceeded/i.test(output)) {
			throw new Error(`Context7 quota exhausted. Run ctx7 login for higher limits.\n\n${output}`);
		}
		throw new Error(output || "ctx7 command failed");
	}
	return output;
}

const findDocsTool = (pi: ExtensionAPI) =>
	defineTool({
		name: "find_docs",
		label: "find_docs",
		description:
			"Find current documentation for a framework or library using Context7 (ctx7). Resolves the library ID first, then fetches relevant docs.",
		promptSnippet: "Find current framework and library documentation through Context7",
		promptGuidelines: [
			"Use find_docs whenever a task depends on current library, framework, SDK, or CLI documentation.",
		],
		parameters: FindDocsParams,

		async execute(_toolCallId, params, signal) {
			return Effect.runPromise(
				Effect.tryPromise({
					try: async () => {
						const input = params as FindDocsToolParams;
						const libraryId = input.libraryId?.trim();
						let resolvedLibraryId = libraryId?.startsWith("/") ? libraryId : undefined;
						let libraryOutput = "";

						if (!resolvedLibraryId) {
							if (!input.library) throw new Error("find_docs requires either library or libraryId");
							libraryOutput = await runCtx7(pi, ["library", input.library, input.query], signal);
							resolvedLibraryId = extractContext7LibraryId(libraryOutput);
							if (!resolvedLibraryId) {
								return makeTextToolResult(libraryOutput || "No matching Context7 library found", {
									library: input.library,
									query: input.query,
									resolved: false,
								});
							}
						}

						const docsOutput = await runCtx7(pi, ["docs", resolvedLibraryId, input.query], signal);
						const text = libraryOutput
							? `Resolved library: ${resolvedLibraryId}\n\n${docsOutput}`
							: `Library: ${resolvedLibraryId}\n\n${docsOutput}`;
						return makeTextToolResult(text, {
							library: input.library,
							libraryId: resolvedLibraryId,
							query: input.query,
						});
					},
					catch: (error) => error instanceof Error ? error : new Error(String(error)),
				}),
				{ signal },
			);
		},

		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("find_docs"))} ${theme.fg("accent", formatFindDocsTarget(args))}`,
				0,
				0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as FindDocsDetails | undefined;
			const summary = formatFindDocsSummary(details);
			if (!options.expanded) {
				return new Text(summary ? theme.fg("dim", `↳ ${summary}`) : "", 0, 0);
			}
			return renderTextResult(result);
		},
	});

export default function (pi: ExtensionAPI): void {
	pi.registerTool(findDocsTool(pi));

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;
		const command = String(event.input.command ?? "").trim();
		if (!isCtx7Bash(command)) return;

		const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
		if (!availableTools.has("find_docs")) return;

		return {
			block: true,
			reason: "Use the find_docs tool instead of bash for Context7 documentation lookups.",
		};
	});
}
