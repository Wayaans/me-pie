import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitState } from "./model.ts";

const execFileAsync = promisify(execFile);
const COMMIT = /^[0-9a-fA-F]{4,64}$/;

export interface GitRunner {
	run(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number }>;
}

export const nodeGitRunner: GitRunner = {
	async run(args, cwd, signal) {
		try {
			const result = await execFileAsync("git", [...args], { cwd, signal, encoding: "utf8" });
			return { stdout: result.stdout, stderr: result.stderr, code: 0 };
		} catch (cause) {
			const error = cause as Error & { readonly stdout?: string; readonly stderr?: string; readonly code?: number };
			return { stdout: error.stdout ?? "", stderr: error.stderr ?? error.message, code: typeof error.code === "number" ? error.code : 1 };
		}
	},
};

async function command(cwd: string, args: readonly string[], runner: GitRunner, signal?: AbortSignal): Promise<string> {
	const result = await runner.run(args, cwd, signal);
	if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || "unknown error"}`);
	return result.stdout.trim();
}

export async function gitStatus(cwd: string, runner: GitRunner = nodeGitRunner, signal?: AbortSignal): Promise<readonly string[]> {
	const output = await command(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], runner, signal);
	if (!output) return [];
	return output.split("\0").filter(Boolean).map((entry) => entry.slice(3));
}

export async function assertCleanWorktree(cwd: string, runner: GitRunner = nodeGitRunner, signal?: AbortSignal): Promise<void> {
	const changed = await gitStatus(cwd, runner, signal);
	if (changed.length > 0) throw new Error(`Ticket Flow requires a clean worktree; changed paths: ${changed.join(", ")}`);
}

export async function gitHead(cwd: string, runner: GitRunner = nodeGitRunner, signal?: AbortSignal): Promise<string> {
	return command(cwd, ["rev-parse", "--verify", "HEAD"], runner, signal);
}

export async function gitBranch(cwd: string, runner: GitRunner = nodeGitRunner, signal?: AbortSignal): Promise<string> {
	const branch = await command(cwd, ["branch", "--show-current"], runner, signal);
	if (!branch) throw new Error("Ticket Flow cannot run on a detached HEAD.");
	return branch;
}

export async function gitPreflight(cwd: string, runner: GitRunner = nodeGitRunner, signal?: AbortSignal): Promise<GitState> {
	const inside = await runner.run(["rev-parse", "--is-inside-work-tree"], cwd, signal);
	if (inside.code !== 0 || inside.stdout.trim() !== "true") throw new Error("Ticket Flow requires a Git worktree.");
	await assertCleanWorktree(cwd, runner, signal);
	const baselineCommit = await gitHead(cwd, runner, signal);
	const branch = await gitBranch(cwd, runner, signal);
	return { baselineCommit, branch, acceptedCommitIds: [], acceptedHead: baselineCommit };
}

async function canonicalCommit(cwd: string, value: string, runner: GitRunner, signal?: AbortSignal): Promise<string> {
	if (!COMMIT.test(value)) throw new Error(`Invalid commit ID: ${value}`);
	return command(cwd, ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`], runner, signal);
}

async function isAncestor(cwd: string, ancestor: string, descendant: string, runner: GitRunner, signal?: AbortSignal): Promise<boolean> {
	const result = await runner.run(["merge-base", "--is-ancestor", ancestor, descendant], cwd, signal);
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	throw new Error(`git merge-base failed: ${result.stderr.trim()}`);
}

export async function assertAttemptReady(cwd: string, state: GitState, runner: GitRunner = nodeGitRunner, signal?: AbortSignal): Promise<string> {
	await assertCleanWorktree(cwd, runner, signal);
	const branch = await gitBranch(cwd, runner, signal);
	if (branch !== state.branch) throw new Error(`Assignment requires persisted branch ${state.branch}, found ${branch}.`);
	const head = await canonicalCommit(cwd, await gitHead(cwd, runner, signal), runner, signal);
	const expected = await canonicalCommit(cwd, state.acceptedHead, runner, signal);
	if (head !== expected) throw new Error("Assignment HEAD must exactly equal the latest accepted tip before launch.");
	return head;
}

export interface VerifiedCommits {
	readonly commitIds: readonly string[];
	readonly head: string;
}

export async function verifyWorkerCommits(input: {
	readonly cwd: string;
	readonly state: GitState;
	readonly attemptBaseCommit: string;
	readonly reportedCommitIds: readonly string[];
	readonly runner?: GitRunner;
	readonly signal?: AbortSignal;
}): Promise<VerifiedCommits> {
	const runner = input.runner ?? nodeGitRunner;
	await assertCleanWorktree(input.cwd, runner, input.signal);
	const branch = await gitBranch(input.cwd, runner, input.signal);
	if (branch !== input.state.branch) throw new Error(`Worker changed branches: expected ${input.state.branch}, found ${branch}.`);
	if (input.reportedCommitIds.length === 0) throw new Error("Completed implementation/fix reports require at least one commit ID.");
	if (new Set(input.reportedCommitIds).size !== input.reportedCommitIds.length) throw new Error("Reported commit IDs must be unique.");
	const head = await canonicalCommit(input.cwd, await gitHead(input.cwd, runner, input.signal), runner, input.signal);
	const baseline = await canonicalCommit(input.cwd, input.state.baselineCommit, runner, input.signal);
	const attemptBase = await canonicalCommit(input.cwd, input.attemptBaseCommit, runner, input.signal);
	const accepted = new Set(await Promise.all(input.state.acceptedCommitIds.map((commit) => canonicalCommit(input.cwd, commit, runner, input.signal))));
	const commitIds = await Promise.all(input.reportedCommitIds.map((commit) => canonicalCommit(input.cwd, commit, runner, input.signal)));
	if (new Set(commitIds).size !== commitIds.length) throw new Error("Reported commit IDs resolve to duplicate commits.");
	for (const commit of commitIds) {
		if (commit === baseline || commit === attemptBase || accepted.has(commit)) throw new Error(`Commit ${commit} is not new for this assignment.`);
		if (!await isAncestor(input.cwd, baseline, commit, runner, input.signal)) throw new Error(`Commit ${commit} is outside the run history.`);
		if (!await isAncestor(input.cwd, attemptBase, commit, runner, input.signal)) throw new Error(`Commit ${commit} predates the active assignment.`);
		if (!await isAncestor(input.cwd, commit, head, runner, input.signal)) throw new Error(`Commit ${commit} is not reachable from current HEAD.`);
	}
	if (!commitIds.includes(head)) throw new Error("Reported commit IDs must include current HEAD as the exact accepted tip.");
	const exactHistory = (await command(input.cwd, ["rev-list", "--reverse", `${attemptBase}..${head}`], runner, input.signal)).split("\n").filter(Boolean);
	if (exactHistory.length !== commitIds.length || exactHistory.some((commit, index) => commit !== commitIds[index])) {
		throw new Error("Reported commit IDs must exactly equal every commit introduced by the active assignment in chronological order.");
	}
	return { commitIds, head };
}

export async function assertExactAuditScope(input: {
	readonly cwd: string;
	readonly state: GitState;
	readonly acceptedCommitIds: readonly string[];
	readonly acceptedHead: string;
	readonly runner?: GitRunner;
	readonly signal?: AbortSignal;
}): Promise<void> {
	const runner = input.runner ?? nodeGitRunner;
	await assertCleanWorktree(input.cwd, runner, input.signal);
	if (await gitBranch(input.cwd, runner, input.signal) !== input.state.branch) throw new Error("Audit checkout branch does not match the persisted workflow branch.");
	const head = await canonicalCommit(input.cwd, await gitHead(input.cwd, runner, input.signal), runner, input.signal);
	const expectedHead = await canonicalCommit(input.cwd, input.acceptedHead, runner, input.signal);
	if (head !== expectedHead) throw new Error("Audit HEAD does not exactly match the accepted implementation/fix tip.");
	if (input.acceptedCommitIds.length !== input.state.acceptedCommitIds.length || input.acceptedCommitIds.some((commit, index) => commit !== input.state.acceptedCommitIds[index])) {
		throw new Error("Audit accepted commit set differs from durable Git state.");
	}
	const canonical = await Promise.all(input.acceptedCommitIds.map((commit) => canonicalCommit(input.cwd, commit, runner, input.signal)));
	if (new Set(canonical).size !== canonical.length || !canonical.includes(expectedHead)) throw new Error("Audit accepted commit set must be unique and contain exact accepted HEAD.");
	for (const commit of canonical) if (!await isAncestor(input.cwd, input.state.baselineCommit, commit, runner, input.signal) || !await isAncestor(input.cwd, commit, head, runner, input.signal)) throw new Error(`Audit commit ${commit} is outside the accepted history.`);
	const exactHistory = (await command(input.cwd, ["rev-list", "--reverse", `${input.state.baselineCommit}..${expectedHead}`], runner, input.signal)).split("\n").filter(Boolean);
	if (exactHistory.length !== canonical.length || exactHistory.some((commit, index) => commit !== canonical[index])) throw new Error("Audit accepted commit set must exactly equal the complete implementation/fix history.");
}
