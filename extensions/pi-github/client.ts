import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const COMMAND_TIMEOUT_MS = 10_000;
export const ACCEPT_HEADER = "application/vnd.github+json";

const MAX_ERROR_BYTES = 4 * 1024;

type GhResult = {
	code: number;
	stdout: string;
	stderr: string;
	killed?: boolean;
};

export type RepoResolution = {
	nameWithOwner: string;
};

export type GitHubClient = {
	reset(): void;
	invalidate(repo: string): void;
	repo(cwd: string, requested: string | undefined, signal?: AbortSignal): Promise<RepoResolution>;
	readText(cwd: string, args: string[], label: string, signal?: AbortSignal): Promise<string>;
	readJson(cwd: string, args: string[], label: string, signal?: AbortSignal): Promise<unknown>;
	freshJson(cwd: string, args: string[], label: string, signal?: AbortSignal): Promise<unknown>;
	mutationText(cwd: string, repo: string, args: string[], label: string, signal?: AbortSignal): Promise<string>;
	mutationJson(cwd: string, repo: string, args: string[], label: string, signal?: AbortSignal): Promise<unknown>;
};

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function boundedStderr(stderr: string): string {
	const bytes = Buffer.from(stderr.trim(), "utf8");
	return bytes.subarray(0, MAX_ERROR_BYTES).toString("utf8");
}

function validateRepo(value: unknown): string {
	if (typeof value !== "string") {
		throw new Error("repository resolution failed: expected owner/name");
	}
	const match = value.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/);
	if (!match || match[2] === "." || match[2] === "..") {
		throw new Error("repository resolution failed: expected owner/name");
	}
	return value;
}

function commandError(label: string, stderr: string): Error {
	const detail = boundedStderr(stderr) || "unknown GitHub API error";
	if (/relation/i.test(label) && /(?:404|410|unsupported|not found)/i.test(detail)) {
		return new Error(`${label}: unsupported relation endpoint (${detail})`);
	}
	if (/(auth|authentication)/i.test(label) || /not logged in|authentication|oauth/i.test(detail)) {
		return new Error(`${label}: authentication failed (${detail})`);
	}
	if (/permission|forbidden|not permitted/i.test(detail)) {
		return new Error(`${label}: permission denied (${detail})`);
	}
	return new Error(`${label}: ${detail}`);
}

function parseJson(stdout: string, label: string): unknown {
	try {
		return JSON.parse(stdout) as unknown;
	} catch (error) {
		throw new Error(`${label}: malformed JSON (${messageOf(error)})`);
	}
}

function cacheKey(cwd: string, args: string[]): string {
	return `${cwd}|${args.join("\u0000")}`;
}

function keyTargetsRepo(key: string, repo: string): boolean {
	return key.includes(`repos/${repo}/`) || key.includes(`--repo\u0000${repo}`);
}

export function createGitHubClient(pi: ExtensionAPI): GitHubClient {
	const repoCache = new Map<string, RepoResolution>();
	const textCache = new Map<string, string>();
	const jsonCache = new Map<string, unknown>();

	const run = async (
		cwd: string,
		args: string[],
		label: string,
		signal?: AbortSignal,
	): Promise<GhResult> => {
		try {
			const result = await pi.exec("gh", args, {
				cwd,
				timeout: COMMAND_TIMEOUT_MS,
				...(signal ? { signal } : {}),
			});
			if (signal?.aborted) throw new Error(`${label}: cancelled`);
			if (result.killed) throw new Error(`${label}: timeout/killed`);
			if (result.code !== 0) throw commandError(label, result.stderr);
			return result;
		} catch (error) {
			if (error instanceof Error && error.message.startsWith(`${label}:`)) throw error;
			if (signal?.aborted) throw new Error(`${label}: cancelled`);

			const detail = messageOf(error);
			if (/ENOENT|spawn .*gh|gh.*not found/i.test(detail)) {
				throw new Error(`${label}: gh executable unavailable`);
			}
			if (/timeout|timed out/i.test(detail)) throw new Error(`${label}: timeout`);
			if (/killed|SIGTERM|SIGKILL/i.test(detail)) throw new Error(`${label}: command killed`);
			throw commandError(label, detail);
		}
	};

	const freshJson = async (
		cwd: string,
		args: string[],
		label: string,
		signal?: AbortSignal,
	): Promise<unknown> => {
		const result = await run(cwd, args, label, signal);
		return parseJson(result.stdout, label);
	};

	const invalidate = (repo: string): void => {
		for (const key of textCache.keys()) {
			if (keyTargetsRepo(key, repo)) textCache.delete(key);
		}
		for (const key of jsonCache.keys()) {
			if (keyTargetsRepo(key, repo)) jsonCache.delete(key);
		}
	};

	return {
		reset() {
			repoCache.clear();
			textCache.clear();
			jsonCache.clear();
		},
		invalidate,
		async repo(cwd, requested, signal) {
			if (requested) return { nameWithOwner: validateRepo(requested) };

			const cached = repoCache.get(cwd);
			if (cached) return cached;

			const result = await run(
				cwd,
				["repo", "view", "--json", "nameWithOwner"],
				"repository resolution failed",
				signal,
			);
			const parsed = parseJson(result.stdout, "repository resolution failed");
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				throw new Error("repository resolution failed: malformed JSON (response is not an object)");
			}
			const resolution = {
				nameWithOwner: validateRepo((parsed as Record<string, unknown>).nameWithOwner),
			};
			repoCache.set(cwd, resolution);
			return resolution;
		},
		async readText(cwd, args, label, signal) {
			const key = cacheKey(cwd, args);
			const cached = textCache.get(key);
			if (cached !== undefined) return cached;

			const result = await run(cwd, args, label, signal);
			textCache.set(key, result.stdout);
			return result.stdout;
		},
		async readJson(cwd, args, label, signal) {
			const key = cacheKey(cwd, args);
			if (jsonCache.has(key)) return jsonCache.get(key);

			const value = await freshJson(cwd, args, label, signal);
			jsonCache.set(key, value);
			return value;
		},
		freshJson,
		async mutationText(cwd, repo, args, label, signal) {
			const result = await run(cwd, args, label, signal);
			invalidate(repo);
			return result.stdout;
		},
		async mutationJson(cwd, repo, args, label, signal) {
			const result = await run(cwd, args, label, signal);
			invalidate(repo);
			return parseJson(result.stdout, label);
		},
	};
}

export function repoApiPath(repo: string, path: string): string {
	return `repos/${repo}/${path}`;
}
