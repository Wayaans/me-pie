import { execFile } from "node:child_process";
import path from "node:path";
import { access, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { Effect } from "effect";
import type { GitRunState } from "./domain.ts";

const execFileAsync = promisify(execFile);

export interface GitCommandRunner {
	readonly run: (args: readonly string[], cwd: string, signal?: AbortSignal) => Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number }>;
}

export const nodeGitRunner: GitCommandRunner = {
	run: async (args, cwd, signal) => {
		try {
			const result = await execFileAsync("git", [...args], { cwd, signal, encoding: "utf8" });
			return { stdout: result.stdout, stderr: result.stderr, code: 0 };
		} catch (cause) {
			const error = cause as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
			return { stdout: error.stdout ?? "", stderr: error.stderr ?? error.message ?? String(cause), code: typeof error.code === "number" ? error.code : 1 };
		}
	},
};

export interface GitPreflight {
	readonly repository: string;
	readonly baselineCommit: string;
	readonly baselineBranch: string;
	readonly workflowBranch: string;
	readonly clean: boolean;
	readonly changedFiles: readonly string[];
}

export interface GitAcceptanceContext {
	readonly state: GitRunState;
	/** The active implementation/fix report is the only source of new commits. */
	readonly workItemId: string;
	readonly workItemKind: "implementation" | "fix";
}

export interface GitStatusEntry {
	readonly indexStatus: string;
	readonly worktreeStatus: string;
	readonly path: string;
	readonly originalPath?: string;
}

const COMMIT_HASH = /^[0-9a-fA-F]{4,64}$/;

function nonEmpty(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized || normalized !== value || /[\0\r\n\t ]/.test(value)) throw new Error(`Git ${field} must be an exact non-empty value.`);
	return normalized;
}

function exactCommitHash(value: string): string {
	if (!COMMIT_HASH.test(value)) throw new Error(`Invalid commit ID: ${value}`);
	return value.toLowerCase();
}

async function command(runner: GitCommandRunner, args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
	const result = await runner.run(args, cwd, signal);
	if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || "unknown error"}`);
	return result.stdout.trim();
}

export async function gitStatusEntries(cwd: string, runner: GitCommandRunner = nodeGitRunner, signal?: AbortSignal): Promise<readonly GitStatusEntry[]> {
	const result = await runner.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd, signal);
	if (result.code !== 0) throw new Error(`git status failed: ${result.stderr.trim() || "unknown error"}`);
	const fields = result.stdout.split("\0");
	const entries: GitStatusEntry[] = [];
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index];
		if (!field) continue;
		if (field.length < 4 || field[2] !== " ") throw new Error("git status returned malformed porcelain output");
		const indexStatus = field[0]!;
		const worktreeStatus = field[1]!;
		const currentPath = field.slice(3);
		if (!currentPath) throw new Error("git status returned an empty changed path");
		if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
			const originalPath = fields[index + 1];
			if (!originalPath) throw new Error("git status returned an incomplete rename record");
			entries.push({ indexStatus, worktreeStatus, path: currentPath, originalPath });
			index += 1;
		} else {
			entries.push({ indexStatus, worktreeStatus, path: currentPath });
		}
	}
	return entries;
}

async function statusFiles(cwd: string, runner: GitCommandRunner, signal?: AbortSignal): Promise<string[]> {
	const entries = await gitStatusEntries(cwd, runner, signal);
	return [...new Set(entries.flatMap((entry) => entry.originalPath === undefined ? [entry.path] : [entry.path, entry.originalPath]))];
}

export async function isGitRepository(cwd: string): Promise<boolean> {
	try { await access(`${cwd}/.git`); return true; } catch { return false; }
}

/** Check cleanliness and capture the exact baseline before a run mutates anything. */
export async function gitPreflight(cwd: string, runId: string, runner: GitCommandRunner = nodeGitRunner, signal?: AbortSignal): Promise<GitPreflight | undefined> {
	if (!(await isGitRepository(cwd))) return undefined;
	const changedFiles = await statusFiles(cwd, runner, signal);
	if (changedFiles.length > 0) throw new Error(`Ticket Flow requires a clean worktree before starting; changed paths: ${changedFiles.join(", ")}`);
	const baselineCommit = nonEmpty(await command(runner, ["rev-parse", "HEAD"], cwd, signal), "baseline commit");
	const baselineBranch = nonEmpty(await command(runner, ["branch", "--show-current"], cwd, signal), "baseline branch");
	const workflowBranch = `mepie/ticket-flow/${runId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
	const existing = await runner.run(["show-ref", "--verify", "--quiet", `refs/heads/${workflowBranch}`], cwd, signal);
	if (existing.code === 0) {
		const existingHead = await command(runner, ["rev-parse", workflowBranch], cwd, signal);
		if (existingHead !== baselineCommit) throw new Error(`Dedicated workflow branch ${workflowBranch} already contains commits; refusing to reuse it for a new run.`);
		await command(runner, ["switch", workflowBranch], cwd, signal);
	} else {
		await command(runner, ["switch", "-c", workflowBranch], cwd, signal);
	}
	return { repository: cwd, baselineCommit, baselineBranch, workflowBranch, clean: true, changedFiles: [] };
}

export function gitStateFromPreflight(preflight: GitPreflight): GitRunState {
	return {
		repository: preflight.repository,
		baselineCommit: preflight.baselineCommit,
		baselineBranch: preflight.baselineBranch,
		workflowBranch: preflight.workflowBranch,
		acceptedCommitIds: [],
		cleanPreflight: preflight.clean,
	};
}

export async function gitHead(cwd: string, runner: GitCommandRunner = nodeGitRunner, signal?: AbortSignal): Promise<string | undefined> {
	if (!(await isGitRepository(cwd))) return undefined;
	return command(runner, ["rev-parse", "HEAD"], cwd, signal);
}

function safeCommitPart(value: string): string {
	const result = value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
	return result.slice(0, 80) || "item";
}

export function completionCommitMessage(runId: string, workItemId: string): string {
	return `mepie(ticket-flow): record completion ${safeCommitPart(runId)}/${safeCommitPart(workItemId)}`;
}

export interface CompletionCommitInput {
	readonly projectPath: string;
	readonly runId: string;
	readonly workItemId: string;
	readonly paths: readonly string[];
	/** Accepted worker commits must be ancestors of the dedicated commit. */
	readonly expectedParentCommitIds?: readonly string[];
	readonly runner?: GitCommandRunner;
	readonly signal?: AbortSignal;
}

export interface CompletionCommitResult {
	readonly commitId?: string;
	readonly paths: readonly string[];
	readonly alreadyCommitted: boolean;
}

function statusPathSet(entries: readonly GitStatusEntry[]): Set<string> {
	return new Set(entries.flatMap((entry) => entry.originalPath === undefined ? [entry.path] : [entry.path, entry.originalPath]));
}

async function assertSafeCompletionPath(projectPath: string, candidate: string): Promise<string> {
	const canonicalProject = await realpath(projectPath);
	const absolute = path.resolve(canonicalProject, candidate);
	const relative = path.relative(canonicalProject, absolute);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.split(path.sep).some((part) => part === ".git" || part.startsWith(".git")) || /[\0\r\n]/.test(relative)) {
		throw new Error(`Completion commit path is outside the project or targets repository control data: ${candidate}`);
	}
	return relative.split(path.sep).join("/");
}

function assertOnlyExpectedChanges(entries: readonly GitStatusEntry[], expected: ReadonlySet<string>, requireStaged: boolean): void {
	const actual = statusPathSet(entries);
	for (const changed of actual) if (!expected.has(changed)) throw new Error(`Completion mutation changed an undeclared path: ${changed}`);
	for (const expectedPath of expected) if (!actual.has(expectedPath)) throw new Error(`Completion mutation did not produce the declared path: ${expectedPath}`);
	if (requireStaged && entries.some((entry) => entry.indexStatus === " " || entry.worktreeStatus !== " ")) {
		throw new Error("Completion mutation was not fully staged or left a worktree change after staging.");
	}
}

async function commitChangedPaths(cwd: string, runner: GitCommandRunner, signal?: AbortSignal): Promise<readonly string[]> {
	const result = await runner.run(["diff-tree", "--no-commit-id", "--name-status", "-r", "-M", "-z", "HEAD"], cwd, signal);
	if (result.code !== 0) throw new Error(`git diff-tree failed: ${result.stderr.trim() || "unknown error"}`);
	const fields = result.stdout.split("\0");
	const paths: string[] = [];
	for (let index = 0; index < fields.length; index += 1) {
		const status = fields[index];
		if (!status) continue;
		if (status.startsWith("R") || status.startsWith("C")) {
			const original = fields[index + 1];
			const current = fields[index + 2];
			if (!original || !current) throw new Error("git diff-tree returned an incomplete rename record");
			paths.push(original, current);
			index += 2;
		} else {
			const current = fields[index + 1];
			if (!current) throw new Error("git diff-tree returned an incomplete path record");
			paths.push(current);
			index += 1;
		}
	}
	return paths;
}

/**
 * Turn the already-applied, plan-approved mutation into a dedicated commit.
 * Only exact paths are staged; a clean postcondition is checked both before
 * and after the commit.  The deterministic subject lets recovery recognize a
 * commit made just before a process crash.
 */
export async function commitCompletionMutation(input: CompletionCommitInput): Promise<CompletionCommitResult> {
	const runner = input.runner ?? nodeGitRunner;
	if (!(await isGitRepository(input.projectPath))) return { paths: [], alreadyCommitted: false };
	const expected = new Set(await Promise.all(input.paths.map((candidate) => assertSafeCompletionPath(input.projectPath, candidate))));
	if (expected.size === 0) {
		const clean = await gitStatusEntries(input.projectPath, runner, input.signal);
		if (clean.length > 0) throw new Error(`Ledger-only completion requires a clean worktree: ${[...statusPathSet(clean)].join(", ")}`);
		return { paths: [], alreadyCommitted: false };
	}
	const message = completionCommitMessage(input.runId, input.workItemId);
	const expectedParents = input.expectedParentCommitIds === undefined ? [] : await canonicalCommitIds(input.projectPath, input.expectedParentCommitIds, runner, input.signal);
	const assertExpectedParent = async (head: string): Promise<void> => {
		if (expectedParents.length === 0) return;
		const parent = await command(runner, ["rev-parse", "--verify", `${head}^`], input.projectPath, input.signal);
		for (const expected of expectedParents) {
			if (!(await isAncestor(runner, expected, parent, input.projectPath, input.signal))) throw new Error("Completion commit is not immediately after the accepted worker history.");
		}
	};
	const initial = await gitStatusEntries(input.projectPath, runner, input.signal);
	if (initial.length > 0) {
		// Recovery may arrive after mutation or after `git add`; accept only the
		// exact declared set.  Anything else is an immediate security failure.
		assertOnlyExpectedChanges(initial, expected, false);
	}
	const headMessageResult = await runner.run(["log", "-1", "--format=%s", "HEAD"], input.projectPath, input.signal);
	if (headMessageResult.code === 0 && headMessageResult.stdout.trim() === message && initial.length === 0) {
		const existingHead = await gitHead(input.projectPath, runner, input.signal);
		if (!existingHead) throw new Error("Existing completion commit has no reachable HEAD.");
		await assertExpectedParent(existingHead);
		const changed = await commitChangedPaths(input.projectPath, runner, input.signal);
		if (new Set(changed).size !== expected.size || changed.some((candidate) => !expected.has(candidate))) throw new Error("Existing completion commit contains undeclared paths.");
		const commitId = await gitHead(input.projectPath, runner, input.signal);
		if (!commitId) throw new Error("Existing completion commit has no reachable ID.");
		return { commitId, paths: [...expected], alreadyCommitted: true };
	}
	if (initial.length === 0) return { paths: [...expected], alreadyCommitted: false };
	const add = await runner.run(["add", "--", ...expected], input.projectPath, input.signal);
	if (add.code !== 0) throw new Error(`git add completion paths failed: ${add.stderr.trim() || "unknown error"}`);
	const staged = await gitStatusEntries(input.projectPath, runner, input.signal);
	assertOnlyExpectedChanges(staged, expected, true);
	const commit = await runner.run(["commit", "--no-verify", "--no-gpg-sign", "-m", message], input.projectPath, input.signal);
	if (commit.code !== 0) throw new Error(`git completion commit failed: ${commit.stderr.trim() || "unknown error"}`);
	const commitId = await gitHead(input.projectPath, runner, input.signal);
	if (!commitId) throw new Error("Git completion commit succeeded without a reachable HEAD.");
	await assertExpectedParent(commitId);
	const changed = await commitChangedPaths(input.projectPath, runner, input.signal);
	if (new Set(changed).size !== expected.size || changed.some((candidate) => !expected.has(candidate))) throw new Error("Git completion commit contains undeclared paths.");
	const after = await gitStatusEntries(input.projectPath, runner, input.signal);
	if (after.length > 0) throw new Error(`Git completion commit left the worktree dirty: ${[...statusPathSet(after)].join(", ")}`);
	return { commitId, paths: [...expected], alreadyCommitted: false };
}

async function canonicalCommitId(cwd: string, commit: string, runner: GitCommandRunner, signal?: AbortSignal): Promise<string> {
	const value = exactCommitHash(commit);
	// Hashes are validated before interpolation, and --end-of-options prevents
	// any future Git option parsing if this boundary is changed.
	return nonEmpty(await command(runner, ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`], cwd, signal), "resolved commit ID").toLowerCase();
}

export async function canonicalCommitIds(cwd: string, commitIds: readonly string[], runner: GitCommandRunner = nodeGitRunner, signal?: AbortSignal): Promise<readonly string[]> {
	if (!(await isGitRepository(cwd))) throw new Error("Git commit tracking requires a repository.");
	if (new Set(commitIds).size !== commitIds.length) throw new Error("Reported commit IDs must be unique within the active attempt.");
	const resolved: string[] = [];
	for (const commit of commitIds) resolved.push(await canonicalCommitId(cwd, commit, runner, signal));
	if (new Set(resolved).size !== resolved.length) throw new Error("Reported commit IDs must resolve to unique commits.");
	return resolved;
}

/**
 * Validate only the safe, exact commit-ish boundary. The contextual ancestry
 * checks live in validateAcceptedCommitIds so callers cannot accidentally use
 * existence-only validation for acceptance.
 */
export async function validateCommitIds(cwd: string, commitIds: readonly string[], runner: GitCommandRunner = nodeGitRunner, signal?: AbortSignal): Promise<void> {
	await canonicalCommitIds(cwd, commitIds, runner, signal);
}

async function isAncestor(runner: GitCommandRunner, ancestor: string, descendant: string, cwd: string, signal?: AbortSignal): Promise<boolean> {
	const result = await runner.run(["merge-base", "--is-ancestor", ancestor, descendant], cwd, signal);
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	throw new Error(`git merge-base --is-ancestor failed: ${result.stderr.trim() || "unknown error"}`);
}

/** Validate report commits again while a completion transaction is being
 * recovered. Unlike first acceptance, the expected mutation may already make
 * the worktree dirty, and a worker commit may already be in the accepted set. */
export async function validateAttemptCommitIds(
	cwd: string,
	state: GitRunState,
	commitIds: readonly string[],
	runner: GitCommandRunner = nodeGitRunner,
	signal?: AbortSignal,
): Promise<readonly string[]> {
	if (!(await isGitRepository(cwd))) throw new Error("Git commit tracking requires a repository.");
	if (new Set(commitIds).size !== commitIds.length) throw new Error("Reported commit IDs must be unique within the active attempt.");
	const branch = await command(runner, ["branch", "--show-current"], cwd, signal);
	if (branch !== state.workflowBranch) throw new Error(`Acceptance requires the dedicated workflow branch ${state.workflowBranch}; current branch is ${branch || "detached"}.`);
	const head = await canonicalCommitId(cwd, await command(runner, ["rev-parse", "HEAD"], cwd, signal), runner, signal);
	const baseline = await canonicalCommitId(cwd, state.baselineCommit, runner, signal);
	const attemptBase = state.attemptBaseCommit === undefined ? baseline : await canonicalCommitId(cwd, state.attemptBaseCommit, runner, signal);
	const canonical = await canonicalCommitIds(cwd, commitIds, runner, signal);
	for (const commit of canonical) {
		if (commit === baseline || commit === attemptBase) throw new Error(`Commit ${commit} introduced no new work during the active attempt.`);
		if (!(await isAncestor(runner, baseline, commit, cwd, signal))) throw new Error(`Commit ${commit} is not a descendant of the run baseline.`);
		if (!(await isAncestor(runner, attemptBase, commit, cwd, signal))) throw new Error(`Commit ${commit} was not introduced after the active implementation/fix attempt began.`);
		if (!(await isAncestor(runner, commit, head, cwd, signal))) throw new Error(`Commit ${commit} is not reachable from the workflow branch current HEAD.`);
	}
	return canonical;
}

/**
 * Acceptance boundary for implementation/fix reports. Every commit must be a
 * new descendant of the run baseline, reachable from the dedicated workflow
 * branch and current HEAD, and the checkout must still be clean. No staging or
 * automatic repair is performed here; unrelated changes are rejected.
 */
export async function validateAcceptedCommitIds(
	cwd: string,
	state: GitRunState,
	commitIds: readonly string[],
	runner: GitCommandRunner = nodeGitRunner,
	signal?: AbortSignal,
): Promise<readonly string[]> {
	if (!(await isGitRepository(cwd))) throw new Error("Git commit tracking requires a repository.");
	const changed = await statusFiles(cwd, runner, signal);
	if (changed.length > 0) throw new Error(`Worktree must be clean at acceptance; changed paths: ${changed.join(", ")}`);
	const branch = await command(runner, ["branch", "--show-current"], cwd, signal);
	if (branch !== state.workflowBranch) throw new Error(`Acceptance requires the dedicated workflow branch ${state.workflowBranch}; current branch is ${branch || "detached"}.`);
	const head = await canonicalCommitId(cwd, await command(runner, ["rev-parse", "HEAD"], cwd, signal), runner, signal);
	const baseline = await canonicalCommitId(cwd, state.baselineCommit, runner, signal);
	const attemptBase = state.attemptBaseCommit === undefined ? baseline : await canonicalCommitId(cwd, state.attemptBaseCommit, runner, signal);
	const alreadyAccepted = new Set(await canonicalCommitIds(cwd, state.acceptedCommitIds, runner, signal));
	const canonical = await canonicalCommitIds(cwd, commitIds, runner, signal);
	for (const commit of canonical) {
		if (alreadyAccepted.has(commit)) throw new Error(`Commit ${commit} was already accepted by this run.`);
		if (commit === baseline) throw new Error(`Commit ${commit} is the run baseline and introduced no new work.`);
		if (commit === attemptBase) throw new Error(`Commit ${commit} introduced no new work during the active attempt.`);
		if (!(await isAncestor(runner, baseline, commit, cwd, signal))) throw new Error(`Commit ${commit} is not a descendant of the run baseline.`);
		if (!(await isAncestor(runner, attemptBase, commit, cwd, signal))) throw new Error(`Commit ${commit} was not introduced after the active implementation/fix attempt began.`);
		if (!(await isAncestor(runner, commit, head, cwd, signal))) throw new Error(`Commit ${commit} is not reachable from the workflow branch current HEAD.`);
	}
	return canonical;
}

/** Validate commits already persisted in a completion history without applying
 * the "new during this attempt" rule used for a worker report. */
export async function validateAcceptedCommitHistory(
	cwd: string,
	state: GitRunState,
	commitIds: readonly string[],
	runner: GitCommandRunner = nodeGitRunner,
	signal?: AbortSignal,
): Promise<readonly string[]> {
	if (!(await isGitRepository(cwd))) throw new Error("Git completion history requires a repository.");
	const changed = await statusFiles(cwd, runner, signal);
	if (changed.length > 0) throw new Error(`Worktree must be clean while validating completion history; changed paths: ${changed.join(", ")}`);
	const branch = await command(runner, ["branch", "--show-current"], cwd, signal);
	if (branch !== state.workflowBranch) throw new Error(`Completion history requires the dedicated workflow branch ${state.workflowBranch}.`);
	const canonical = await canonicalCommitIds(cwd, commitIds, runner, signal);
	const persisted = new Set((await canonicalCommitIds(cwd, state.acceptedCommitIds, runner, signal)).map((commit) => commit.toLowerCase()));
	const head = await canonicalCommitId(cwd, await command(runner, ["rev-parse", "HEAD"], cwd, signal), runner, signal);
	for (const commit of canonical) {
		if (!persisted.has(commit)) throw new Error(`Completion commit ${commit} is not in the persisted accepted commit set.`);
		if (!(await isAncestor(runner, state.baselineCommit, commit, cwd, signal)) || !(await isAncestor(runner, commit, head, cwd, signal))) {
			throw new Error(`Persisted completion commit ${commit} is not a reachable descendant of the workflow baseline.`);
		}
	}
	return canonical;
}

export async function assertGitReadyForAudit(cwd: string, state: GitRunState, runner: GitCommandRunner = nodeGitRunner, signal?: AbortSignal): Promise<void> {
	if (!(await isGitRepository(cwd))) return;
	const changed = await statusFiles(cwd, runner, signal);
	if (changed.length > 0) throw new Error(`Worktree must be clean before audit; changed paths: ${changed.join(", ")}`);
	const branch = await command(runner, ["branch", "--show-current"], cwd, signal);
	if (branch !== state.workflowBranch) throw new Error(`Audit requires the dedicated workflow branch ${state.workflowBranch}; current branch is ${branch || "detached"}.`);
	const canonicalAccepted = await canonicalCommitIds(cwd, state.acceptedCommitIds, runner, signal);
	if (new Set(canonicalAccepted).size !== canonicalAccepted.length) throw new Error("Accepted Git commits must be unique before audit.");
	const head = await canonicalCommitId(cwd, await command(runner, ["rev-parse", "HEAD"], cwd, signal), runner, signal);
	for (const commit of canonicalAccepted) {
		if (!(await isAncestor(runner, state.baselineCommit, commit, cwd, signal)) || !(await isAncestor(runner, commit, head, cwd, signal))) {
			throw new Error(`Accepted commit ${commit} is not a reachable descendant of the baseline at audit time.`);
		}
	}
}

export function mergeAcceptedCommitIds(state: GitRunState, commitIds: readonly string[], currentHead?: string): GitRunState {
	const normalized = commitIds.map((commit) => exactCommitHash(commit));
	if (new Set(normalized).size !== normalized.length) throw new Error("Accepted Git commit IDs must be unique.");
	if (normalized.some((commit) => state.acceptedCommitIds.includes(commit))) throw new Error("Accepted Git commit IDs must not be repeated across work items.");
	return {
		...state,
		acceptedCommitIds: [...state.acceptedCommitIds, ...normalized],
		...(currentHead === undefined ? {} : { currentHead }),
	};
}

export function acceptedCommitRange(state: GitRunState | undefined): string {
	if (!state || state.acceptedCommitIds.length === 0) return "(no accepted commits)";
	return state.acceptedCommitIds.join(" ");
}

export function runGitPreflight(cwd: string, runId: string, runner?: GitCommandRunner, signal?: AbortSignal): Effect.Effect<GitPreflight | undefined, Error> {
	return Effect.tryPromise({ try: () => gitPreflight(cwd, runId, runner, signal), catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)) });
}
