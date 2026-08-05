import { createHash } from "node:crypto";
import { lstat, realpath, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { parseDocument } from "yaml";
import type { CompletionStrategy } from "./domain.ts";
export type { CompletionStrategy } from "./domain.ts";

/** Narrow filesystem boundary used by completion tests and by the controller. */
export interface CompletionFileSystem {
	readonly realpath: (filePath: string, signal?: AbortSignal) => Promise<string>;
	readonly readFile: (filePath: string, signal?: AbortSignal) => Promise<string>;
	readonly writeFile: (filePath: string, content: string, signal?: AbortSignal) => Promise<void>;
	readonly rename: (from: string, to: string, signal?: AbortSignal) => Promise<void>;
	readonly stat: (filePath: string, signal?: AbortSignal) => Promise<{ readonly isFile: () => boolean; readonly dev?: number; readonly ino?: number; readonly nlink?: number }>;
	/** Optional lstat lets tests and alternate filesystems reject symlink races. */
	readonly lstat?: (filePath: string, signal?: AbortSignal) => Promise<{ readonly isSymbolicLink: () => boolean }>;
	readonly remove?: (filePath: string, signal?: AbortSignal) => Promise<void>;
}

function throwIfAborted(...signals: readonly (AbortSignal | undefined)[]): void {
	const signal = signals.find((candidate) => candidate?.aborted);
	if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

export const nodeCompletionFileSystem: CompletionFileSystem = {
	realpath: async (filePath, signal) => { throwIfAborted(signal); const value = await realpath(filePath); throwIfAborted(signal); return value; },
	readFile: (filePath, signal) => readFile(filePath, { encoding: "utf8", signal }),
	writeFile: (filePath, content, signal) => writeFile(filePath, content, { encoding: "utf8", signal }),
	rename: async (from, to, signal) => { throwIfAborted(signal); await rename(from, to); throwIfAborted(signal); },
	stat: async (filePath, signal) => { throwIfAborted(signal); const value = await stat(filePath); throwIfAborted(signal); return value; },
	lstat: async (filePath, signal) => { throwIfAborted(signal); const value = await lstat(filePath); throwIfAborted(signal); return value; },
	remove: async (filePath, signal) => { throwIfAborted(signal); await rm(filePath, { force: true }); },
};

export interface CompletionApplicationInput {
	readonly projectPath: string;
	readonly runId: string;
	readonly workItemId: string;
	readonly workItemTitle: string;
	readonly comment: string;
	readonly completedAt: string;
	readonly strategy: CompletionStrategy;
	/** Plan-approved mutation paths. Omitted only for low-level standalone use. */
	readonly allowedPaths?: readonly string[];
}

export interface CompletionApplicationResult {
	readonly strategy: CompletionStrategy["type"];
	readonly changed: boolean;
	readonly paths: readonly string[];
}

export class CompletionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CompletionError";
	}
}

function withinProject(projectPath: string, candidate: string): boolean {
	const relative = path.relative(projectPath, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRepositoryControlPath(projectPath: string, candidate: string): boolean {
	if (!withinProject(projectPath, candidate)) return true;
	const relative = path.relative(projectPath, candidate);
	return relative.split(path.sep).some((part) => part === ".git" || part.startsWith(".git"));
}

function normalizedRelative(projectPath: string, candidate: string): string {
	return path.relative(projectPath, candidate).split(path.sep).join("/");
}

export function completionStrategyPaths(strategy: CompletionStrategy): readonly string[] {
	switch (strategy.type) {
		case "ledger-only": return [];
		case "append-markdown":
		case "append":
		case "text-replacement":
		case "markdown-checkbox":
		case "frontmatter": return [strategy.path];
		case "rename-file":
		case "move-file": return [strategy.from, strategy.to];
	}
}

function missing(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT");
}

/**
 * Resolve an explicit plan path against the canonical project and reject both
 * traversal and symlinks which leave the trusted checkout. Missing destination
 * paths are allowed for rename/move targets, but their existing parent is
 * still canonicalized and checked.
 */
async function assertNoSymlinkComponents(projectPath: string, candidate: string, fs: CompletionFileSystem, signal?: AbortSignal): Promise<void> {
	if (!fs.lstat) return;
	const relative = path.relative(projectPath, candidate);
	let current = projectPath;
	for (const part of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		try {
			const identity = await fs.lstat(current, signal);
			if (identity.isSymbolicLink()) throw new CompletionError(`Completion path contains a symlink and cannot be mutated: ${normalizedRelative(projectPath, candidate)}`);
		} catch (error) {
			if (error instanceof CompletionError) throw error;
			if (!missing(error)) throw error;
			break;
		}
	}
}

async function trustedPath(
	projectPath: string,
	requested: string,
	allowMissing: boolean,
	fs: CompletionFileSystem,
	signal?: AbortSignal,
): Promise<string> {
	if (!requested.trim() || requested.includes("\0") || /[\r\n]/.test(requested)) throw new CompletionError("Completion paths must be non-empty and control-free.");
	throwIfAborted(signal);
	const project = await fs.realpath(projectPath, signal);
	throwIfAborted(signal);
	const candidate = path.resolve(project, requested);
	if (!withinProject(project, candidate) || isRepositoryControlPath(project, candidate)) throw new CompletionError(`Completion path escapes the trusted project or targets repository control data: ${requested}`);
	await assertNoSymlinkComponents(project, candidate, fs, signal);
	try {
		const canonical = await fs.realpath(candidate, signal);
		throwIfAborted(signal);
		if (!withinProject(project, canonical)) throw new CompletionError(`Completion path resolves outside the trusted project: ${requested}`);
		return canonical;
	} catch (error) {
		throwIfAborted(signal);
		if (!allowMissing || !missing(error)) throw error;
		const missingParts: string[] = [];
		let current = candidate;
		while (true) {
			try {
				const parent = await fs.realpath(current, signal);
				throwIfAborted(signal);
				const resolved = path.join(parent, ...missingParts.reverse());
				if (!withinProject(project, resolved) || isRepositoryControlPath(project, resolved)) throw new CompletionError(`Completion path escapes the trusted project or targets repository control data: ${requested}`);
				await assertNoSymlinkComponents(project, resolved, fs, signal);
				return resolved;
			} catch (parentError) {
				if (!missing(parentError)) throw parentError;
				const parent = path.dirname(current);
				if (parent === current) throw parentError;
				missingParts.push(path.basename(current));
				current = parent;
			}
		}
	}
}

async function existsAsFile(filePath: string, fs: CompletionFileSystem, signal?: AbortSignal): Promise<boolean> {
	throwIfAborted(signal);
	try {
		const file = await fs.stat(filePath, signal);
		throwIfAborted(signal);
		return file.isFile();
	} catch (error) {
		throwIfAborted(signal);
		if (missing(error)) return false;
		throw error;
	}
}

type FileIdentity = { readonly dev?: number; readonly ino?: number; readonly nlink?: number };

async function mutationFileIdentity(filePath: string, fs: CompletionFileSystem, signal?: AbortSignal): Promise<FileIdentity> {
	throwIfAborted(signal);
	if (fs.lstat) {
		const link = await fs.lstat(filePath, signal);
		if (link.isSymbolicLink()) throw new CompletionError(`Completion target is a symlink and cannot be mutated: ${filePath}`);
	}
	const identity = await fs.stat(filePath, signal);
	if (!identity.isFile()) throw new CompletionError(`Completion target is not a regular file: ${filePath}`);
	if (identity.nlink !== undefined && identity.nlink > 1) throw new CompletionError(`Completion target has multiple hard links and cannot be safely mutated: ${filePath}`);
	const canonical = await fs.realpath(filePath, signal);
	if (canonical !== filePath) throw new CompletionError(`Completion target changed identity before mutation: ${filePath}`);
	return identity;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
	if (left.dev !== undefined && right.dev !== undefined && left.dev !== right.dev) return false;
	if (left.ino !== undefined && right.ino !== undefined && left.ino !== right.ino) return false;
	if (left.nlink !== undefined && right.nlink !== undefined && left.nlink !== right.nlink) return false;
	return true;
}

function safeMarkerPart(value: string): string {
	const readable = value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
	const identity = createHash("sha256").update(value).digest("hex").slice(0, 16);
	return `${readable}-${identity}`;
}

export function completionMarker(runId: string, workItemId: string): string {
	return `<!-- mepie-ticket-flow:completed:${safeMarkerPart(runId)}:${safeMarkerPart(workItemId)} -->`;
}

function escapeCompletionMarkdown(value: string): string {
	return value.replaceAll("<!--", "&lt;!--").replaceAll("-->", "--&gt;");
}

function hasCompletionMarker(content: string, marker: string): boolean {
	return content.split(/\r?\n/).some((line) => line === marker);
}

function markdownBlock(input: CompletionApplicationInput): string {
	const marker = completionMarker(input.runId, input.workItemId);
	const comment = escapeCompletionMarkdown(input.comment).split(/\r?\n/).map((line) => `> ${line}`).join("\n");
	return [
		marker,
		"",
		"## Ticket Flow completion",
		`- Work item: ${escapeCompletionMarkdown(input.workItemTitle)}`,
		`- Completed at: ${input.completedAt}`,
		"- Orchestrator comment:",
		comment,
		"",
		marker.replace("completed:", "completed-end:"),
	].join("\n");
}

export function formatCompletionMarkdown(input: CompletionApplicationInput): string {
	return markdownBlock(input);
}

async function mutateFile<T>(filePath: string, operation: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
	throwIfAborted(signal);
	return withFileMutationQueue(filePath, async () => {
		throwIfAborted(signal);
		return operation(signal);
	});
}

async function mutateTwoFiles<T>(first: string, second: string, operation: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
	const sorted = [first, second].sort((a, b) => a.localeCompare(b));
	const left = sorted[0]!;
	const right = sorted[1]!;
	return mutateFile(left, (nestedSignal) => mutateFile(right, operation, nestedSignal), signal);
}

async function atomicWriteText(filePath: string, content: string, fs: CompletionFileSystem, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
	let renamed = false;
	try {
		await fs.writeFile(temporaryPath, content, signal);
		throwIfAborted(signal);
		await fs.rename(temporaryPath, filePath, signal);
		renamed = true;
		throwIfAborted(signal);
	} finally {
		// Cleanup must run even after cancellation; do not pass the aborted signal.
		if (!renamed && fs.remove) await fs.remove(temporaryPath).catch(() => undefined);
	}
}

async function appendMarkdown(
	input: CompletionApplicationInput,
	filePath: string,
	fs: CompletionFileSystem,
	signal?: AbortSignal,
): Promise<CompletionApplicationResult> {
	if (!(await existsAsFile(filePath, fs, signal))) throw new CompletionError(`Completion target is not a file: ${filePath}`);
	const marker = completionMarker(input.runId, input.workItemId);
	return mutateFile(filePath, async (operationSignal) => {
		const before = await mutationFileIdentity(filePath, fs, operationSignal);
		const original = await fs.readFile(filePath, operationSignal);
		const afterRead = await mutationFileIdentity(filePath, fs, operationSignal);
		if (!sameFileIdentity(before, afterRead)) throw new CompletionError(`Completion target changed while it was being read: ${filePath}`);
		throwIfAborted(signal, operationSignal);
		if (hasCompletionMarker(original, marker)) return { strategy: "append-markdown", changed: false, paths: [filePath] };
		const separator = original.length === 0 ? "" : original.endsWith("\n") ? "\n" : "\n\n";
		const beforeWrite = await mutationFileIdentity(filePath, fs, operationSignal);
		if (!sameFileIdentity(before, beforeWrite)) throw new CompletionError(`Completion target changed before it was written: ${filePath}`);
		await atomicWriteText(filePath, `${original}${separator}${markdownBlock(input)}\n`, fs, operationSignal);
		return { strategy: "append-markdown", changed: true, paths: [filePath] };
	}, signal);
}

async function replaceExactText(
	input: CompletionApplicationInput,
	filePath: string,
	strategy: Extract<CompletionStrategy, { readonly type: "text-replacement" }>,
	fs: CompletionFileSystem,
	signal?: AbortSignal,
): Promise<CompletionApplicationResult> {
	if (!(await existsAsFile(filePath, fs, signal))) throw new CompletionError(`Completion target is not a file: ${filePath}`);
	return mutateFile(filePath, async (operationSignal) => {
		const before = await mutationFileIdentity(filePath, fs, operationSignal);
		const original = await fs.readFile(filePath, operationSignal);
		const afterRead = await mutationFileIdentity(filePath, fs, operationSignal);
		if (!sameFileIdentity(before, afterRead)) throw new CompletionError(`Completion target changed while it was being read: ${filePath}`);
		throwIfAborted(signal, operationSignal);
		const occurrences = original.split(strategy.oldText).length - 1;
		if (occurrences === 0) {
			if (original.includes(strategy.newText)) return { strategy: "text-replacement", changed: false, paths: [filePath] };
			throw new CompletionError("Exact text replacement source was not found.");
		}
		if (occurrences !== 1) throw new CompletionError("Exact text replacement source must occur exactly once.");
		const next = original.replace(strategy.oldText, strategy.newText);
		if (next === original) return { strategy: "text-replacement", changed: false, paths: [filePath] };
		const beforeWrite = await mutationFileIdentity(filePath, fs, operationSignal);
		if (!sameFileIdentity(before, beforeWrite)) throw new CompletionError(`Completion target changed before it was written: ${filePath}`);
		await atomicWriteText(filePath, next, fs, operationSignal);
		return { strategy: "text-replacement", changed: true, paths: [filePath] };
	}, signal);
}

async function updateMarkdownCheckbox(
	input: CompletionApplicationInput,
	filePath: string,
	strategy: Extract<CompletionStrategy, { readonly type: "markdown-checkbox" }>,
	fs: CompletionFileSystem,
	signal?: AbortSignal,
): Promise<CompletionApplicationResult> {
	if (!(await existsAsFile(filePath, fs, signal))) throw new CompletionError(`Completion target is not a file: ${filePath}`);
	return mutateFile(filePath, async (operationSignal) => {
		const before = await mutationFileIdentity(filePath, fs, operationSignal);
		const original = await fs.readFile(filePath, operationSignal);
		const afterRead = await mutationFileIdentity(filePath, fs, operationSignal);
		if (!sameFileIdentity(before, afterRead)) throw new CompletionError(`Completion target changed while it was being read: ${filePath}`);
		throwIfAborted(signal, operationSignal);
		if (/[\r\n\0]/.test(strategy.text)) throw new CompletionError("Markdown checkbox target must be one control-free line.");
		const desired = strategy.checked === false ? " " : "x";
		const target = strategy.text.trim();
		const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		// Use horizontal whitespace only: \\s would cross a newline and could
		// mutate a different checkbox when the requested text contains metacharacters.
		const linePattern = new RegExp(`^([ \\t]*[-*+][ \\t]+)\\[([ xX])\\]([ \\t]+${escaped}[ \\t]*)$`, "m");
		const match = linePattern.exec(original);
		if (!match) {
			const desiredPattern = new RegExp(`^[ \\t]*[-*+][ \\t]+\\[${desired === "x" ? "xX" : " "}\\][ \\t]+${escaped}[ \\t]*$`, "m");
			if (desiredPattern.test(original)) return { strategy: "markdown-checkbox", changed: false, paths: [filePath] };
			throw new CompletionError(`Markdown checkbox target was not found: ${strategy.text}`);
		}
		const replacement = `${match[1]}[${desired}]${match[3]}`;
		const next = original.slice(0, match.index) + replacement + original.slice(match.index + match[0].length);
		if (next === original) return { strategy: "markdown-checkbox", changed: false, paths: [filePath] };
		const beforeWrite = await mutationFileIdentity(filePath, fs, operationSignal);
		if (!sameFileIdentity(before, beforeWrite)) throw new CompletionError(`Completion target changed before it was written: ${filePath}`);
		await atomicWriteText(filePath, next, fs, operationSignal);
		return { strategy: "markdown-checkbox", changed: true, paths: [filePath] };
	}, signal);
}

async function updateFrontmatter(
	input: CompletionApplicationInput,
	filePath: string,
	strategy: Extract<CompletionStrategy, { readonly type: "frontmatter" }>,
	fs: CompletionFileSystem,
	signal?: AbortSignal,
): Promise<CompletionApplicationResult> {
	if (!strategy.field.trim()) throw new CompletionError("Frontmatter completion requires a field name.");
	if (!(await existsAsFile(filePath, fs, signal))) throw new CompletionError(`Completion target is not a file: ${filePath}`);
	return mutateFile(filePath, async (operationSignal) => {
		const before = await mutationFileIdentity(filePath, fs, operationSignal);
		const original = await fs.readFile(filePath, operationSignal);
		const afterRead = await mutationFileIdentity(filePath, fs, operationSignal);
		if (!sameFileIdentity(before, afterRead)) throw new CompletionError(`Completion target changed while it was being read: ${filePath}`);
		throwIfAborted(signal, operationSignal);
		const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(original);
		if (!match) throw new CompletionError(`Frontmatter completion target has no YAML frontmatter: ${filePath}`);
		const [full, opening, body, closing, ...rest] = match;
		if (full === undefined || opening === undefined || body === undefined || closing === undefined || rest.length > 0) {
			throw new CompletionError(`Frontmatter completion target has malformed YAML boundaries: ${filePath}`);
		}
		const document = parseDocument(body);
		throwIfAborted(signal, operationSignal);
		if (document.errors.length > 0) throw new CompletionError(`Frontmatter is invalid YAML in ${filePath}`);
		document.set(strategy.field, strategy.value);
		const rendered = document.toString({ lineWidth: 0 }).replace(/\n$/, "");
		throwIfAborted(signal, operationSignal);
		const replacement = `${opening}${rendered}${closing}`;
		if (replacement === match[0]) return { strategy: "frontmatter", changed: false, paths: [filePath] };
		const beforeWrite = await mutationFileIdentity(filePath, fs, operationSignal);
		if (!sameFileIdentity(before, beforeWrite)) throw new CompletionError(`Completion target changed before it was written: ${filePath}`);
		await atomicWriteText(filePath, `${replacement}${original.slice(match[0].length)}`, fs, operationSignal);
		return { strategy: "frontmatter", changed: true, paths: [filePath] };
	}, signal);
}

async function moveFile(
	strategy: Extract<CompletionStrategy, { readonly type: "rename-file" | "move-file" }>,
	from: string,
	to: string,
	fs: CompletionFileSystem,
	signal?: AbortSignal,
): Promise<CompletionApplicationResult> {
	const sourceExists = await existsAsFile(from, fs, signal);
	const destinationExists = await existsAsFile(to, fs, signal);
	if (!sourceExists && destinationExists) {
		return { strategy: strategy.type, changed: false, paths: [from, to] };
	}
	if (!sourceExists) throw new CompletionError(`Completion source does not exist: ${from}`);
	if (destinationExists) throw new CompletionError(`Completion destination already exists: ${to}`);
	return mutateTwoFiles(from, to, async (operationSignal) => {
		throwIfAborted(signal, operationSignal);
		const sourceIdentity = await mutationFileIdentity(from, fs, operationSignal);
		const sourceStillExists = await existsAsFile(from, fs, operationSignal);
		const destinationStillExists = await existsAsFile(to, fs, operationSignal);
		if (!sourceStillExists && destinationStillExists) return { strategy: strategy.type, changed: false, paths: [from, to] };
		if (!sourceStillExists) throw new CompletionError(`Completion source does not exist: ${from}`);
		if (destinationStillExists) throw new CompletionError(`Completion destination already exists: ${to}`);
		const sourceAfterChecks = await mutationFileIdentity(from, fs, operationSignal);
		if (!sameFileIdentity(sourceIdentity, sourceAfterChecks)) throw new CompletionError(`Completion source changed while it was being moved: ${from}`);
		await fs.rename(from, to, operationSignal);
		return { strategy: strategy.type, changed: true, paths: [from, to] };
	}, signal);
}

export function validateCompletionStrategy(strategy: CompletionStrategy): Effect.Effect<void, CompletionError> {
	if (strategy.type === "ledger-only") return Effect.void;
	if (completionStrategyPaths(strategy).some((value) => !value.trim() || /[\0\r\n]/.test(value))) return Effect.fail(new CompletionError("Completion paths must be non-empty and control-free."));
	if (strategy.type === "frontmatter" && !strategy.field.trim()) return Effect.fail(new CompletionError("Frontmatter completion requires a field name."));
	if (strategy.type === "text-replacement" && (!strategy.oldText || !strategy.newText)) return Effect.fail(new CompletionError("Exact text replacement requires oldText and newText."));
	if (strategy.type === "markdown-checkbox" && !strategy.text.trim()) return Effect.fail(new CompletionError("Markdown checkbox completion requires target text."));
	if ((strategy.type === "append-markdown" || strategy.type === "append" || strategy.type === "frontmatter" || strategy.type === "text-replacement" || strategy.type === "markdown-checkbox") && !strategy.path.trim()) {
		return Effect.fail(new CompletionError("File completion requires a target path."));
	}
	if ((strategy.type === "rename-file" || strategy.type === "move-file") && (!strategy.from.trim() || !strategy.to.trim())) {
		return Effect.fail(new CompletionError("File move completion requires source and destination paths."));
	}
	return Effect.void;
}

function assertPlanApprovedPaths(projectPath: string, strategy: CompletionStrategy, allowedPaths: readonly string[] | undefined): void {
	if (allowedPaths === undefined || strategy.type === "ledger-only") return;
	const approved = new Set(allowedPaths.map((value) => normalizedRelative(projectPath, path.resolve(projectPath, value))));
	for (const requested of completionStrategyPaths(strategy)) {
		const candidate = path.resolve(projectPath, requested);
		const relative = normalizedRelative(projectPath, candidate);
		if (!withinProject(projectPath, candidate) || isRepositoryControlPath(projectPath, candidate) || !approved.has(relative)) {
			throw new CompletionError(`Completion path is not declared by the work item: ${requested}`);
		}
	}
}

/** Apply only the explicitly selected completion strategy. */
export function applyCompletionStrategy(
	input: CompletionApplicationInput,
	fs: CompletionFileSystem = nodeCompletionFileSystem,
	signal?: AbortSignal,
): Effect.Effect<CompletionApplicationResult, Error> {
	return Effect.gen(function* () {
		yield* validateCompletionStrategy(input.strategy);
		return yield* Effect.tryPromise({
			try: async (effectSignal) => {
				const operationSignal = signal ?? effectSignal;
				throwIfAborted(signal, effectSignal);
				if (input.strategy.type !== "ledger-only") {
					const canonicalProject = await fs.realpath(input.projectPath, operationSignal);
					assertPlanApprovedPaths(canonicalProject, input.strategy, input.allowedPaths);
				}
				switch (input.strategy.type) {
					case "ledger-only":
						return { strategy: "ledger-only", changed: false, paths: [] } satisfies CompletionApplicationResult;
					case "append-markdown":
					case "append": {
						const target = await trustedPath(input.projectPath, input.strategy.path, false, fs, operationSignal);
						return appendMarkdown(input, target, fs, operationSignal);
					}
					case "text-replacement": {
						const target = await trustedPath(input.projectPath, input.strategy.path, false, fs, operationSignal);
						return replaceExactText(input, target, input.strategy, fs, operationSignal);
					}
					case "markdown-checkbox": {
						const target = await trustedPath(input.projectPath, input.strategy.path, false, fs, operationSignal);
						return updateMarkdownCheckbox(input, target, input.strategy, fs, operationSignal);
					}
					case "frontmatter": {
						const target = await trustedPath(input.projectPath, input.strategy.path, false, fs, operationSignal);
						return updateFrontmatter(input, target, input.strategy, fs, operationSignal);
					}
					case "rename-file": {
						const from = await trustedPath(input.projectPath, input.strategy.from, true, fs, operationSignal);
						const to = await trustedPath(input.projectPath, input.strategy.to, true, fs, operationSignal);
						return moveFile(input.strategy, from, to, fs, operationSignal);
					}
					case "move-file": {
						const from = await trustedPath(input.projectPath, input.strategy.from, true, fs, operationSignal);
						const to = await trustedPath(input.projectPath, input.strategy.to, true, fs, operationSignal);
						return moveFile(input.strategy, from, to, fs, operationSignal);
					}
				}
			},
			catch: (cause) => cause instanceof Error ? cause : new CompletionError(String(cause)),
		});
	});
}

/** Alias used by callers that treat completion as a command rather than a strategy. */
export const applyCompletion = applyCompletionStrategy;
