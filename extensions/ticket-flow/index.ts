import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { assertCommandPrerequisites, ORCHESTRATOR_KICKOFF, parseTicketFlowCommand, RECOVERY_KICKOFF } from "./command.ts";
import { WorkflowController } from "./controller.ts";
import { appendOrchestratorSystemPrompt } from "./orchestrator/system-prompt.ts";
import { registerOrchestratorTools } from "./orchestrator/tools.ts";
import { discoverOrchestratorRecovery, recoverWithConfirmation, confirmActiveWorkerStop, resolveRecoveryIssue } from "./orchestrator/lifecycle.ts";
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

const AUDIT_TOOL_NAMES = new Set(["read", "grep", "find", "ls", "rg", "fd", "bash", "workflow_worker"]);

/**
 * Audit bash is an inspection-only language, not a reduced implementation
 * shell.  In particular, package runners are intentionally not allowed:
 * even `bun test` can execute a project-controlled script.  Keep this
 * allow-list boring and reject anything that requires reasoning about shell
 * expansion or a command's future flags.
 */
const AUDIT_INSPECTION_COMMANDS = new Set(["pwd", "ls", "find", "rg", "fd", "cat", "head", "tail", "file", "stat", "wc", "sort", "uniq", "diff", "git"]);
const AUDIT_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "ls-tree"]);
const AUDIT_FORBIDDEN_TOKEN = /^(?:--?(?:output|exec|exec-path|delete|remove|write|add|force|prune|clean|apply|index-pack|upload-pack|receive-pack)(?:=.*)?|-exec(?:dir)?(?:=.*)?|-ok(?:dir)?(?:=.*)?|-f(?:print|printf|ls)(?:=.*)?|--pre(?:=.*)?|--external-diff(?:=.*)?|--textconv(?:=.*)?|--ext-diff(?:=.*)?|--no-index(?:=.*)?|--pathspec-from-file(?:=.*)?|--pathspec-file-nul(?:=.*)?)$/i;

function auditShellWords(value: string): readonly string[] | undefined {
	if (!value || /[;&|<>`$\\\n\r(){}]/.test(value)) return undefined;
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index]!;
		if (quote !== undefined) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			if (current) { words.push(current); current = ""; }
			continue;
		}
		current += character;
	}
	if (quote !== undefined) return undefined;
	if (current) words.push(current);
	return words.length > 0 ? words : undefined;
}

export function isAuditBashCommandAllowed(command: string): boolean {
	const words = auditShellWords(command.trim());
	if (!words) return false;
	const executable = words[0]!;
	if (!AUDIT_INSPECTION_COMMANDS.has(executable) || executable.includes("/")) return false;
	const args = words.slice(1);
	if (args.some((argument) => AUDIT_FORBIDDEN_TOKEN.test(argument) || /^(?:[;&|<>`$]|--output(?:=|$)|-o)/i.test(argument))) return false;
	if (executable === "git") {
		// Only harmless top-level switches may precede the subcommand.  Reject
		// -C/--git-dir/--work-tree and -c because they change the inspection
		// context or can write Git configuration through aliases.
		let subcommandIndex = 0;
		while (subcommandIndex < args.length && ["--no-pager", "--no-optional-locks"].includes(args[subcommandIndex]!)) subcommandIndex += 1;
		const subcommand = args[subcommandIndex];
		if (!subcommand || !AUDIT_GIT_SUBCOMMANDS.has(subcommand) || args.slice(0, subcommandIndex).some((arg) => arg.startsWith("-"))) return false;
		if (args.slice(subcommandIndex + 1).some((arg) => /^(?:commit|checkout|switch|reset|restore|clean|add|rm|mv|push|fetch|pull|merge|rebase|config|--output(?:=|$)|-C$|--git-dir(?:=|$)|--work-tree(?:=|$)|-c$|-d$|-D$|-m$|-M$|-f$)/i.test(arg))) return false;
		return true;
	}
	if (executable === "find") {
		// find's -exec/-delete/-fprint family is rejected above; no other
		// find expression can mutate the checkout.
		return !args.some((arg) => /^(?:-exec|--exec|-delete|-ok|--delete|-fprint|-fprintf|-fls)$/i.test(arg));
	}
	// These programs are all direct inspection utilities.  Do not accept
	// command names which are resolved through PATH aliases or project scripts.
	return true;
}

export function auditToolCallBlocked(event: { readonly toolName: string; readonly input?: unknown }): string | undefined {
	if (["edit", "write", "delete", "remove", "move", "copy", "git", "git_commit", "shell", "terminal", "exec", "execute"].includes(event.toolName)) {
		return "Audit workers are read-only and cannot mutate files or Git history.";
	}
	if (event.toolName === "bash") {
		const command = (event.input as { readonly command?: unknown } | undefined)?.command;
		if (typeof command !== "string" || !isAuditBashCommandAllowed(command)) return "Audit bash is restricted to read-only inspection and validation commands.";
	}
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
				if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		});
		pi.on("before_agent_start", (event) => ({ systemPrompt: appendWorkerSystemPrompt(event.systemPrompt) }));
		pi.on("context", (event) => ({ messages: filterWorkflowToolContext(event.messages, "worker") }));
		pi.on("tool_call", (event) => {
			if (isWorkflowToolName(event.toolName) && !isWorkflowToolAllowed(event.toolName, "worker")) return { block: true, reason: "This workflow tool was retired and is unavailable in Ticket Flow workers." };
			if (event.toolName === "workflow_worker" && !lifecycle?.isStarted) return { block: true, reason: "Ticket Flow worker is inactive until its authenticated connection is ready." };
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

	function clearWidget(ctx?: ExtensionContext): void {
		widgetRun = undefined;
		widget?.setRun(undefined);
		widget = undefined;
		widgetTui = undefined;
		widgetInstalled = false;
		if (widgetTimer) clearInterval(widgetTimer);
		widgetTimer = undefined;
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
					dispose: () => { widgetTui = undefined; widgetInstalled = false; },
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
			}, 160);
			widgetTimer.unref?.();
		}
	}


	async function attachDiscoveredRun(ctx: ExtensionContext): Promise<WorkflowRun | undefined> {
		if (controller.activeRun) return controller.activeRun;
		const discovery = await Effect.runPromise(controller.discover(ctx.cwd, undefined, ctx.sessionManager.getSessionId()), { signal: ctx.signal });
		if (discovery.runs.length === 0) return undefined;
		if (discovery.runs.length > 1) throw new Error("Multiple unfinished Ticket Flow runs exist; resume requires an explicit run selection.");
		const candidate = discovery.runs[0]!;
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
		showWidget(ctx, recovered);
		return recovered;
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			const discovery = await discoverOrchestratorRecovery(controller, ctx);
			if (controller.activeRun) {
				pi.setActiveTools(toolsForWorkflowRole(pi.getActiveTools(), "orchestrator"));
				showWidget(ctx, controller.activeRun);
			}
			else if (discovery.runs[0]) {
				pi.setActiveTools(withoutWorkflowTools(pi.getActiveTools()));
				showWidget(ctx, discovery.runs[0].run);
			} else {
				// Registered workflow tools remain inactive until a run owns them.
				pi.setActiveTools(withoutWorkflowTools(pi.getActiveTools()));
				clearWidget(ctx);
			}
		} catch (error) { notifyError(ctx, error); }
	});

	pi.registerCommand("ticket-flow", {
		description: "Start or control the explicit Ticket Flow workflow",
		handler: async (args, ctx) => {
			try {
				const command = parseTicketFlowCommand(args);
				if ("action" in command) {
					switch (command.action) {
						case "status": {
							if (controller.activeRun) {
								showWidget(ctx, controller.activeRun);
								if (ctx.hasUI) ctx.ui.notify(`Ticket Flow ${controller.activeRun.phase} · ${controller.activeRun.plan.workItems.length} item(s)`, "info");
							} else {
								const discovery = await Effect.runPromise(controller.discover(ctx.cwd, undefined, ctx.sessionManager.getSessionId()), { signal: ctx.signal });
								const found = discovery.runs[0]?.run;
								if (found) showWidget(ctx, found);
								if (ctx.hasUI) ctx.ui.notify(found ? `Recoverable Ticket Flow ${found.phase} · ${found.id}` : "No active Ticket Flow run.", found ? "info" : "warning");
							}
							return;
						}
						case "pause": {
							const attached = await attachDiscoveredRun(ctx);
							if (!attached) throw new Error("No active Ticket Flow run.");
							const run = attached.phase === "paused" ? attached : await Effect.runPromise(controller.pause(), { signal: ctx.signal });
							showWidget(ctx, run); if (ctx.hasUI) ctx.ui.notify("Ticket Flow paused.", "info"); return;
						}
						case "resume": {
							const attached = await attachDiscoveredRun(ctx);
							if (!attached) throw new Error("No recoverable Ticket Flow run exists for this project.");
							const run = attached.phase === "paused" ? await Effect.runPromise(controller.resume(), { signal: ctx.signal }) : attached;
							const resolved = await resolveRecoveryIssue(controller, run, ctx); showWidget(ctx, resolved); return;
						}
						case "stop": {
							const attached = await attachDiscoveredRun(ctx);
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
					showWidget(ctx, recovered);
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
		if (run) showWidget(ctx, run);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const resultRun = (event.result as { readonly details?: { readonly run?: WorkflowRun } } | undefined)?.details?.run;
		if (resultRun?.phase === "completed" || resultRun?.phase === "stopped") { clearWidget(ctx); return; }
		const run = controller.activeRun ?? resultRun ?? (widgetRun?.phase === "completed" || widgetRun?.phase === "stopped" ? undefined : widgetRun);
		if (run) showWidget(ctx, run); else clearWidget(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await Effect.runPromise(controller.shutdown());
		clearWidget(ctx);
	});
}
