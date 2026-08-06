import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { Type } from "typebox";
import { TicketflowCoordinator, type DelegateResult, type WaitResult } from "./coordinator.ts";
import { assertTmuxSetupContext, parseTicketflowCommand, runSetupWizard, ticketflowArgumentCompletions } from "./command.ts";
import { assertNoLegacyRun, discoverRuns } from "./store.ts";
import type { AssignmentKind, ThinkingLevel, TicketflowRun } from "./model.ts";
import { THINKING_LEVELS, isTerminalPhase } from "./model.ts";
import { WorkerChannel } from "./worker.ts";
import {
	filterTicketflowContext,
	isAllowedTicketflowTool,
	isTicketflowTool,
	MAIN_TICKETFLOW_TOOLS,
	withoutTicketflowTools,
} from "./tool-names.ts";
import {
	formatElapsed,
	formatWaitResultMarkdown,
	renderTicketflowCall,
	renderTicketflowResult,
	runWithTicketflowProgress,
} from "./tool-ui.ts";
import { footerStatus, renderTicketflowWidget, TICKETFLOW_WIDGET_KEY } from "./widget.ts";

const StrictObject = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });
const WorkerId = Type.String({ minLength: 1 });
const MAIN_SYSTEM_PROMPT = `## Ticket Flow Main role

You coordinate one visible, strictly sequential Ticket Flow run. Do not implement tickets yourself.
- Use ticketflow_delegate to open only the durable next assignment.
- Copy the returned initialTask byte-for-byte into ticketflow_send delivery=task. Never prefix or suffix it.
- Use ticketflow_wait until the worker reaches agent_settled. A report and settlement are separate facts.
- A blocked report is one settled turn: obtain an answer, send it as a follow-up, then wait again.
- If ticketflow_close rejects an audit report, send correction instructions as a follow-up to the same Worker, wait for its replacement report, then close again.
- A failed or unreported turn never completes an assignment.
- Use ticketflow_close only after a completed implementation/fix report or audit report. Close is the only cursor-advancing operation.
- Use ticketflow_resume to reopen the exact persisted Pi session. It never resends old work.
- Use ticketflow_abort only to interrupt the current turn; it never completes the ticket.
- Do not infer completion from terminal output and do not directly operate tmux, Git, or project files.`;

const WORKER_SYSTEM_PROMPT = `## Ticket Flow Worker role

You are the Worker for exactly one Ticket Flow Assignment.
- Follow only tasks and follow-ups delivered by Main.
- Implementation and fix assignments must commit all work before reporting completion.
- Implementation assignments must satisfy and check every Markdown checkbox in their ticket.
- Finish each turn by calling ticketflow_report exactly once.
- Use status=blocked with explicit questions when Main input is required; this settles only the current turn.
- Never claim checks, commits, or evidence that you did not verify.`;

const AUDIT_SYSTEM_PROMPT = `
- This is a read-only audit Assignment. Use only structured read, search, and list tools.
- Never mutate files, run shell commands, or change Git state.
- Report the exact audited commit set, requirement verdicts with file-level evidence, and all findings.`;

export interface TicketflowExtensionOptions {
	readonly coordinator?: TicketflowCoordinator;
	readonly role?: "main" | "worker";
	readonly environment?: NodeJS.ProcessEnv;
}

function bounded(text: string): string {
	const result = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	return result.truncated ? `${result.content}\n[Ticket Flow output truncated]` : result.content;
}

function textResult(text: string, details: unknown) {
	return { content: [{ type: "text" as const, text: bounded(text) }], details };
}

function runEffect<A>(effect: Effect.Effect<A, Error>, signal?: AbortSignal): Promise<A> {
	return Effect.runPromise(effect, { signal });
}

function showWidget(ctx: ExtensionContext, run: TicketflowRun | undefined): void {
	if (!ctx.hasUI) return;
	if (!run || isTerminalPhase(run.phase)) {
		ctx.ui.setWidget(TICKETFLOW_WIDGET_KEY, undefined);
		ctx.ui.setStatus(TICKETFLOW_WIDGET_KEY, undefined);
		return;
	}
	if (ctx.mode === "tui") {
		ctx.ui.setWidget(TICKETFLOW_WIDGET_KEY, () => ({
			render: (width: number) => renderTicketflowWidget(run, width),
			invalidate: () => undefined,
		}));
	} else ctx.ui.setWidget(TICKETFLOW_WIDGET_KEY, renderTicketflowWidget(run, 100));
	ctx.ui.setStatus(TICKETFLOW_WIDGET_KEY, footerStatus(run));
}

function notifyError(ctx: ExtensionContext, cause: unknown): void {
	if (ctx.hasUI) ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), "error");
}

export function registerMainTools(pi: ExtensionAPI, coordinator: TicketflowCoordinator): void {
	pi.registerTool({
		name: "ticketflow_delegate",
		label: "Ticket Flow delegate",
		description: "Spawn the next durable Ticket Flow assignment in one owned tmux window. Does not send work.",
		parameters: StrictObject({}),
		executionMode: "sequential",
		async execute(_id, _params, signal, onUpdate, ctx) {
			const { value: result, elapsedMs } = await runWithTicketflowProgress("Opening Worker", onUpdate, () => runEffect(coordinator.delegate(), signal));
			showWidget(ctx, coordinator.activeRun);
			return textResult(`Worker ${result.workerId} is ready (${result.assignmentKind}). Send this exact initial task with ticketflow_send:\n\n${result.initialTask}`, { result, elapsedMs, runId: coordinator.activeRun?.id, revision: coordinator.activeRun?.revision, phase: coordinator.activeRun?.phase });
		},
		renderCall(_args, theme) {
			return renderTicketflowCall("◆", "Delegate", undefined, theme);
		},
		renderResult(result, options, theme, context) {
			const details = result.details as { readonly result?: DelegateResult } | undefined;
			const delegated = details?.result;
			return renderTicketflowResult(result, options, theme, context, {
				label: "Worker ready",
				...(delegated ? { meta: `${delegated.assignmentKind} · ${delegated.workerId}` } : {}),
			});
		},
	});
	pi.registerTool({
		name: "ticketflow_send",
		label: "Ticket Flow send",
		description: "Send the exact initial task, active-turn steering, or a follow-up (including answers and audit corrections) to the active Worker.",
		parameters: StrictObject({
			workerId: WorkerId,
			delivery: StringEnum(["task", "steer", "follow-up"] as const),
			message: Type.String({ minLength: 1 }),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal, onUpdate, ctx) {
			const { value: run, elapsedMs } = await runWithTicketflowProgress("Delivering", onUpdate, () => runEffect(coordinator.send(params), signal));
			showWidget(ctx, run);
			return textResult(`Delivered ${params.delivery} to ${params.workerId}; turn ${run.assignment?.turn}.`, { elapsedMs, runId: run.id, revision: run.revision, phase: run.phase, turn: run.assignment?.turn });
		},
		renderCall(args, theme) {
			return renderTicketflowCall("→", "Send", `${args.delivery} · ${args.workerId}`, theme);
		},
		renderResult(result, options, theme, context) {
			const details = result.details as { readonly turn?: number } | undefined;
			return renderTicketflowResult(result, options, theme, context, {
				label: "Delivered",
				...(details?.turn ? { meta: `turn ${details.turn}` } : {}),
				markdown: context.args.message,
			});
		},
	});
	pi.registerTool({
		name: "ticketflow_wait",
		label: "Ticket Flow wait",
		description: "Wait specifically for the active Worker agent_settled event and return its latest durable report. Cancelling only stops this wait.",
		parameters: StrictObject({ workerId: WorkerId }),
		executionMode: "sequential",
		async execute(_id, params, signal, onUpdate, ctx) {
			const { value: result, elapsedMs } = await runWithTicketflowProgress("Waiting", onUpdate, () => runEffect(coordinator.wait(params.workerId), signal));
			showWidget(ctx, coordinator.activeRun);
			return textResult(formatWaitResultMarkdown(result), { result, elapsedMs, runId: coordinator.activeRun?.id, revision: coordinator.activeRun?.revision, phase: coordinator.activeRun?.phase });
		},
		renderCall(args, theme) {
			return renderTicketflowCall("◷", "Wait", args.workerId, theme);
		},
		renderResult(result, options, theme, context) {
			const details = result.details as { readonly result?: WaitResult; readonly elapsedMs?: number } | undefined;
			const waited = details?.result;
			const meta = waited
				? `turn ${waited.turn} · ${waited.status} · ${formatElapsed(details?.elapsedMs ?? 0)}`
				: undefined;
			return renderTicketflowResult(result, options, theme, context, {
				label: "Settled",
				...(meta ? { meta } : {}),
				...(waited ? { markdown: formatWaitResultMarkdown(waited) } : {}),
				...(waited?.status === "unreported" ? { tone: "warning" as const } : {}),
			});
		},
	});
	pi.registerTool({
		name: "ticketflow_close",
		label: "Ticket Flow close",
		description: "Verify the completion gate, advance the durable cursor, and close only the verified owned Worker.",
		parameters: StrictObject({ workerId: WorkerId }),
		executionMode: "sequential",
		async execute(_id, params, signal, onUpdate, ctx) {
			const { value: run, elapsedMs } = await runWithTicketflowProgress("Verifying", onUpdate, () => runEffect(coordinator.close(params.workerId), signal));
			showWidget(ctx, run);
			return textResult(`Closed ${params.workerId}; Ticket Flow is now ${run.phase}.`, { elapsedMs, runId: run.id, revision: run.revision, phase: run.phase });
		},
		renderCall(args, theme) {
			return renderTicketflowCall("◇", "Close", args.workerId, theme);
		},
		renderResult(result, options, theme, context) {
			const details = result.details as { readonly phase?: string } | undefined;
			return renderTicketflowResult(result, options, theme, context, { label: "Closed", ...(details?.phase ? { meta: details.phase } : {}) });
		},
	});
	pi.registerTool({
		name: "ticketflow_resume",
		label: "Ticket Flow resume Worker",
		description: "Reopen and verify the exact persisted Pi Worker session. Never resends the old task.",
		parameters: StrictObject({ workerId: WorkerId }),
		executionMode: "sequential",
		async execute(_id, params, signal, onUpdate, ctx) {
			const { value: result, elapsedMs } = await runWithTicketflowProgress("Reopening", onUpdate, () => runEffect(coordinator.resumeWorker(params.workerId), signal));
			showWidget(ctx, coordinator.activeRun);
			return textResult(`Reopened exact Pi session ${result.sessionId}; send new follow-up work explicitly.`, { elapsedMs, workerId: result.workerId, sessionId: result.sessionId, sessionFile: result.sessionFile, runId: coordinator.activeRun?.id, revision: coordinator.activeRun?.revision });
		},
		renderCall(args, theme) {
			return renderTicketflowCall("↻", "Resume", args.workerId, theme);
		},
		renderResult(result, options, theme, context) {
			return renderTicketflowResult(result, options, theme, context, { label: "Worker reopened" });
		},
	});
	pi.registerTool({
		name: "ticketflow_abort",
		label: "Ticket Flow abort turn",
		description: "Abort only the current Worker turn, wait for settlement, and preserve the Pi session for resume.",
		parameters: StrictObject({ workerId: WorkerId }),
		executionMode: "sequential",
		async execute(_id, params, signal, onUpdate, ctx) {
			const { value: run, elapsedMs } = await runWithTicketflowProgress("Aborting", onUpdate, () => runEffect(coordinator.abort(params.workerId), signal));
			showWidget(ctx, run);
			return textResult(`Aborted the active turn for ${params.workerId}; the session remains resumable.`, { elapsedMs, runId: run.id, revision: run.revision, phase: run.phase });
		},
		renderCall(args, theme) {
			return renderTicketflowCall("■", "Abort", args.workerId, theme);
		},
		renderResult(result, options, theme, context) {
			return renderTicketflowResult(result, options, theme, context, { label: "Turn aborted" });
		},
	});
}

interface WorkerEnvironment {
	readonly runId: string;
	readonly assignmentId: string;
	readonly kind: AssignmentKind;
	readonly socketPath: string;
	readonly token: string;
	readonly model: string;
	readonly thinking: ThinkingLevel;
	readonly resume: boolean;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
	const value = environment[name];
	if (!value || value !== value.trim() || /[\0\r\n]/.test(value)) throw new Error(`${name} is required and must be control-free.`);
	return value;
}

export function readWorkerEnvironment(environment: NodeJS.ProcessEnv = process.env): WorkerEnvironment {
	if (environment.TICKETFLOW_ROLE !== "worker") throw new Error("TICKETFLOW_ROLE must be worker.");
	const kind = required(environment, "TICKETFLOW_KIND");
	if (kind !== "implementation" && kind !== "audit" && kind !== "fix") throw new Error("TICKETFLOW_KIND is invalid.");
	const thinking = required(environment, "TICKETFLOW_REQUESTED_THINKING") as ThinkingLevel;
	if (!THINKING_LEVELS.includes(thinking)) throw new Error("TICKETFLOW_REQUESTED_THINKING is invalid.");
	return {
		runId: required(environment, "TICKETFLOW_RUN_ID"),
		assignmentId: required(environment, "TICKETFLOW_ASSIGNMENT_ID"),
		kind,
		socketPath: required(environment, "TICKETFLOW_SOCKET"),
		token: required(environment, "TICKETFLOW_TOKEN"),
		model: required(environment, "TICKETFLOW_REQUESTED_MODEL"),
		thinking,
		resume: environment.TICKETFLOW_RESUME === "1",
	};
}

const AUDIT_TOOLS = ["read", "grep", "find", "ls", "rg", "fd", "ticketflow_report"] as const;

export function auditToolBlocked(name: string): string | undefined {
	return AUDIT_TOOLS.includes(name as (typeof AUDIT_TOOLS)[number]) ? undefined : "Ticket Flow audit workers are read-only and may use only structured read, search, list, and ticketflow_report tools.";
}

function startWorkerRole(pi: ExtensionAPI, environment: NodeJS.ProcessEnv): void {
	let bridge: WorkerChannel | undefined;
	let kind: AssignmentKind | undefined;
	let previousTools: string[] = [];
	pi.on("session_start", (_event, ctx) => {
		try {
			const configured = readWorkerEnvironment(environment);
			kind = configured.kind;
			previousTools = withoutTicketflowTools(pi.getActiveTools());
			bridge = new WorkerChannel({
				pi,
				ctx,
				socketPath: configured.socketPath,
				runId: configured.runId,
				assignmentId: configured.assignmentId,
				token: configured.token,
				requestedProfile: { model: configured.model, thinking: configured.thinking },
				resume: configured.resume,
			});
			bridge.start();
			pi.setActiveTools(configured.kind === "audit" ? [...AUDIT_TOOLS] : [...previousTools, "ticketflow_report"]);
		} catch (cause) {
			pi.setActiveTools([]);
			notifyError(ctx, cause);
		}
	});
	pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${WORKER_SYSTEM_PROMPT}${kind === "audit" ? AUDIT_SYSTEM_PROMPT : ""}` }));
	pi.on("context", (event) => ({ messages: filterTicketflowContext(event.messages, "worker") }));
	pi.on("tool_call", (event) => {
		if (isTicketflowTool(event.toolName) && !isAllowedTicketflowTool(event.toolName, "worker")) return { block: true, reason: "This Ticket Flow tool is unavailable to Workers." };
		if (kind === "audit") {
			const reason = auditToolBlocked(event.toolName);
			if (reason) return { block: true, reason };
		}
	});
	pi.on("user_bash", () => kind === "audit" ? ({ result: { output: "Ticket Flow audit Workers cannot execute shell commands.", exitCode: 126, cancelled: false, truncated: false } }) : undefined);
	pi.on("input", (event, ctx) => {
		if (!/^\s*\/ticketflow(?:\s|$)/.test(event.text)) return;
		if (ctx.hasUI) ctx.ui.notify("A Ticket Flow Worker cannot start or control a nested run.", "error");
		return { action: "handled" as const };
	});
	pi.on("session_shutdown", async () => { await bridge?.close(); });
}

export default function ticketflow(pi: ExtensionAPI, options: TicketflowExtensionOptions = {}): void {
	const environment = options.environment ?? process.env;
	const role = options.role ?? (environment.TICKETFLOW_ROLE === "worker" ? "worker" : "main");
	if (role === "worker") { startWorkerRole(pi, environment); return; }

	const coordinator = options.coordinator ?? new TicketflowCoordinator();
	let widgetContext: ExtensionContext | undefined;
	coordinator.setChangeListener((run) => { if (widgetContext) showWidget(widgetContext, run); });
	let previousTools: string[] = [];
	let toolsCaptured = false;
	const captureTools = (): void => {
		if (toolsCaptured) return;
		previousTools = withoutTicketflowTools(pi.getActiveTools());
		toolsCaptured = true;
	};
	const activate = (): void => { captureTools(); pi.setActiveTools([...MAIN_TICKETFLOW_TOOLS]); };
	const deactivate = (): void => {
		const current = pi.getActiveTools();
		if (current.length === MAIN_TICKETFLOW_TOOLS.length && MAIN_TICKETFLOW_TOOLS.every((name) => current.includes(name))) pi.setActiveTools(previousTools);
		else pi.setActiveTools(withoutTicketflowTools(current));
	};
	const sessionId = (ctx: ExtensionContext): string => {
		const id = ctx.sessionManager.getSessionId();
		if (!id) throw new Error("Ticket Flow requires a persistent Main Pi session ID.");
		return id;
	};
	const attach = async (ctx: ExtensionContext): Promise<TicketflowRun> => {
		if (coordinator.activeRun) return coordinator.activeRun;
		const run = await runEffect(coordinator.recover(ctx.cwd, sessionId(ctx)), ctx.signal);
		activate();
		showWidget(ctx, run);
		return run;
	};

	registerMainTools(pi, coordinator);
	pi.registerCommand("ticketflow", {
		description: "Start or control the sequential Ticket Flow coordinator",
		getArgumentCompletions: ticketflowArgumentCompletions,
		handler: async (args, ctx) => {
			widgetContext = ctx;
			try {
				const command = parseTicketflowCommand(args);
				if (command.action === "herdr" || command.action === "cmux") {
					if (ctx.hasUI) ctx.ui.notify(`Ticket Flow ${command.action} backend is not supported yet.`, "warning");
					return;
				}
				if (command.action === "status") {
					const run = coordinator.activeRun ?? (await discoverRuns(ctx.cwd))[0]?.run;
					showWidget(ctx, run);
					if (ctx.hasUI) ctx.ui.notify(run ? `Ticket Flow ${run.phase} · ${run.id}` : "No unfinished Ticket Flow run.", run ? "info" : "warning");
					return;
				}
				if (command.action === "pause") {
					await attach(ctx);
					const run = await runEffect(coordinator.pause(), ctx.signal);
					showWidget(ctx, run);
					if (ctx.hasUI) ctx.ui.notify(run.pause?.afterCurrentWorker ? "Ticket Flow pausing after current worker." : "Ticket Flow paused.", "info");
					return;
				}
				if (command.action === "resume") {
					await attach(ctx);
					const run = await runEffect(coordinator.resumeProgression(), ctx.signal);
					activate(); showWidget(ctx, run);
					if (ctx.hasUI) ctx.ui.notify("Ticket Flow resumed.", "info");
					return;
				}
				if (command.action === "stop" || command.action === "cancel") {
					const run = await attach(ctx);
					if (!ctx.hasUI) throw new Error("Stopping Ticket Flow requires interactive confirmation.");
					const confirmed = await ctx.ui.confirm("Stop Ticket Flow?", `Terminally cancel ${run.id} and close only its verified owned Worker?`);
					if (!confirmed) return;
					const stopped = await runEffect(coordinator.stop(), ctx.signal);
					showWidget(ctx, stopped); deactivate();
					ctx.ui.notify("Ticket Flow cancelled.", "info");
					return;
				}

				assertTmuxSetupContext(ctx);
				await runEffect(coordinator.verifyBackend(), ctx.signal);
				await assertNoLegacyRun(ctx.cwd);
				const existing = await discoverRuns(ctx.cwd);
				if (existing.length > 0) {
					const choice = await ctx.ui.select("Unfinished Ticket Flow run", ["Recover existing run", "Cancel"]);
					if (choice !== "Recover existing run") return;
					const recovered = await runEffect(coordinator.recover(ctx.cwd, sessionId(ctx)), ctx.signal);
					activate(); showWidget(ctx, recovered);
					return;
				}
				const prepared = await runSetupWizard(ctx);
				if (!prepared) return;
				const run = await runEffect(coordinator.createRun({ projectPath: ctx.cwd, orchestratorSessionId: sessionId(ctx), setup: prepared.setup, tickets: prepared.tickets }), ctx.signal);
				activate(); showWidget(ctx, run);
				if (ctx.hasUI) ctx.ui.notify("Ticket Flow is ready. Ask Main to begin with ticketflow_delegate.", "info");
			} catch (cause) { notifyError(ctx, cause); }
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		widgetContext = ctx;
		try {
			captureTools();
			const runs = await discoverRuns(ctx.cwd);
			const owned = runs.find((candidate) => candidate.run.orchestratorSessionId === ctx.sessionManager.getSessionId());
			if (owned) {
				const run = await runEffect(coordinator.recover(ctx.cwd, sessionId(ctx)), ctx.signal);
				activate(); showWidget(ctx, run);
			} else {
				pi.setActiveTools(withoutTicketflowTools(pi.getActiveTools()));
				showWidget(ctx, undefined);
			}
		} catch (cause) { notifyError(ctx, cause); }
	});
	pi.on("before_agent_start", (event) => coordinator.activeRun ? ({ systemPrompt: `${event.systemPrompt}\n\n${MAIN_SYSTEM_PROMPT}` }) : undefined);
	pi.on("context", (event) => ({ messages: filterTicketflowContext(event.messages, "main") }));
	pi.on("tool_call", (event) => {
		if (isTicketflowTool(event.toolName) && !isAllowedTicketflowTool(event.toolName, "main")) return { block: true, reason: "This Ticket Flow tool is unavailable to Main." };
		if (isTicketflowTool(event.toolName) && !coordinator.activeRun) return { block: true, reason: "Ticket Flow tools require an active owned run." };
	});
	pi.on("tool_execution_end", (_event, ctx) => {
		const run = coordinator.activeRun;
		showWidget(ctx, run);
		if (run && isTerminalPhase(run.phase)) deactivate();
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		await runEffect(coordinator.shutdown()).catch(() => undefined);
		showWidget(ctx, undefined);
		widgetContext = undefined;
		coordinator.setChangeListener(undefined);
	});
}
