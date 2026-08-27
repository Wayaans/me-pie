import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	formatSize,
	isToolCallEventType,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { Type } from "typebox";
import {
	findDocumentation,
	type FindDocsInput,
	type FindDocsOutcome,
} from "./context7.ts";
import {
	formatFindDocsSummary,
	formatFindDocsTarget,
	isCtx7Bash,
	type FindDocsDetails,
} from "./utils.ts";

const FindDocsParams = Type.Object({
	query: Type.String({
		description: "Documentation question or search query",
		minLength: 1,
		maxLength: 500,
	}),
	library: Type.Optional(Type.String({
		description: "Library, framework, SDK, or CLI name, for example react, nextjs, or prisma",
		minLength: 1,
		maxLength: 500,
	})),
	libraryId: Type.Optional(Type.String({
		description: "Context7 library ID in /owner/project or /owner/project/version form",
		minLength: 3,
		maxLength: 500,
	})),
});

function renderTextResult(result: { content: Array<{ type: string; text?: string }> }) {
	const text = result.content.find((content) => content.type === "text");
	return new Text(text?.type === "text" ? (text.text ?? "") : "", 0, 0);
}

function outcomeText(outcome: FindDocsOutcome): string {
	switch (outcome.status) {
		case "found":
			return `${outcome.resolvedLibrary ? "Resolved library" : "Library"}: ${outcome.libraryId}\n\n${outcome.docs}`;
		case "library-not-found":
			return `No Context7 library found for: ${outcome.library}`;
		case "docs-not-found":
			return `No Context7 documentation found for "${outcome.query}" in ${outcome.libraryId}.`;
	}
}

function outcomeDetails(outcome: FindDocsOutcome): FindDocsDetails {
	return {
		status: outcome.status,
		query: outcome.query,
		...(outcome.library ? { library: outcome.library } : {}),
		...("libraryId" in outcome ? { libraryId: outcome.libraryId } : {}),
	};
}

async function makeTextToolResult(
	text: string,
	details: FindDocsDetails,
	temporaryDirectories: Set<string>,
) {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) {
		return {
			content: [{ type: "text" as const, text: truncation.content || "No output" }],
			details,
		};
	}

	const tempDir = await mkdtemp(path.join(tmpdir(), "find-docs-"));
	const tempFile = path.join(tempDir, "output.txt");
	try {
		await writeFile(tempFile, text, { encoding: "utf8", mode: 0o600 });
		temporaryDirectories.add(tempDir);
	} catch (error) {
		await rm(tempDir, { recursive: true, force: true });
		throw error;
	}

	const resultText = `${truncation.content}\n\n[Output truncated to ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tempFile}]`;
	return {
		content: [{ type: "text" as const, text: resultText }],
		details: {
			...details,
			truncated: true,
			fullOutputPath: tempFile,
		},
	};
}

async function removeTemporaryDirectories(temporaryDirectories: Set<string>): Promise<void> {
	const directories = [...temporaryDirectories];
	temporaryDirectories.clear();
	await Promise.allSettled(directories.map((directory) => rm(directory, { recursive: true, force: true })));
}

const findDocsTool = (pi: ExtensionAPI, temporaryDirectories: Set<string>) =>
	defineTool({
		name: "find_docs",
		label: "Find Docs",
		description:
			"Find current documentation for a library, framework, SDK, or CLI with Context7. Resolves a library name before querying docs. Output is limited to 50 KB or 2,000 lines.",
		promptSnippet: "Find current framework and library documentation through Context7",
		promptGuidelines: [
			"Use find_docs whenever a task depends on current library, framework, SDK, or CLI documentation.",
		],
		parameters: FindDocsParams,

		async execute(_toolCallId, params, signal) {
			const input: FindDocsInput = params;
			const workflow = findDocumentation(
				input,
				(command, args, options) => pi.exec(command, args, options),
			).pipe(
				Effect.mapError((error) => new Error(error.message, { cause: error })),
			);
			const outcome = await Effect.runPromise(workflow, { signal });
			return makeTextToolResult(outcomeText(outcome), outcomeDetails(outcome), temporaryDirectories);
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
	const temporaryDirectories = new Set<string>();
	pi.registerTool(findDocsTool(pi, temporaryDirectories));

	pi.on("session_shutdown", async () => {
		await removeTemporaryDirectories(temporaryDirectories);
	});

	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return;
		if (!isCtx7Bash(event.input.command)) return;
		if (!pi.getActiveTools().includes("find_docs")) return;

		return {
			block: true,
			reason: "Use the find_docs tool instead of bash for Context7 documentation lookups.",
		};
	});
}
