import { realpath, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
	readonly stat: (filePath: string, signal?: AbortSignal) => Promise<{ readonly isFile: () => boolean }>;
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

function missing(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT");
}

/**
 * Resolve an explicit plan path against the canonical project and reject both
 * traversal and symlinks which leave the trusted checkout. Missing destination
 * paths are allowed for rename/move targets, but their existing parent is
 * still canonicalized and checked.
 */
async function trustedPath(
	projectPath: string,
	requested: string,
	allowMissing: boolean,
	fs: CompletionFileSystem,
	signal?: AbortSignal,
): Promise<string> {
	if (!requested.trim() || requested.includes("\0")) throw new CompletionError("Completion paths must be non-empty and control-free.");
	throwIfAborted(signal);
	const project = await fs.realpath(projectPath, signal);
	throwIfAborted(signal);
	const candidate = path.resolve(project, requested);
	if (!withinProject(project, candidate)) throw new CompletionError(`Completion path escapes the trusted project: ${requested}`);
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
				if (!withinProject(project, resolved)) throw new CompletionError(`Completion path escapes the trusted project: ${requested}`);
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

function safeMarkerPart(value: string): string {
	const readable = value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
	return readable || "item";
}

export function completionMarker(runId: string, workItemId: string): string {
	return `<!-- mepie-ticket-flow:completed:${safeMarkerPart(runId)}:${safeMarkerPart(workItemId)} -->`;
}

function markdownBlock(input: CompletionApplicationInput): string {
	const marker = completionMarker(input.runId, input.workItemId);
	const comment = input.comment.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
	return [
		marker,
		"",
		"## Ticket Flow completion",
		`- Work item: ${input.workItemTitle}`,
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
		const original = await fs.readFile(filePath, operationSignal);
		throwIfAborted(signal, operationSignal);
		if (original.includes(marker)) return { strategy: "append-markdown", changed: false, paths: [filePath] };
		const separator = original.length === 0 ? "" : original.endsWith("\n") ? "\n" : "\n\n";
		await atomicWriteText(filePath, `${original}${separator}${markdownBlock(input)}\n`, fs, operationSignal);
		return { strategy: "append-markdown", changed: true, paths: [filePath] };
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
		const original = await fs.readFile(filePath, operationSignal);
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
		const sourceStillExists = await existsAsFile(from, fs, operationSignal);
		const destinationStillExists = await existsAsFile(to, fs, operationSignal);
		if (!sourceStillExists && destinationStillExists) return { strategy: strategy.type, changed: false, paths: [from, to] };
		if (!sourceStillExists) throw new CompletionError(`Completion source does not exist: ${from}`);
		if (destinationStillExists) throw new CompletionError(`Completion destination already exists: ${to}`);
		await fs.rename(from, to, operationSignal);
		return { strategy: strategy.type, changed: true, paths: [from, to] };
	}, signal);
}

export function validateCompletionStrategy(strategy: CompletionStrategy): Effect.Effect<void, CompletionError> {
	if (strategy.type === "ledger-only") return Effect.void;
	if (strategy.type === "frontmatter" && !strategy.field.trim()) return Effect.fail(new CompletionError("Frontmatter completion requires a field name."));
	if ((strategy.type === "append-markdown" || strategy.type === "frontmatter") && !strategy.path.trim()) {
		return Effect.fail(new CompletionError("File completion requires a target path."));
	}
	if ((strategy.type === "rename-file" || strategy.type === "move-file") && (!strategy.from.trim() || !strategy.to.trim())) {
		return Effect.fail(new CompletionError("File move completion requires source and destination paths."));
	}
	return Effect.void;
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
				switch (input.strategy.type) {
					case "ledger-only":
						return { strategy: "ledger-only", changed: false, paths: [] } satisfies CompletionApplicationResult;
					case "append-markdown": {
						const target = await trustedPath(input.projectPath, input.strategy.path, false, fs, operationSignal);
						return appendMarkdown(input, target, fs, operationSignal);
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
