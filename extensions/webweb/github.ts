import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { GITHUB_CLONE_TIMEOUT_MS } from "./config.ts";
import { GitHubError } from "./errors.ts";
import { awaitResponse, readText, withAbort } from "./network.ts";
import { MAX_FILE_BYTES, readRepositoryFile, repositoryEntries, repositoryListing } from "./github-files.ts";
import { guardedFetch, type LookupFunction, type RequestFunction } from "./ssrf.ts";
import { displayUrl } from "./url.ts";

const CLONE_SIZE_LIMIT_MB = 350;
const README_NAMES = new Set(["README.md", "README.txt", "README.rst", "README"]);
const MAX_TREE_ENTRIES = 2000;

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
	if (rawUrl.length > 2000) return null;
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	if (parsed.username || parsed.password || parsed.port) return null;
	if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;
	// Inspect before URL normalization can erase dot segments. Decode once only.
	const rawPath = rawUrl.match(/^https?:\/\/[^/?#]+(\/[^?#]*)?/i)?.[1] ?? "";
	if (rawUrl.includes("\\")) return null;
	let segments: Array<string>;
	try {
		segments = rawPath.split("/").filter((segment) => segment !== "").map(decodeURIComponent);
	} catch { return null; }
	if (segments.reduce((count, segment) => count + segment.split("/").length, 0) > 64 || segments.some((segment) => /[\\\x00-\x1f\x7f]/.test(segment)
		|| segment.split("/").some((part) => part === "." || part === ".." || part === ""))) return null;
	const [owner, repoRaw, pathKind, ref, ...restPath] = segments;
	if (!owner || !repoRaw) return null;
	const repo = repoRaw.replace(/\.git$/, "");
	if (!/^[a-z0-9][a-z0-9-]{0,38}$/i.test(owner) || !/^[a-z0-9._-]{1,100}$/i.test(repo) || repo === "." || repo === "..") return null;
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
	readonly repoPath: string | null;
	readonly text: string;
	readonly fileCount: number;
	readonly fetchedUrl?: string;
}

async function runCommand(
	command: string,
	args: string[],
	options: { signal?: AbortSignal | undefined } = {},
	execLike: ExecLike,
): Promise<{ stdout: string; stderr: string; code: number }> {
	options.signal?.throwIfAborted();
	const result = await execLike(command, args, {
		signal: options.signal,
		timeout: GITHUB_CLONE_TIMEOUT_MS,
	});
	options.signal?.throwIfAborted();
	if (result.code !== 0) {
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
		const combined = AbortSignal.any(signals);
		combined.throwIfAborted();
		const response = await awaitResponse(fetch(`https://api.github.com/repos/${owner}/${repo}`, {
			signal: combined,
			redirect: "error",
			headers: { Accept: "application/vnd.github+json", "User-Agent": "webweb/0.1" },
		}), combined);
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			return null;
		}
		const parsed: unknown = JSON.parse(await readText(response, 1024 * 1024, combined));
		const sizeKb = parsed && typeof parsed === "object" && "size" in parsed ? parsed.size : null;
		return typeof sizeKb === "number" ? sizeKb / 1024 : null;
	} catch {
		signal?.throwIfAborted();
		return null;
	}
}

async function countFiles(dir: string, signal?: AbortSignal): Promise<number> {
	let count = 0;
	let visited = 0;
	const queue = [""];
	while (queue.length > 0 && visited < MAX_TREE_ENTRIES) {
		const current = queue.shift();
		if (current === undefined) break;
		const { entries } = await repositoryEntries(dir, current, signal);
		for (const entry of entries) {
			visited += 1;
			if (entry.directory) queue.push(path.join(current, entry.name));
			else count += 1;
			if (visited >= MAX_TREE_ENTRIES) break;
		}
	}
	return count;
}

async function readReadme(dir: string, signal?: AbortSignal): Promise<string | null> {
	const { entries } = await repositoryEntries(dir, "", signal);
	const readme = entries.find(({ name }) => README_NAMES.has(name) || /^README\./i.test(name));
	return readme ? readRepositoryFile(dir, readme.name, signal) : null;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function validRefName(name: string): boolean {
	return !/[\x00-\x20~^:?*\[\\]/.test(name) && !name.includes("..") && !name.includes("@{")
		&& name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"));
}

interface ResolvedRevision {
	readonly commit: string;
	readonly filePath: string;
}

async function resolveRevision(ref: GitHubRef, remote: string, execLike: ExecLike | undefined, signal?: AbortSignal): Promise<ResolvedRevision> {
	if (ref.kind !== "repo" && SHA_PATTERN.test(ref.ref)) return { commit: ref.ref.toLowerCase(), filePath: ref.filePath };
	if (!execLike) throw new GitHubError({ message: "GitHub named revision resolution requires exec capability. Use a full commit SHA for a single file." });
	const parts = ref.kind === "repo" ? [] : [ref.ref, ...ref.filePath.split("/").filter(Boolean)];
	const candidates = parts.map((_, index) => ({ name: parts.slice(0, index + 1).join("/"), filePath: parts.slice(index + 1).join("/") }))
		.filter(({ name }) => validRefName(name));
	const patterns = ref.kind === "repo" ? ["HEAD"] : candidates.flatMap(({ name }) => [`refs/heads/${name}`, `refs/tags/${name}`, `refs/tags/${name}^{}`]);
	if (!patterns.length) throw new GitHubError({ message: "Invalid requested GitHub revision" });
	const result = await runCommand("git", ["ls-remote", "--", remote, ...patterns], { signal }, execLike);
	// Exact matching prevents ls-remote's tail/glob semantics from choosing another ref.
	const refs = new Map<string, string>();
	for (const line of result.stdout.split("\n")) {
		const [commit, name] = line.split("\t");
		if (commit && name && SHA_PATTERN.test(commit)) refs.set(name, commit.toLowerCase());
	}
	if (ref.kind === "repo") {
		const commit = refs.get("HEAD");
		if (commit) return { commit, filePath: "" };
	} else {
		for (const candidate of candidates.reverse()) {
			const branch = refs.get(`refs/heads/${candidate.name}`);
			const tag = refs.get(`refs/tags/${candidate.name}^{}`) ?? refs.get(`refs/tags/${candidate.name}`);
			if (branch && tag && branch !== tag) throw new GitHubError({ message: `Ambiguous branch/tag '${candidate.name}'. Use a full commit SHA.` });
			const commit = branch ?? tag;
			if (commit) return { commit, filePath: candidate.filePath };
		}
	}
	throw new GitHubError({ message: "Requested GitHub revision was not found. No default-branch fallback was attempted." });
}

async function cloneRepo(
	ref: GitHubRef,
	session: GitHubSession,
	execLike: ExecLike,
	signal?: AbortSignal,
): Promise<{ dest: string; revision: ResolvedRevision }> {
	const remote = `https://github.com/${ref.owner}/${ref.repo}.git`;
	const revision = await resolveRevision(ref, remote, execLike, signal);
	const dir = await mkdtemp(path.join(tmpdir(), "webweb-gh-"));
	session.cloneDirs.add(dir);
	const dest = path.join(dir, ref.repo);
	await runCommand("git", ["init", "--", dest], { signal }, execLike);
	await runCommand("git", ["-C", dest, "fetch", "--depth=1", "--no-tags", "--", remote, revision.commit], { signal }, execLike);
	const fetched = await runCommand("git", ["-C", dest, "rev-parse", "--verify", "FETCH_HEAD^{commit}"], { signal }, execLike);
	if (fetched.stdout.trim().toLowerCase() !== revision.commit) throw new GitHubError({ message: "Fetched commit does not match requested GitHub revision" });
	await runCommand("git", ["-C", dest, "checkout", "--detach", revision.commit], { signal }, execLike);
	const checkedOut = await runCommand("git", ["-C", dest, "rev-parse", "--verify", "HEAD^{commit}"], { signal }, execLike);
	if (checkedOut.stdout.trim().toLowerCase() !== revision.commit) throw new GitHubError({ message: "Checked-out commit does not match requested GitHub revision" });
	return { dest, revision };
}

export interface GitHubTransport {
	readonly lookup?: LookupFunction | undefined;
	/** Offline connector seam; production uses the SSRF-pinned native transport. */
	readonly request?: RequestFunction | undefined;
}

async function fetchGitHubFile(
	ref: Extract<GitHubRef, { kind: "blob" }>,
	revision: ResolvedRevision,
	transport: GitHubTransport,
	signal: AbortSignal,
): Promise<{ content: string; url: string }> {
	if (!revision.filePath) throw new GitHubError({ message: "GitHub blob URL requires a file path" });
	const rawPath = [ref.owner, ref.repo, revision.commit, ...revision.filePath.split("/")].map(encodeURIComponent).join("/");
	// No Git credentials or provider keys are sent. Raw symlinks are link text, not local paths.
	const url = `https://raw.githubusercontent.com/${rawPath}`;
	const response = await guardedFetch(url, { ...transport, signal });
	if (!response.ok) {
		response.cancel();
		throw new GitHubError({ message: `GitHub raw file HTTP ${response.status}. The file or revision may be unavailable; private files requiring authentication are unsupported. No fallback was attempted.` });
	}
	const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
	if (/^(image\/(?!svg\+xml$)|audio\/|video\/|font\/)/.test(contentType) || /^(application\/(pdf|zip|gzip|x-gzip|x-7z-compressed|wasm))$/.test(contentType)) {
		response.cancel();
		throw new GitHubError({ message: "GitHub file is binary; only textual previews are supported" });
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	signal.throwIfAborted();
	let text: string;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { throw new GitHubError({ message: "GitHub file is not UTF-8 text; binary previews are unsupported" }); }
	if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) throw new GitHubError({ message: "GitHub file is binary; only textual previews are supported" });
	if (bytes.length <= MAX_FILE_BYTES) return { content: text, url };
	// Streaming decode omits any partial UTF-8 character at the preview boundary.
	return { content: new TextDecoder().decode(bytes.subarray(0, MAX_FILE_BYTES), { stream: true }) + "\n\n[File truncated at 50KB]", url };
}

export function serveGitHub(
	rawUrl: string,
	session: GitHubSession,
	execLike: ExecLike | undefined,
	signal?: AbortSignal,
	forceClone = false,
	transport: GitHubTransport = {},
): Effect.Effect<GitHubServeResult, GitHubError> {
	return Effect.tryPromise({
		try: async (runtimeSignal) => {
			const abortSignal = AbortSignal.any([runtimeSignal, ...(signal ? [signal] : [])]);
			abortSignal.throwIfAborted();
			const ref = parseGitHubUrl(rawUrl);
			if (!ref) throw new GitHubError({ message: `Not an allowed GitHub URL: ${displayUrl(rawUrl)}` });
			const repoSlug = `${ref.owner}/${ref.repo}`;
			if (ref.kind === "blob") {
				const revision = await resolveRevision(ref, `https://github.com/${repoSlug}.git`, execLike, abortSignal);
				const file = await fetchGitHubFile(ref, revision, transport, abortSignal);
				return { url: rawUrl, fetchedUrl: file.url, repoPath: null, text: `Commit: ${revision.commit}\nFile: ${revision.filePath}\n\n${file.content}`, fileCount: 1 };
			}
			if (!execLike) throw new GitHubError({ message: "GitHub repository previews require exec capability" });

			const sizeMb = forceClone ? null : await repoSizeMb(ref.owner, ref.repo, abortSignal);
			if (sizeMb !== null && sizeMb > CLONE_SIZE_LIMIT_MB) {
				throw new GitHubError({
					message: `Repository ${repoSlug} is ~${Math.round(sizeMb)}MB (over the ${CLONE_SIZE_LIMIT_MB}MB clone limit). Browse it on github.com instead.`,
				});
			}

			const { dest, revision } = await cloneRepo(ref, session, execLike, abortSignal);
			const fileCount = await countFiles(dest, abortSignal);

			if (ref.kind === "repo") {
				const listing = `Repository contents:\n${await repositoryListing(dest, "", abortSignal)}`;
				const readme = await readReadme(dest, abortSignal);
				const text = `Commit: ${revision.commit}\n${readme ? `${listing}\n\n--- README ---\n\n${readme}` : listing}`;
				return { url: rawUrl, repoPath: dest, text, fileCount };
			}

			const listing = await repositoryListing(dest, revision.filePath, abortSignal);
			return {
				url: rawUrl,
				repoPath: dest,
				text: `Commit: ${revision.commit}\nContents of ${revision.filePath}:\n${listing}`,
				fileCount,
			};
		},
		catch: (error) => error instanceof GitHubError
			? error
			: new GitHubError({ message: `GitHub handling failed for ${displayUrl(rawUrl)}: ${String(error)}` }),
	}).pipe(
		Effect.timeout(GITHUB_CLONE_TIMEOUT_MS),
		Effect.catchTag("TimeoutError", () =>
			Effect.fail(new GitHubError({ message: `GitHub request timed out for ${displayUrl(rawUrl)}` }))),
		(effect) => withAbort(effect, signal),
	);
}
