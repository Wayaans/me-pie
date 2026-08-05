import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { assertCommandPrerequisites, ORCHESTRATOR_KICKOFF, parseTicketFlowCommand, RECOVERY_KICKOFF, ticketFlowArgumentCompletions } from "./command.ts";
import { WorkflowController } from "./controller.ts";
import { appendOrchestratorSystemPrompt } from "./orchestrator/system-prompt.ts";
import { registerOrchestratorTools } from "./orchestrator/tools.ts";
import { discoverOrchestratorRecovery, recoverWithConfirmation, confirmActiveWorkerStop, resolveRecoveryIssue, selectRecoverableRun } from "./orchestrator/lifecycle.ts";
import { detectWorkflowRole, isTicketFlowInvocation } from "./role.ts";
import type { WorkflowRun } from "./domain.ts";
import { prepareWorkerLifecycle, type WorkerLifecycle } from "./worker/lifecycle.ts";
import { registerWorkerTools } from "./worker/tools.ts";
import { TmuxController } from "./tmux/controller.ts";
import { filterWorkflowToolContext, isWorkflowToolAllowed, isWorkflowToolName, toolsForWorkflowRole, withoutWorkflowTools } from "./tool-names.ts";
import { WORKFLOW_WIDGET_KEY, WorkflowTaskListWidget, renderWorkflowWidget } from "./widget.ts";

export const WORKER_SYSTEM_PROMPT = `## Ticket Flow worker role

- Work only on the delegated work item and follow all project instructions.
- Call workflow_worker get after context loss or whenever delegated scope is uncertain.
- Call workflow_worker submit for progress, blockers, failure, and final completion.
- Call workflow_worker send for a blocking question; remain connected and wait for Main feedback.
- Audit workers are read-only: inspect and report, but never edit, write, commit, or claim uncommitted changes were audited.
- Do not mark ticket files complete; Main owns completion recording.
- Do not claim a check passed unless you ran it.`;

export function appendWorkerSystemPrompt(systemPrompt: string): string {
	return `${systemPrompt}\n\n${WORKER_SYSTEM_PROMPT}`;
}

export function workflowFooterStatus(run: WorkflowRun): string {
	if (run.phase === "ready") return `ticket-flow · ready · ${run.plan.workItems.length} items`;
	if (run.phase === "awaiting-user") return "ticket-flow · awaiting user";
	if (run.phase === "auditing") return "ticket-flow · audit pending";
	if (run.phase === "fixing") return "ticket-flow · audit fix pending";
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

// Audit workers receive only structured inspection tools. Raw shell strings
// cannot be made read-only: command flags, PATH helpers, and shell expansion
// can all turn an apparent inspection command into code execution or a write.
const AUDIT_TOOL_NAMES = new Set(["read", "grep", "find", "ls", "rg", "fd", "workflow_worker"]);

export function auditToolCallBlocked(event: { readonly toolName: string; readonly input?: unknown }): string | undefined {
	if (["edit", "write", "delete", "remove", "move", "copy", "git", "git_commit", "shell", "terminal", "exec", "execute"].includes(event.toolName)) {
		return "Audit workers are read-only and cannot mutate files or Git history.";
	}
	if (event.toolName === "bash") return "Audit workers cannot execute raw shell commands; use structured read, search, and listing tools.";
	return undefined;
}

export function workerActiveToolNames(previous: readonly string[], kind: "implementation" | "audit" | "fix"): string[] {
	if (kind === "audit") return toolsForWorkflowRole([...AUDIT_TOOL_NAMES], "worker");
	return toolsForWorkflowRole(previous, "worker");
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
			try {
				lifecycle = await Effect.runPromise(prepareWorkerLifecycle(), { signal: ctx.signal });
				const kind = lifecycle.environment.kind ?? "implementation";
				const previous = pi.getActiveTools();
				if (kind === "audit") {
					// Keep inspection, search, and validation surfaces, but never rely
					// on this list as the only write protection (see tool_call below).
					pi.setActiveTools(workerActiveToolNames(previous, kind));
				} else {
					// Implementation and fix workers retain the normal Pi surface.
					// Only the worker transport is added; no read-only --tools override.
					pi.setActiveTools(workerActiveToolNames(previous, kind));
				}
				await Effect.runPromise(lifecycle.start(pi, ctx), { signal: ctx.signal });
			} catch (error) {
				// A worker that never reaches authenticated delegation must not retain
				// implementation or workflow tools from its launch configuration.
				pi.setActiveTools([]);
				if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		});
		pi.on("before_agent_start", (event) => ({ systemPrompt: appendWorkerSystemPrompt(event.systemPrompt) }));
		pi.on("context", (event) => ({ messages: filterWorkflowToolContext(event.messages, "worker") }));
		pi.on("tool_call", (event) => {
			if (!lifecycle?.isStarted) return { block: true, reason: "Ticket Flow worker tools are inactive until authenticated delegation is ready." };
			if (isWorkflowToolName(event.toolName) && !isWorkflowToolAllowed(event.toolName, "worker")) return { block: true, reason: "This workflow tool was retired and is unavailable in Ticket Flow workers." };
			if (lifecycle?.environment.kind === "audit") {
				const reason = auditToolCallBlocked(event);
				if (reason) return { block: true, reason };
			}
		});
		pi.on("input", (event, ctx) => {
			if (!isTicketFlowInvocation(event.text)) return;
			if (ctx.hasUI) ctx.ui.notify("A Ticket Flow worker cannot start or control a nested workflow.", "error");
			return { action: "handled" as const };
		});
		pi.on("session_shutdown", async () => {
			if (!lifecycle) return;
			// Shutdown cleanup must finish even when a turn AbortSignal is stale.
			await Effect.runPromise(lifecycle.shutdown());
		});
		return;
	}

	const controller = new WorkflowController(pi, undefined, undefined, options.tmux);
	registerOrchestratorTools(pi, controller);
	let widgetRun: WorkflowRun | undefined;
	let widgetContext: ExtensionContext | undefined;
	let widgetTimer: ReturnType<typeof setInterval> | undefined;
	let widget: WorkflowTaskListWidget | undefined;
	let widgetTui: { readonly requestRender: (force?: boolean) => void } | undefined;
	let widgetInstalled = false;
	let widgetVisible = false;
	let widgetReloading = false;
	let widgetLastReloadAt = 0;

	function disposeWidgetState(): void {
		const context = widgetContext;
		widgetVisible = false;
		widgetRun = undefined;
		widgetContext = undefined;
		widget?.setRun(undefined);
		widget = undefined;
		widgetTui = undefined;
		widgetInstalled = false;
		widgetReloading = false;
		if (widgetTimer) clearInterval(widgetTimer);
		widgetTimer = undefined;
		if (context?.hasUI) context.ui.setStatus("ticket-flow", undefined);
	}

	function clearWidget(ctx?: ExtensionContext): void {
		disposeWidgetState();
		if (ctx?.hasUI) {
			if (typeof ctx.ui.setWidget === "function") ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, undefined);
			ctx.ui.setStatus("ticket-flow", undefined);
		}
	}

	function showWidget(ctx: ExtensionContext, run: WorkflowRun | undefined): void {
		if (run?.phase === "completed" || run?.phase === "stopped") {
			clearWidget(ctx);
			return;
		}
		widgetContext = ctx;
		widgetRun = run;
		if (!ctx.hasUI || run === undefined) { clearWidget(ctx); return; }
		widgetVisible = true;
		updateStatus(ctx, run);
		if (ctx.mode !== "tui") {
			if (typeof ctx.ui.setWidget === "function") ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, renderWorkflowWidget(run, 100));
			return;
		}
		widget ??= new WorkflowTaskListWidget(run);
		widget.setRun(run);
		if (typeof ctx.ui.setWidget !== "function") return;
		// Install one live component. Its render closure reads the mutable widget,
		// not the run snapshot that happened to exist at installation time.
		if (!widgetInstalled) {
			widgetInstalled = true;
			ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, (tui, theme) => {
				widgetTui = tui;
				return {
					render: (width: number) => widget?.render(width, { theme }) ?? [],
					invalidate: () => widget?.invalidate(),
					dispose: disposeWidgetState,
				};
			});
		}
		if (!widgetTimer) {
			widgetTimer = setInterval(() => {
				const current = controller.activeRun ?? widgetRun;
				if (!current || current.phase === "completed" || current.phase === "stopped" || !widgetContext?.hasUI) {
					clearWidget(widgetContext);
					return;
				}
				widgetRun = current;
				widget?.setRun(current);
				widget?.advance();
				updateStatus(widgetContext, current);
				widgetTui?.requestRender();
				if (!controller.activeRun && !widgetReloading && Date.now() - widgetLastReloadAt >= 1_000) {
					widgetReloading = true;
					widgetLastReloadAt = Date.now();
					const selectedRunId = current.id;
					const context = widgetContext;
					void Effect.runPromise(controller.discover(context.cwd, undefined, context.sessionManager.getSessionId()))
						.then((discovery) => {
							const refreshed = discovery.runs.find((candidate) => candidate.run.id === selectedRunId)?.run;
							if (refreshed && widgetVisible) {
								widgetRun = refreshed;
								widget?.setRun(refreshed);
								updateStatus(context, refreshed);
								widgetTui?.requestRender();
							}
						})
						.catch(() => undefined)
						.finally(() => { widgetReloading = false; });
				}
			}, 160);
			widgetTimer.unref?.();
		}
	}

	function refreshWidget(ctx: ExtensionContext, run: WorkflowRun | undefined): void {
		if (widgetVisible) showWidget(ctx, run);
	}

	async function attachDiscoveredRun(ctx: ExtensionContext, action: "pause" | "resume" | "stop"): Promise<WorkflowRun | undefined> {
		if (controller.activeRun) return controller.activeRun;
		const discovery = await Effect.runPromise(controller.discover(ctx.cwd, undefined, ctx.sessionManager.getSessionId()), { signal: ctx.signal });
		const candidate = await selectRecoverableRun(discovery, ctx, action);
		if (!candidate) return undefined;
		let allowAmbiguousTakeover = false;
		if (candidate.lock.state === "ambiguous") {
			if (!ctx.hasUI) throw new Error("Ambiguous Ticket Flow lock ownership requires interactive approval.");
			allowAmbiguousTakeover = await ctx.ui.confirm("Take over ambiguous Ticket Flow lock?", `${candidate.lock.reason} Recovery will not close an unverified tmux window.`);
			if (!allowAmbiguousTakeover) throw new Error("Ticket Flow recovery was cancelled.");
		}
		const recovered = await Effect.runPromise(controller.recover({
			cwd: ctx.cwd,
			runId: candidate.run.id,
			...(ctx.sessionManager.getSessionId() === undefined ? {} : { sessionId: ctx.sessionManager.getSessionId() }),
			...(allowAmbiguousTakeover ? { allowAmbiguousTakeover: true } : {}),
		}), { signal: ctx.signal });
		refreshWidget(ctx, recovered);
		return recovered;
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			const discovery = await discoverOrchestratorRecovery(controller, ctx);
			if (controller.activeRun) {
				pi.setActiveTools(toolsForWorkflowRole(pi.getActiveTools(), "orchestrator"));
			} else {
				// Registered workflow tools remain inactive until a run owns them.
				pi.setActiveTools(withoutWorkflowTools(pi.getActiveTools()));
			}
			const sessionId = ctx.sessionManager.getSessionId();
			const currentSessionRun = sessionId === undefined
				? undefined
				: discovery.runs.find((candidate) => candidate.run.orchestratorSessionId === sessionId)?.run;
			// Widget visibility is session-local. The owner session restores its
			// widget; other sessions require /ticket-flow status to opt in.
			if (sessionId !== undefined && controller.activeRun?.orchestratorSessionId === sessionId) showWidget(ctx, controller.activeRun);
			else if (currentSessionRun) showWidget(ctx, currentSessionRun);
			else clearWidget(ctx);
		} catch (error) { notifyError(ctx, error); }
	});

	pi.registerCommand("ticket-flow", {
		description: "Start or control the explicit Ticket Flow workflow",
		getArgumentCompletions: ticketFlowArgumentCompletions,
		handler: async (args, ctx) => {
			try {
				const command = parseTicketFlowCommand(args);
				if ("action" in command) {
					switch (command.action) {
						case "status": {
							if (widgetVisible) {
								clearWidget(ctx);
								if (ctx.hasUI) ctx.ui.notify("Ticket Flow widget hidden in this session.", "info");
								return;
							}
							if (controller.activeRun) {
								showWidget(ctx, controller.activeRun);
								if (ctx.hasUI) ctx.ui.notify(`Ticket Flow ${controller.activeRun.phase} · ${controller.activeRun.plan.workItems.length} item(s) · widget shown`, "info");
							} else {
								const discovery = await Effect.runPromise(controller.discover(ctx.cwd, undefined, ctx.sessionManager.getSessionId()), { signal: ctx.signal });
								const selected = await selectRecoverableRun(discovery, ctx, "status");
								const found = selected?.run;
								if (found) showWidget(ctx, found);
								if (ctx.hasUI) ctx.ui.notify(found ? `Recoverable Ticket Flow ${found.phase} · ${found.id} · widget shown` : discovery.runs.length === 0 ? "No active Ticket Flow run." : "Ticket Flow status selection was cancelled.", found ? "info" : "warning");
							}
							return;
						}
						case "pause": {
							const attached = await attachDiscoveredRun(ctx, "pause");
							if (!attached) throw new Error("No active Ticket Flow run.");
							const run = attached.phase === "paused" ? attached : await Effect.runPromise(controller.pause(), { signal: ctx.signal });
							refreshWidget(ctx, run); if (ctx.hasUI) ctx.ui.notify("Ticket Flow paused.", "info"); return;
						}
						case "resume": {
							const attached = await attachDiscoveredRun(ctx, "resume");
							if (!attached) throw new Error("No recoverable Ticket Flow run exists for this project.");
							const run = attached.phase === "paused" ? await Effect.runPromise(controller.resume(), { signal: ctx.signal }) : attached;
							const resolved = await resolveRecoveryIssue(controller, run, ctx); refreshWidget(ctx, resolved); return;
						}
						case "stop": {
							const attached = await attachDiscoveredRun(ctx, "stop");
							if (!attached) throw new Error("No active Ticket Flow run.");
							if (!await confirmActiveWorkerStop(controller, ctx)) return;
							const run = await Effect.runPromise(controller.stop(), { signal: ctx.signal }); clearWidget(ctx); if (ctx.hasUI) ctx.ui.notify(`Ticket Flow stopped (${run.id}).`, "info"); return;
						}
					}
				}

				assertCommandPrerequisites({ mode: ctx.mode, tmux: process.env.TMUX });
				await Effect.runPromise(controller.verifyTmux(), { signal: ctx.signal });
				const discovery = await Effect.runPromise(controller.discover(ctx.cwd, undefined, ctx.sessionManager.getSessionId()), { signal: ctx.signal });
				if (discovery.runs.length > 0) {
					if (!ctx.hasUI) throw new Error("An unfinished Ticket Flow run exists; use /ticket-flow status or recover it in an interactive session.");
					const choice = await ctx.ui.select("Ticket Flow run already exists", ["Recover existing run", "Cancel"]);
					if (choice !== "Recover existing run") return;
					const recovered = await recoverWithConfirmation(controller, ctx);
					refreshWidget(ctx, recovered);
					if (recovered.phase !== "stopped") pi.sendUserMessage(RECOVERY_KICKOFF);
					return;
				}
				const run = await Effect.runPromise(controller.startRun({ cwd: ctx.cwd, prompt: command.prompt, sessionId: ctx.sessionManager.getSessionId() }), { signal: ctx.signal });
				showWidget(ctx, run);
				pi.sendUserMessage(ORCHESTRATOR_KICKOFF);
			} catch (error) { notifyError(ctx, error); }
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!controller.activeRun) return;
		return { systemPrompt: appendOrchestratorSystemPrompt(event.systemPrompt) };
	});

	pi.on("context", (event) => ({ messages: filterWorkflowToolContext(event.messages, "orchestrator") }));

	pi.on("tool_call", (event) => {
		if (isWorkflowToolName(event.toolName) && !isWorkflowToolAllowed(event.toolName, "orchestrator")) {
			return { block: true, reason: "This workflow tool was retired. Use workflow_plan, workflow_delegate, or /ticket-flow controls." };
		}
		if (isWorkflowToolName(event.toolName) && !controller.activeRun) {
			return { block: true, reason: "Ticket Flow workflow tools are inactive outside an active owned run." };
		}
	});

	pi.on("tool_execution_start", (_event, ctx) => {
		const run = controller.activeRun ?? widgetRun;
		if (run) refreshWidget(ctx, run);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const resultRun = (event.result as { readonly details?: { readonly run?: WorkflowRun } } | undefined)?.details?.run;
		if (resultRun?.phase === "completed" || resultRun?.phase === "stopped") { clearWidget(ctx); return; }
		const run = controller.activeRun ?? resultRun ?? (widgetRun?.phase === "completed" || widgetRun?.phase === "stopped" ? undefined : widgetRun);
		if (run) refreshWidget(ctx, run); else if (widgetVisible) clearWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await Effect.runPromise(controller.shutdown());
		clearWidget(ctx);
	});
}
