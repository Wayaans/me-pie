import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { GITHUB_CLONE_TIMEOUT_MS } from "./config.ts";
import { GitHubError } from "./errors.ts";

const CLONE_SIZE_LIMIT_MB = 350;
const README_NAMES = new Set(["README.md", "README.txt", "README.rst", "README"]);
const MAX_TREE_ENTRIES = 2000;
const MAX_FILE_BYTES = 50 * 1024;

export type ExecLike = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal | undefined; timeout?: number | undefined },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export type GitHubRef =
	| { kind: "repo"; owner: string; repo: string }
	| { kind: "tree"; owner: string; repo: string; ref: string; filePath: string }
	| { kind: "blob"; owner: string; repo: string; ref: string; filePath: string };

export function parseGitHubUrl(rawUrl: string): GitHubRef | null {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return null;
	}
	if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;
	const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
	const [owner, repoRaw, pathKind, ref, ...restPath] = segments;
	if (!owner || !repoRaw) return null;
	const repo = repoRaw.replace(/\.git$/, "");
	if (!pathKind) return { kind: "repo", owner, repo };
	if (pathKind === "tree" || pathKind === "blob") {
		if (!ref) return null;
		const kind = pathKind === "tree" ? "tree" as const : "blob" as const;
		const filePath = restPath.join("/");
		return { kind, owner, repo, ref, filePath };
	}
	return null;
}

export interface GitHubSession {
	readonly cloneDirs: Set<string>;
}

export function createGitHubSession(): GitHubSession {
	return { cloneDirs: new Set() };
}

export async function cleanupGitHubSession(session: GitHubSession): Promise<void> {
	const dirs = [...session.cloneDirs];
	session.cloneDirs.clear();
	await Promise.allSettled(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

export interface GitHubServeResult {
	readonly url: string;
	readonly repoPath: string;
	readonly text: string;
	readonly fileCount: number;
}

async function runCommand(
	command: string,
	args: string[],
	options: { signal?: AbortSignal | undefined; allowFailure?: boolean } = {},
	execLike: ExecLike,
): Promise<{ stdout: string; stderr: string; code: number }> {
	const result = await execLike(command, args, {
		signal: options.signal,
		timeout: GITHUB_CLONE_TIMEOUT_MS,
	});
	if (result.code !== 0 && !options.allowFailure) {
		throw new GitHubError({
			message: `${command} failed (exit ${result.code}): ${result.stderr.trim().slice(0, 400) || result.stdout.trim().slice(0, 400)}`,
		});
	}
	return result;
}

async function repoSizeMb(owner: string, repo: string, signal?: AbortSignal): Promise<number | null> {
	try {
		const signals = [AbortSignal.timeout(15_000)];
		if (signal) signals.push(signal);
		const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
			signal: AbortSignal.any(signals),
			headers: { Accept: "application/vnd.github+json", "User-Agent": "webweb/0.1" },
		});
		if (!response.ok) return null;
		const parsed: unknown = await response.json();
		const sizeKb = parsed && typeof parsed === "object" && "size" in parsed ? parsed.size : null;
		return typeof sizeKb === "number" ? sizeKb / 1024 : null;
	} catch {
		return null;
	}
}

async function countFiles(dir: string): Promise<number> {
	let count = 0;
	const queue = [dir];
	while (queue.length > 0 && count < MAX_TREE_ENTRIES) {
		const current = queue.shift();
		if (!current) break;
		const entries = await readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name === ".git") continue;
			if (entry.isDirectory()) queue.push(path.join(current, entry.name));
			else count += 1;
			if (count >= MAX_TREE_ENTRIES) return count;
		}
	}
	return count;
}

async function topLevelListing(dir: string): Promise<string> {
	const entries = await readdir(dir, { withFileTypes: true });
	const visible = entries.filter((entry) => entry.name !== ".git");
	const dirs = visible.filter((entry) => entry.isDirectory()).map((entry) => `${entry.name}/`).sort();
	const files = visible.filter((entry) => !entry.isDirectory()).map((entry) => entry.name).sort();
	const lines = [...dirs, ...files].map((name) => `- ${name}`);
	return lines.length > 0 ? `Repository contents:\n${lines.join("\n")}` : "Repository is empty.";
}

async function readReadme(dir: string): Promise<string | null> {
	const entries = await readdir(dir);
	const readme = entries.find((name) => README_NAMES.has(name) || /^README\./i.test(name));
	if (!readme) return null;
	const filePath = path.join(dir, readme);
	const info = await stat(filePath);
	const bytes = Math.min(info.size, MAX_FILE_BYTES);
	const handle = await readFile(filePath);
	return handle.subarray(0, bytes).toString("utf8");
}

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

async function cloneRepo(
	ref: GitHubRef,
	session: GitHubSession,
	execLike: ExecLike,
	signal?: AbortSignal,
): Promise<string> {
	const repoSlug = `${ref.owner}/${ref.repo}`;
	const dir = await mkdtemp(path.join(tmpdir(), "webweb-gh-"));
	session.cloneDirs.add(dir);
	const dest = path.join(dir, ref.repo);
	const requestedRef = ref.kind !== "repo" && !SHA_PATTERN.test(ref.ref) ? ref.ref : undefined;

	const attempts: Array<[string, string[]]> = [];
	if (requestedRef) {
		attempts.push(["git", ["clone", "--depth", "1", "--branch", requestedRef, `https://github.com/${repoSlug}.git`, dest]]);
	}
	attempts.push(["git", ["clone", "--depth", "1", `https://github.com/${repoSlug}.git`, dest]]);
	attempts.push(["gh", ["repo", "clone", repoSlug, dest, "--", "--depth", "1"]]);

	for (const [index, [command, args]] of attempts.entries()) {
		if (index > 0) await rm(dest, { recursive: true, force: true });
		const result = await runCommand(command, args, { signal, allowFailure: true }, execLike);
		if (result.code === 0) return dest;
	}
	throw new GitHubError({
		message: `Failed to clone ${repoSlug}. If it is private, make sure the gh CLI is authenticated (gh auth login).`,
	});
}

export function serveGitHub(
	rawUrl: string,
	session: GitHubSession,
	execLike: ExecLike,
	signal?: AbortSignal,
	forceClone = false,
): Effect.Effect<GitHubServeResult, GitHubError> {
	return Effect.tryPromise({
		try: async (abortSignal) => {
			const ref = parseGitHubUrl(rawUrl);
			if (!ref) throw new GitHubError({ message: `Not a GitHub URL: ${rawUrl}` });
			const repoSlug = `${ref.owner}/${ref.repo}`;

			const sizeMb = forceClone ? null : await repoSizeMb(ref.owner, ref.repo, abortSignal);
			if (sizeMb !== null && sizeMb > CLONE_SIZE_LIMIT_MB) {
				throw new GitHubError({
					message: `Repository ${repoSlug} is ~${Math.round(sizeMb)}MB (over the ${CLONE_SIZE_LIMIT_MB}MB clone limit). Browse it on github.com instead.`,
				});
			}

			const dest = await cloneRepo(ref, session, execLike, abortSignal);
			const fileCount = await countFiles(dest);

			if (ref.kind === "repo") {
				const listing = await topLevelListing(dest);
				const readme = await readReadme(dest);
				const text = readme ? `${listing}\n\n--- README ---\n\n${readme}` : listing;
				return { url: rawUrl, repoPath: dest, text, fileCount };
			}

			const target = path.join(dest, ref.filePath);
			if (ref.kind === "blob") {
				const info = await stat(target).catch(() => null);
				if (!info || !info.isFile()) {
					throw new GitHubError({ message: `File not found in ${repoSlug}@${ref.ref}: ${ref.filePath}` });
				}
				const bytes = Math.min(info.size, MAX_FILE_BYTES);
				const content = (await readFile(target)).subarray(0, bytes).toString("utf8");
				const truncated = info.size > MAX_FILE_BYTES ? "\n\n[File truncated at 50KB]" : "";
				return { url: rawUrl, repoPath: dest, text: `File: ${ref.filePath}\n\n${content}${truncated}`, fileCount };
			}

			const info = await stat(target).catch(() => null);
			if (!info || !info.isDirectory()) {
				throw new GitHubError({ message: `Directory not found in ${repoSlug}@${ref.ref}: ${ref.filePath}` });
			}
			const entries = await readdir(target, { withFileTypes: true });
			const lines = entries.map((entry) => `- ${entry.name}${entry.isDirectory() ? "/" : ""}`).sort();
			return {
				url: rawUrl,
				repoPath: dest,
				text: lines.length > 0 ? `Contents of ${ref.filePath}:\n${lines.join("\n")}` : "Directory is empty.",
				fileCount,
			};
		},
		catch: (error) => error instanceof GitHubError
			? error
			: new GitHubError({ message: `GitHub handling failed for ${rawUrl}: ${String(error)}` }),
	}).pipe(
		Effect.timeout(GITHUB_CLONE_TIMEOUT_MS),
		Effect.catchTag("TimeoutError", () =>
			Effect.fail(new GitHubError({ message: `GitHub clone timed out for ${rawUrl}` }))),
	);
}
