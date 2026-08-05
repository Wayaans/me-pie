import { readdir } from "node:fs/promises";
import { Effect } from "effect";
import type { WorkerIdentity, WorkflowRun } from "./domain.ts";
import { inspectProjectLock, type ProjectLockStatus } from "./lock.ts";
import { pathsForProject, resolveWorkflowPaths, type WorkflowPaths } from "./paths.ts";
import { loadRun } from "./state-store.ts";
import type { TmuxController, TmuxWindowInspection } from "./tmux/controller.ts";

const FINISHED_PHASES = new Set<WorkflowRun["phase"]>(["completed", "stopped"]);

function recoveryErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "object" && error !== null) {
		const value = error as { readonly _tag?: unknown; readonly path?: unknown; readonly expected?: unknown; readonly actual?: unknown; readonly operation?: unknown; readonly message?: unknown; readonly cause?: unknown };
		if (typeof value.message === "string" && value.message) return value.message;
		if (value._tag === "UnsupportedVersionError") return `Unsupported schema version ${String(value.actual)} in ${String(value.path)}; expected ${String(value.expected)}. Migrate the run or restore a compatible Ticket Flow version`;
		if (value._tag === "CorruptDataError") return `Corrupt durable state at ${String(value.path)}: ${String(value.message)}`;
		if (value._tag === "PersistenceError") return `Durable persistence ${String(value.operation)} failed at ${String(value.path)}: ${String(value.cause)}`;
		if (typeof value._tag === "string") return value._tag;
	}
	return String(error);
}

export interface RecoverableRun {
	readonly run: WorkflowRun;
	readonly paths: WorkflowPaths;
	readonly lock: ProjectLockStatus;
}

export interface RecoveryDiscovery {
	readonly runs: readonly RecoverableRun[];
	readonly invalidRunIds: readonly string[];
	/** Actionable errors are retained instead of silently disappearing runs. */
	readonly invalidRunIssues?: readonly { readonly runId: string; readonly message: string }[];
}

export type ReconciliationKind =
	| "safe-to-resume"
	| "worker-alive-disconnected"
	| "worker-exited-pending-report"
	| "window-missing"
	| "profile-mismatch"
	| "foreign-tmux-id"
	| "ambiguous";

export interface RecoveryReconciliation {
	readonly kind: ReconciliationKind;
	readonly safe: boolean;
	readonly message: string;
	readonly tmux?: TmuxWindowInspection;
}

export function discoverUnfinishedRuns(
	projectPath: string,
	options: { readonly agentDir?: string; readonly sessionId?: string } = {},
): Effect.Effect<RecoveryDiscovery, Error> {
	return Effect.gen(function* () {
		const resolved = yield* pathsForProject(projectPath, "discovery", options.agentDir);
		const entries = yield* Effect.tryPromise({
			try: async () => {
				try { return await readdir(resolved.paths.projectDir, { withFileTypes: true }); }
				catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return []; throw cause; }
			},
			catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
		});
		const runs: RecoverableRun[] = [];
		const invalidRunIds: string[] = [];
		const invalidRunIssues: { runId: string; message: string }[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const paths = yield* resolveWorkflowPaths(resolved.canonicalProjectPath, entry.name, resolved.paths.agentDir);
			const loaded = yield* Effect.result(loadRun(paths));
			if (loaded._tag === "Failure") {
				invalidRunIds.push(entry.name);
				invalidRunIssues.push({ runId: entry.name, message: recoveryErrorMessage(loaded.failure) });
				continue;
			}
			if (FINISHED_PHASES.has(loaded.success.phase)) continue;
			const lock = yield* inspectProjectLock(paths.rootDir, paths.projectId, {
				runId: loaded.success.id,
				...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
				...(loaded.success.orchestratorSessionId === undefined ? {} : { expectedOwnerSessionId: loaded.success.orchestratorSessionId }),
			});
			runs.push({ run: loaded.success, paths, lock });
		}
		return { runs: runs.sort((left, right) => right.run.updatedAt.localeCompare(left.run.updatedAt)), invalidRunIds, invalidRunIssues };
	});
}

function hasDurablePendingReport(status: WorkflowRun["plan"]["workItems"][number]["status"]): boolean {
	return status === "report-review" || status === "report-pending" || status === "completed";
}

function requestedProfileMatches(run: WorkflowRun): boolean {
	if (!run.worker || !run.requestedLaunchProfile) return true;
	const slash = run.requestedLaunchProfile.model.indexOf("/");
	return run.worker.provider === run.requestedLaunchProfile.model.slice(0, slash)
		&& run.worker.model === run.requestedLaunchProfile.model.slice(slash + 1)
		&& run.worker.thinking === run.requestedLaunchProfile.thinking;
}

export function reconcileRecovery(
	run: WorkflowRun,
	tmux: Pick<TmuxController, "inspectWindow">,
	protocolIdentity?: WorkerIdentity,
): Effect.Effect<RecoveryReconciliation> {
	return Effect.gen(function* () {
		if (run.phase === "failed") return { kind: "ambiguous", safe: false, message: "Failed runs require an explicit stop or manual plan decision before recovery." } as const;
		if ((run.protocolCommands ?? []).some((command) => !command.acknowledged && command.type === "feedback")) {
			return { kind: "ambiguous", safe: false, message: "Unacknowledged feedback cannot be reconstructed without user confirmation." } as const;
		}
		if (!requestedProfileMatches(run)) {
			return { kind: "profile-mismatch", safe: false, message: "Persisted requested and actual worker profiles do not match." } as const;
		}
		if (!run.activeWorkItemId) {
			if (run.tmux || run.worker) return { kind: "ambiguous", safe: false, message: "Worker metadata exists without an active work item." } as const;
			return { kind: "safe-to-resume", safe: true, message: "No active worker needs reconciliation." } as const;
		}
		const item = run.plan.workItems.find((candidate) => candidate.id === run.activeWorkItemId);
		if (!item || !run.tmux || run.tmux.runId !== run.id || run.tmux.workItemId !== item.id) {
			return { kind: "ambiguous", safe: false, message: "The active work item and persisted tmux ownership metadata are incomplete or inconsistent." } as const;
		}
		if (run.worker && (run.worker.runId !== run.id || run.worker.workItemId !== item.id)) {
			return { kind: "ambiguous", safe: false, message: "Persisted worker identity does not match the run and work item." } as const;
		}
		const inspection = yield* tmux.inspectWindow(run.tmux);
		if (inspection.state === "foreign") return { kind: "foreign-tmux-id", safe: false, message: inspection.message ?? "The tmux ID was reused by an unrelated window.", tmux: inspection } as const;
		if (inspection.state === "ambiguous") return { kind: "ambiguous", safe: false, message: inspection.message ?? "Tmux ownership could not be established.", tmux: inspection } as const;
		if (inspection.state === "missing" || inspection.state === "exited") {
			if (hasDurablePendingReport(item.status)) {
				return {
					kind: "worker-exited-pending-report", safe: true,
					message: inspection.state === "missing" ? "The worker exited, but its durable report remains reviewable." : "The worker exited after persisting a report.",
					tmux: inspection,
				} as const;
			}
			return {
				kind: "window-missing", safe: false,
				message: inspection.state === "missing" ? "The owned tmux worker window is missing." : "The worker pane exited before a durable report was available.",
				tmux: inspection,
			} as const;
		}
		if (item.status === "completed") return { kind: "safe-to-resume", safe: true, message: "The accepted item can resume its verified tmux close checkpoint.", tmux: inspection } as const;
		if (!protocolIdentity) return { kind: "worker-alive-disconnected", safe: true, message: "The verified owned worker is alive and should reconnect to the recreated socket.", tmux: inspection } as const;
		const protocolMatches = protocolIdentity.runId === run.id
			&& protocolIdentity.workItemId === item.id
			&& (!run.worker?.sessionId || protocolIdentity.sessionId === run.worker.sessionId)
			&& (!run.worker?.sessionFile || protocolIdentity.sessionFile === run.worker.sessionFile);
		if (!protocolMatches) return { kind: "ambiguous", safe: false, message: "Connected worker session identity does not match persisted recovery state.", tmux: inspection } as const;
		return { kind: "safe-to-resume", safe: true, message: "Tmux ownership and native worker identity are verified.", tmux: inspection } as const;
	});
}
