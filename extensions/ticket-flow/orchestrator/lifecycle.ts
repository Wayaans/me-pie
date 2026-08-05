import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { WorkflowController } from "../controller.ts";
import type { RecoverableRun, RecoveryDiscovery } from "../recovery.ts";

export async function discoverOrchestratorRecovery(
	controller: WorkflowController,
	ctx: ExtensionContext,
): Promise<RecoveryDiscovery> {
	const discovery = await Effect.runPromise(controller.discover(
		ctx.cwd,
		undefined,
		ctx.sessionManager.getSessionId(),
	), { signal: ctx.signal });
	if (ctx.hasUI && discovery.runs.length > 0) {
		const newest = discovery.runs[0]!;
		ctx.ui.notify(
			`Recoverable Ticket Flow run ${newest.run.id} exists (${newest.run.phase}). Use /ticket-flow status or /ticket-flow tmux after reviewing the recoverable run.`,
			"warning",
		);
	}
	if (ctx.hasUI && discovery.invalidRunIds.length > 0) {
		ctx.ui.notify("Ticket Flow ignored invalid persisted run state.", "warning");
	}
	return discovery;
}

function runChoiceLabel(candidate: RecoverableRun): string {
	const active = candidate.run.activeWorkItemId === undefined ? "no active worker" : candidate.run.activeWorkItemId;
	return `${candidate.run.id} · ${candidate.run.phase} · ${active} · ${candidate.run.updatedAt}`;
}

export async function selectRecoverableRun(
	discovery: RecoveryDiscovery,
	ctx: ExtensionContext,
	action: "pause" | "resume" | "stop" | "recover",
): Promise<RecoverableRun | undefined> {
	if (discovery.runs.length === 0) return undefined;
	if (discovery.runs.length === 1) return discovery.runs[0];
	if (!ctx.hasUI) throw new Error(`Multiple unfinished Ticket Flow runs exist; ${action} requires interactive run selection.`);
	const choices = discovery.runs.map(runChoiceLabel);
	const selected = await ctx.ui.select(`Select Ticket Flow run to ${action}`, choices);
	if (selected === undefined) return undefined;
	return discovery.runs[choices.indexOf(selected)];
}

export async function confirmActiveWorkerStop(controller: WorkflowController, ctx: ExtensionContext): Promise<boolean> {
	const run = controller.activeRun;
	if (!run?.activeWorkItemId || !run.tmux) return true;
	if (!ctx.hasUI) throw new Error("Stopping an active Ticket Flow worker requires interactive confirmation.");
	return ctx.ui.confirm(
		"Stop Ticket Flow?",
		`Gracefully stop worker ${run.activeWorkItemId}, then close only its verified tmux window?`,
	);
}

export async function resolveRecoveryIssue(controller: WorkflowController, run: NonNullable<WorkflowController["activeRun"]>, ctx: ExtensionContext) {
	if (!run.recoveryIssue) return run;
	if (!ctx.hasUI) return run;
	const choice = await ctx.ui.select(
		"Ticket Flow recovery needs a decision",
		[
			`Keep paused: ${run.recoveryIssue.message}`,
			"Stop safely without closing an unverified tmux window",
		],
	);
	if (choice === "Stop safely without closing an unverified tmux window") return Effect.runPromise(controller.stop(), { signal: ctx.signal });
	return run;
}

export async function recoverWithConfirmation(controller: WorkflowController, ctx: ExtensionContext) {
	const sessionId = ctx.sessionManager.getSessionId();
	const discovery = await Effect.runPromise(controller.discover(ctx.cwd, undefined, sessionId), { signal: ctx.signal });
	const candidate = await selectRecoverableRun(discovery, ctx, "recover");
	if (!candidate) throw new Error(discovery.runs.length === 0 ? "No recoverable Ticket Flow run exists for this project." : "Ticket Flow recovery was cancelled.");
	let allowAmbiguousTakeover = false;
	if (candidate.lock.state === "ambiguous") {
		if (!ctx.hasUI) throw new Error("Ambiguous Ticket Flow lock ownership requires interactive approval.");
		allowAmbiguousTakeover = await ctx.ui.confirm(
			"Take over ambiguous Ticket Flow lock?",
			`${candidate.lock.reason} Recovery will record the takeover and will not close any unverified tmux window.`,
		);
		if (!allowAmbiguousTakeover) throw new Error("Ticket Flow recovery was cancelled.");
	}
	const recovered = await Effect.runPromise(controller.recover({
		cwd: ctx.cwd,
		runId: candidate.run.id,
		...(sessionId === undefined ? {} : { sessionId }),
		...(allowAmbiguousTakeover ? { allowAmbiguousTakeover: true } : {}),
	}), { signal: ctx.signal });
	return resolveRecoveryIssue(controller, recovered, ctx);
}
