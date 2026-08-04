import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { assertCommandPrerequisites, ORCHESTRATOR_KICKOFF, parseTicketFlowCommand, RECOVERY_KICKOFF } from "./command.ts";
import { WorkflowController } from "./controller.ts";
import { appendOrchestratorSystemPrompt } from "./orchestrator/system-prompt.ts";
import { registerOrchestratorTools } from "./orchestrator/tools.ts";
import { discoverOrchestratorRecovery, recoverWithConfirmation } from "./orchestrator/lifecycle.ts";
import { detectWorkflowRole, isTicketFlowInvocation } from "./role.ts";
import type { WorkflowRun } from "./domain.ts";
import { prepareWorkerLifecycle, type WorkerLifecycle } from "./worker/lifecycle.ts";
import { registerWorkerTools } from "./worker/tools.ts";
import { TmuxController } from "./tmux/controller.ts";

export const WORKER_SYSTEM_PROMPT = `## Ticket Flow worker role

- Work only on the delegated work item.
- Use normal tools and follow all project instructions.
- Call workflow_context after context loss or whenever the delegated scope is uncertain.
- Call workflow_submit_report for progress, blockers, failure, and final completion.
- Do not mark ticket files complete; the orchestrator owns completion recording.
- Do not claim a check passed unless you ran it.`;

export function appendWorkerSystemPrompt(systemPrompt: string): string {
	return `${systemPrompt}\n\n${WORKER_SYSTEM_PROMPT}`;
}

export function workflowFooterStatus(run: WorkflowRun): string {
	if (run.phase === "ready") return `ticket-flow · ready · ${run.plan.workItems.length} items`;
	if (run.phase === "awaiting-user") return "ticket-flow · awaiting user";
	return `ticket-flow · ${run.phase}`;
}

function updateStatus(ctx: ExtensionContext, run: WorkflowRun | undefined): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus("ticket-flow", run === undefined ? undefined : workflowFooterStatus(run));
}

function notifyError(ctx: ExtensionContext, error: unknown): void {
	if (!ctx.hasUI) return;
	const message = error instanceof Error ? error.message : String(error);
	ctx.ui.notify(message, "error");
}

export interface TicketFlowExtensionOptions {
	readonly tmux?: TmuxController;
}

export default function ticketFlow(pi: ExtensionAPI, options: TicketFlowExtensionOptions = {}): void {
	const role = detectWorkflowRole();
	if (role === "worker") {
		let lifecycle: WorkerLifecycle | undefined;
		registerWorkerTools(pi, () => lifecycle);
		pi.on("session_start", async (_event, ctx) => {
			lifecycle = await Effect.runPromise(prepareWorkerLifecycle(), { signal: ctx.signal });
			await Effect.runPromise(lifecycle.start(pi, ctx), { signal: ctx.signal });
		});
		pi.on("before_agent_start", (event) => ({ systemPrompt: appendWorkerSystemPrompt(event.systemPrompt) }));
		pi.on("input", (event, ctx) => {
			if (!isTicketFlowInvocation(event.text)) return;
			if (ctx.hasUI) ctx.ui.notify("A Ticket Flow worker cannot start a nested workflow.", "error");
			return { action: "handled" as const };
		});
		pi.on("session_shutdown", async () => {
			if (!lifecycle) return;
			// Shutdown cleanup must finish even when the turn AbortSignal is already aborted.
			await Effect.runPromise(lifecycle.shutdown());
		});
		return;
	}

	const controller = new WorkflowController(pi, undefined, undefined, options.tmux);
	registerOrchestratorTools(pi, controller);

	pi.on("session_start", async (_event, ctx) => {
		try { await discoverOrchestratorRecovery(controller, ctx); }
		catch (error) { notifyError(ctx, error); }
	});

	pi.registerCommand("ticket-flow", {
		description: "Analyze and orchestrate tickets in a tmux-backed Ticket Flow run",
		handler: async (args, ctx) => {
			try {
				const command = parseTicketFlowCommand(args);
				assertCommandPrerequisites({ mode: ctx.mode, tmux: process.env.TMUX });
				await Effect.runPromise(controller.verifyTmux(), { signal: ctx.signal });
				const discovery = await Effect.runPromise(controller.discover(ctx.cwd, undefined, ctx.sessionManager.getSessionId()), { signal: ctx.signal });
				if (discovery.runs.length > 0) {
					if (!ctx.hasUI) throw new Error("An unfinished Ticket Flow run exists; use workflow_control recover in an interactive session.");
					const choice = await ctx.ui.select("Ticket Flow run already exists", ["Recover existing run", "Cancel"]);
					if (choice !== "Recover existing run") return;
					const recovered = await recoverWithConfirmation(controller, ctx);
					updateStatus(ctx, recovered);
					pi.appendEntry("ticket-flow-state", { run: recovered });
					if (recovered.phase !== "stopped") pi.sendUserMessage(RECOVERY_KICKOFF);
					return;
				}
				const run = await Effect.runPromise(controller.startRun({
					cwd: ctx.cwd,
					prompt: command.prompt,
					sessionId: ctx.sessionManager.getSessionId(),
				}), { signal: ctx.signal });
				updateStatus(ctx, run);
				pi.appendEntry("ticket-flow-state", { run });
				pi.sendUserMessage(ORCHESTRATOR_KICKOFF);
			} catch (error) {
				notifyError(ctx, error);
			}
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!controller.activeRun) return;
		return { systemPrompt: appendOrchestratorSystemPrompt(event.systemPrompt) };
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		updateStatus(ctx, controller.activeRun);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Detachment is cleanup itself and must not be cancelled by a stale turn signal.
		await Effect.runPromise(controller.shutdown());
		updateStatus(ctx, undefined);
	});
}
