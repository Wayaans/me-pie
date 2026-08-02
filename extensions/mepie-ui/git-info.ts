import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Fiber, Schedule } from "effect";
import {
	GIT_INFO_CHANNEL,
	emptyGitInfoState,
	type PullRequestInfo,
} from "./dashboard-state.ts";

const POLL_INTERVAL_MS = 3_000;
const GIT_TIMEOUT_MS = 3_000;
const GH_TIMEOUT_MS = 10_000;

function countChangedFiles(status: string): number {
	return status.split("\n").filter(Boolean).length;
}

function parsePullRequest(value: unknown): PullRequestInfo | null {
	if (typeof value !== "object" || value === null) return null;
	if (!("number" in value) || typeof value.number !== "number") return null;
	if (!("url" in value) || typeof value.url !== "string") return null;
	if (!("state" in value) || value.state !== "OPEN") return null;
	return {
		number: value.number,
		url: value.url,
		isDraft: "isDraft" in value && value.isDraft === true,
	};
}

export function parsePullRequestJson(value: string): PullRequestInfo | null {
	try {
		return parsePullRequest(JSON.parse(value));
	} catch {
		return null;
	}
}

function runCommand(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	command: string,
	args: string[],
	timeout: number,
) {
	return Effect.tryPromise({
		try: (signal) => pi.exec(command, args, { cwd: ctx.cwd, signal, timeout }),
		catch: (cause) => new Error(`Failed to run ${command}: ${String(cause)}`),
	});
}

export default function registerGitInfo(pi: ExtensionAPI): void {
	let state = emptyGitInfoState();
	let currentContext: ExtensionContext | undefined;
	let pollingFiber: Fiber.Fiber<void> | undefined;
	const refreshFibers = new Set<Fiber.Fiber<void>>();
	let generation = 0;
	let queriedPrBranch: string | null = null;

	const publish = () => pi.events.emit(GIT_INFO_CHANNEL, { ...state });

	const refresh = (ctx: ExtensionContext, refreshGeneration: number) =>
		Effect.gen(function* () {
			const repo = yield* runCommand(
				pi,
				ctx,
				"git",
				["rev-parse", "--is-inside-work-tree"],
				GIT_TIMEOUT_MS,
			);
			if (refreshGeneration !== generation) return;
			if (repo.code !== 0 || repo.stdout.trim() !== "true") {
				queriedPrBranch = null;
				state = emptyGitInfoState();
				publish();
				return;
			}

			const [branchResult, headResult, statusResult] = yield* Effect.all(
				[
					runCommand(pi, ctx, "git", ["branch", "--show-current"], GIT_TIMEOUT_MS),
					runCommand(pi, ctx, "git", ["rev-parse", "--short", "HEAD"], GIT_TIMEOUT_MS),
					runCommand(
						pi,
						ctx,
						"git",
						["status", "--porcelain=v1", "--untracked-files=all"],
						GIT_TIMEOUT_MS,
					),
				],
				{ concurrency: "unbounded" },
			);
			if (refreshGeneration !== generation) return;

			const branchName = branchResult.stdout.trim();
			const shortHead = headResult.stdout.trim();
			const branch = branchName || (shortHead ? `detached@${shortHead}` : "detached");
			const branchChanged = branchName !== queriedPrBranch;
			state = {
				isRepository: true,
				branch,
				changedFiles: statusResult.code === 0 ? countChangedFiles(statusResult.stdout) : 0,
				pullRequest: branchChanged ? null : state.pullRequest,
			};
			publish();

			if (!branchName || !branchChanged) {
				if (!branchName) queriedPrBranch = null;
				return;
			}

			queriedPrBranch = branchName;
			const pullRequestResult = yield* runCommand(
				pi,
				ctx,
				"gh",
				["pr", "view", branchName, "--json", "number,url,state,isDraft"],
				GH_TIMEOUT_MS,
			);
			if (refreshGeneration !== generation) return;
			state = {
				...state,
				pullRequest:
					pullRequestResult.code === 0 ? parsePullRequestJson(pullRequestResult.stdout) : null,
			};
			publish();
		}).pipe(Effect.catch(() => Effect.void));

	const refreshInBackground = (ctx: ExtensionContext) => {
		if (refreshFibers.size > 0) return;
		const fiber = Effect.runFork(refresh(ctx, generation));
		refreshFibers.add(fiber);
		void Effect.runPromise(Fiber.await(fiber)).finally(() => refreshFibers.delete(fiber));
	};

	const poll = () =>
		Effect.sync(() => {
			if (currentContext) refreshInBackground(currentContext);
		}).pipe(
			Effect.repeat(Schedule.fixed(POLL_INTERVAL_MS)),
			Effect.delay(POLL_INTERVAL_MS),
			Effect.asVoid,
		);

	pi.on("session_start", async (_event, ctx) => {
		generation += 1;
		currentContext = ctx;
		queriedPrBranch = null;
		if (pollingFiber) await Effect.runPromise(Fiber.interrupt(pollingFiber));
		refreshInBackground(ctx);
		pollingFiber = Effect.runFork(poll());
	});

	pi.on("input", (_event, ctx) => {
		refreshInBackground(ctx);
		return { action: "continue" };
	});
	pi.on("tool_execution_end", (_event, ctx) => refreshInBackground(ctx));

	pi.on("session_shutdown", async () => {
		generation += 1;
		currentContext = undefined;
		const fiber = pollingFiber;
		pollingFiber = undefined;
		if (fiber) await Effect.runPromise(Fiber.interrupt(fiber));
		const activeRefreshes = [...refreshFibers];
		refreshFibers.clear();
		await Effect.runPromise(
			Effect.forEach(activeRefreshes, Fiber.interrupt, { concurrency: "unbounded", discard: true }),
		);
	});
}
