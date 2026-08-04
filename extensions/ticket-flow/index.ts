import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { assertCommandPrerequisites, ORCHESTRATOR_KICKOFF, parseTicketFlowCommand } from "./command.ts";
import { WorkflowController } from "./controller.ts";
import { appendOrchestratorSystemPrompt } from "./orchestrator/system-prompt.ts";
import { registerOrchestratorTools } from "./orchestrator/tools.ts";
import { detectWorkflowRole, isTicketFlowInvocation } from "./role.ts";
import type { WorkflowRun } from "./domain.ts";
import { prepareWorkerLifecycle, type WorkerLifecycle } from "./worker/lifecycle.ts";
import { TmuxController } from "./tmux/controller.ts";

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
		pi.on("session_start", async () => {
			lifecycle = await Effect.runPromise(prepareWorkerLifecycle());
			await Effect.runPromise(lifecycle.start());
		});
		pi.on("input", (event, ctx) => {
			if (!isTicketFlowInvocation(event.text)) return;
			if (ctx.hasUI) ctx.ui.notify("A Ticket Flow worker cannot start a nested workflow.", "error");
			return { action: "handled" as const };
		});
		pi.on("session_shutdown", async () => {
			if (!lifecycle) return;
			await Effect.runPromise(lifecycle.shutdown());
		});
		return;
	}

	const controller = new WorkflowController(pi, undefined, undefined, options.tmux);
	registerOrchestratorTools(pi, controller);

	pi.registerCommand("ticket-flow", {
		description: "Analyze and orchestrate tickets in a tmux-backed Ticket Flow run",
		handler: async (args, ctx) => {
			try {
				const command = parseTicketFlowCommand(args);
				assertCommandPrerequisites({ mode: ctx.mode, tmux: process.env.TMUX });
				await Effect.runPromise(controller.verifyTmux(), { signal: ctx.signal });
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
		await Effect.runPromise(controller.shutdown(), { signal: ctx.signal });
		updateStatus(ctx, undefined);
	});
}
