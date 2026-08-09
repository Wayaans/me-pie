import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { WorkspaceParametersSchema, normalizeWorkspaceParameters } from "./schema.ts";
import { TmuxAdapter, type TmuxAdapterOptions } from "./tmux.ts";
import { Workspace, type WorkspaceOptions } from "./workspace.ts";
import {
	renderWorkspaceCall,
	renderWorkspaceResult,
	runWithWorkspaceWaitProgress,
} from "./tool-ui.ts";
import { MANAGED_CONTEXT_ENV, MANAGED_SNAPSHOT_TYPE, decodeManagedTaskInput, validateManagedSnapshot } from "./managed.ts";
import type { WorkspaceResult } from "./model.ts";

export interface TerminalEnvironmentExtensionOptions extends TmuxAdapterOptions, WorkspaceOptions {}

function resultText(result: WorkspaceResult): string {
	switch (result.action) {
		case "spawn": return `Spawned tmux ${result.target.paneId} in ${result.target.windowId} (${result.target.sessionId}).`;
		case "run": {
			const id = result.runId ? ` Agent Run ${result.runId}` : "";
			const readiness = result.readiness ? ` (${result.readiness})` : "";
			return `${result.spawnedTarget ? "Spawned" : "Started"} ${result.agent} in ${result.target.paneId}.${id}${readiness}.`;
		}
		case "send": {
			if (result.kind === "task") return `Queued task for Agent Run ${result.runId ?? "?"}, Work Cycle ${result.workId ?? "?"}; delivery ${result.deliveryId}.`;
			if (result.kind === "result") return `Result Received for Agent Run ${result.runId ?? "?"}, Work Cycle ${result.workId ?? "?"}; outcome ${result.outcome ?? "?"}.`;
			return `Delivered ${result.input} from ${result.sourcePaneId} to ${result.target.paneId}; recipient sequence ${result.sequence ?? 0}. To wait on ${result.sourcePaneId} for a reply from ${result.target.paneId}, use afterSequence ${result.replyAfterSequence ?? 0}.`;
		}
		case "wait": {
			if ("mode" in result && result.mode === "managed") {
				if (result.reason === "work_finished") return `Work Finished for Agent Run ${result.runId}, Work Cycle ${result.workId}; outcome ${result.outcome ?? "?"}. Result Received.\n${safeResultText(result.text ?? "")}`.trim();
				if (result.reason === "protocol_failure") return `Protocol failure for Agent Run ${result.runId}, Work Cycle ${result.workId}: Work Finished was recorded without Result Received.\n${safeResultText(result.text ?? "")}`.trim();
				return `Managed wait for Agent Run ${result.runId}, Work Cycle ${result.workId} timed out; Result Received=${result.resultReceived}, Work Finished=${result.workFinished}.`;
			}
			return result.reason === "signaled"
				? `Received a workspace send on ${result.target.paneId} from ${result.sourcePaneId} at sequence ${result.sequence}.`
				: `No workspace send reached ${result.target.paneId} before timeout. Call workspace wait again with afterSequence ${result.sequence}.`;
		}
		case "close": return result.runId
			? `Closed Agent Run ${result.runId} in tmux pane ${result.target.paneId}.`
			: `Closed tmux ${result.kind} ${result.kind === "window" ? result.target.windowId : result.target.paneId}.`;
	}
}

function bounded(text: string): string {
	const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	return truncated.truncated ? `${truncated.content}\n[workspace output truncated]` : truncated.content;
}

function safeResultText(text: string): string {
	return text
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "�");
}

export default function terminalEnvironment(
	pi: ExtensionAPI,
	options: TerminalEnvironmentExtensionOptions = {},
): void {
	let workspace: Workspace | undefined;
	let registered = false;
	let sessionAbort = new AbortController();

	const appendWorkerSnapshot = async (activeWorkspace: Workspace): Promise<void> => {
		try {
			const snapshot = await Effect.runPromise(activeWorkspace.managedSnapshot());
			const validated = validateManagedSnapshot(snapshot);
			if (!validated) return;
			pi.appendEntry(MANAGED_SNAPSHOT_TYPE, validated);
		} catch {
			// A missing or stale child ledger must not turn a normal Pi session into a failed run.
		}
	};

	const finishManagedWork = async (activeWorkspace: Workspace): Promise<boolean> => {
		let lastFailure: unknown;
		for (const delayMs of [0, 50, 200]) {
			if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
			try { return await Effect.runPromise(activeWorkspace.finishManagedWork()); }
			catch (cause) { lastFailure = cause; }
		}
		throw lastFailure;
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionAbort = new AbortController();
		try {
			const adapter = await Effect.runPromise(TmuxAdapter.detect(options), { signal: sessionAbort.signal });
			if (!adapter) return;
			workspace = new Workspace(adapter, options);
			const currentPaneId = adapter.currentTarget.paneId;
			if (!registered) pi.registerTool({
				name: "workspace",
				executionMode: "sequential",
				label: "Workspace",
				description: `Control the active terminal environment from ${currentPaneId}. Actions: spawn a tmux session/window/pane; close a tmux pane/window or a successfully launched Agent Run; run Pi, Codex, Claude, or OpenCode; send literal Markdown prompts or commands; start one managed Work Cycle per Agent Run; or wait for a raw inbox signal or a correlated durable Result Received and Work Finished pair. Every run has a UUID runId while tmux target IDs remain diagnostics. Defaults: spawn creates a detached tmux window; run without a target creates a window and starts a fresh Pi agent with no initial prompt. Send delivers raw input literally. Managed task send resolves its target from runId; managed Pi result send uses its private launch context and current-turn binding and never pastes result text into the controller terminal. Wait listens on the target inbox for raw operations and on the durable ledger for managed work. Close rejects the calling pane and its containing window; sessions cannot be closed.`,
				promptSnippet: "Spawn terminal targets, launch Agent Runs, start Work Cycles, send literal tasks or results, wait for correlated Work Finished, or explicitly close runs",
				promptGuidelines: [
					"Use workspace only for terminal-environment coordination; prefer pane IDs returned by raw workspace operations over window or session IDs.",
					"Use workspace run to start a fresh coding agent. Keep the returned runId as the authoritative Agent Run identity; tmux pane/window IDs are diagnostics and raw-operation targets.",
					`For a verified Pi Agent Run from ${currentPaneId}, use workspace send with kind=task, runId, input, and the literal text. The managed task target is resolved internally and creates a new workId and deliveryId. Do not start another Work Cycle until managed workspace wait reports Work Finished.`,
					"A managed Pi worker must report with this same workspace send action using kind=result, explicit outcome completed, blocked, or failed, and text only; do not provide targetId, runId, or workId. The private current-turn Work Cycle binding correlates the result.",
					"Managed workspace wait uses runId and optional workId and returns a durable Result Received text only after Work Finished. If Work Finished arrives without Result Received, it returns an explicit protocol failure. Result Received and Work Finished are separate facts; never infer completion from a raw inbox signal.",
					"Codex, Claude, and OpenCode runs are unverified for Work Finished even though their UUID and process-started state are persisted; never claim their work is verified.",
					`Raw workspace send and wait remain available for backward-compatible target-based coordination. Raw wait on ${currentPaneId} still uses afterSequence and reports only source-pane signals. The worker should not call workspace wait for its task.`,
					`For raw compatibility, wait with targetId ${currentPaneId} after a send baseline; if wait on ${currentPaneId} times out, call workspace wait again with the returned sequence.`,
					"Managed result send terminates the current Pi turn only. It never closes Pi, the tmux pane/window, or the Agent Run; use managed workspace close with runId when the run should actually be closed.",
				],
				parameters: WorkspaceParametersSchema,
				async execute(_toolCallId, params, signal, onUpdate, executionContext) {
					const activeWorkspace = workspace;
					if (!activeWorkspace) throw new Error("The workspace tool has no active terminal environment.");
					const request = normalizeWorkspaceParameters(params);
					const combinedSignal = signal === undefined
						? sessionAbort.signal
						: AbortSignal.any([signal, sessionAbort.signal]);
					const execute = () => Effect.runPromise(
						activeWorkspace.execute(request, executionContext.cwd),
						{ signal: combinedSignal },
					);
					const result = request.action === "wait"
						? await runWithWorkspaceWaitProgress(onUpdate, execute, "runId" in request.request ? "a managed Result Received and Work Finished pair" : "a workspace inbox signal")
						: await execute();
					return {
						content: [{ type: "text", text: bounded(resultText(result)) }],
						details: result,
						...(result.action === "send" && result.kind === "result" ? { terminate: true } : {}),
					};
				},
				renderCall: renderWorkspaceCall,
				renderResult: renderWorkspaceResult,
			});
			registered = true;
			const model = ctx.model === undefined ? undefined : { provider: ctx.model.provider, id: ctx.model.id };
			const sessionFile = ctx.sessionManager?.getSessionFile?.();
			const sessionId = ctx.sessionManager?.getSessionId?.();
			try {
				const authConfigured = ctx.model !== undefined
					&& ctx.modelRegistry.getProviderAuthStatus(ctx.model.provider).configured;
				if (process.env[MANAGED_CONTEXT_ENV] && (model === undefined || !authConfigured)) {
					throw new Error("Managed Pi readiness requires a selected model with configured provider authentication.");
				}
				const verified = model === undefined ? false : await Effect.runPromise(workspace.initializeManagedWorker({
					effectiveModel: model,
					...(ctx.thinkingLevel === undefined ? {} : { effectiveThinking: ctx.thinkingLevel }),
					...(sessionId === undefined ? {} : { sessionId }),
					...(sessionFile === undefined ? {} : { sessionFile }),
				}));
				if (verified) await appendWorkerSnapshot(workspace);
			} catch (cause) {
				// Revoke any older verified capability before exposing this failed session.
				const message = cause instanceof Error ? cause.message : String(cause);
				await Effect.runPromise(workspace.revokeManagedReadiness(message)).catch(() => undefined);
				if (ctx.hasUI && process.env[MANAGED_CONTEXT_ENV]) {
					ctx.ui.notify(`Managed Pi readiness failed: ${message}`, "warning");
				}
			}
		} catch (cause) {
			workspace = undefined;
			if (ctx.hasUI && process.env.TMUX?.trim()) {
				ctx.ui.notify(`terminal-environment disabled: ${cause instanceof Error ? cause.message : String(cause)}`, "warning");
			}
		}
	});

	pi.on("input", async (event) => {
		const activeWorkspace = workspace;
		if (!activeWorkspace) return;
		const routed = await Effect.runPromise(activeWorkspace.routeManagedInput(event.text, event.streamingBehavior)).catch(() => ({ kind: "rejected" as const }));
		if (routed.kind === "accepted") return { action: "transform" as const, text: routed.text };
		if (routed.kind === "rejected") return { action: "handled" as const };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const activeWorkspace = workspace;
		if (!activeWorkspace) return;
		if (process.env[MANAGED_CONTEXT_ENV] && (ctx.model === undefined || !ctx.modelRegistry.getProviderAuthStatus(ctx.model.provider).configured)) {
			await Effect.runPromise(activeWorkspace.revokeManagedReadiness("Managed Pi model authentication is no longer configured.")).catch(() => undefined);
			return;
		}
		let guidance = await Effect.runPromise(activeWorkspace.managedPromptGuidance()).catch(() => undefined);
		if (!guidance) {
			const routed = await Effect.runPromise(activeWorkspace.routeManagedInput(event.prompt, undefined)).catch(() => ({ kind: "rejected" as const }));
			if (routed.kind === "accepted") guidance = await Effect.runPromise(activeWorkspace.managedPromptGuidance()).catch(() => undefined);
		}
		if (!guidance) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
	});

	// Compaction retries can bypass `input`; unwrap a validated envelope before
	// the LLM sees the copied context while before_agent_start handles binding.
	pi.on("context", (event) => ({
		messages: event.messages.map((message) => {
			if (message.role !== "user") return message;
			if (typeof message.content === "string") {
				const envelope = decodeManagedTaskInput(message.content);
				return envelope ? { ...message, content: envelope.text } : message;
			}
			let changed = false;
			const content = message.content.map((block) => {
				if (block.type !== "text") return block;
				const envelope = decodeManagedTaskInput(block.text);
				if (!envelope) return block;
				changed = true;
				return { ...block, text: envelope.text };
			});
			return changed ? { ...message, content } : message;
		}),
	}));

	// Pi's internal settled event is deliberately translated to the public Work Finished fact here.
	pi.on("agent_settled", async (_event, ctx) => {
		const activeWorkspace = workspace;
		if (!activeWorkspace) return;
		await finishManagedWork(activeWorkspace).catch((cause) => {
			if (ctx.hasUI) ctx.ui.notify(`Failed to persist Work Finished: ${cause instanceof Error ? cause.message : String(cause)}`, "warning");
			return false;
		});
		await appendWorkerSnapshot(activeWorkspace);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const activeWorkspace = workspace;
		if (activeWorkspace) {
			await finishManagedWork(activeWorkspace).catch((cause) => {
				if (ctx.hasUI) ctx.ui.notify(`Failed to persist Work Finished during shutdown: ${cause instanceof Error ? cause.message : String(cause)}`, "warning");
				return false;
			});
			await appendWorkerSnapshot(activeWorkspace);
		}
		sessionAbort.abort(new Error("terminal-environment session shut down."));
		workspace = undefined;
	});
}

export { Workspace } from "./workspace.ts";
export { TmuxAdapter } from "./tmux.ts";
export { SignalStore } from "./signals.ts";
export { CoordinationLedger, CoordinationStore, boundManagedText, hashLaunchToken, isLaunchToken, sameTargetRuntime } from "./coordination.ts";
export { buildAgentInvocation } from "./agents.ts";
export { normalizeWorkspaceParameters, WorkspaceParametersSchema } from "./schema.ts";
export { renderWorkspaceCall, renderWorkspaceResult } from "./tool-ui.ts";
export { createManagedLaunchContext, decodeManagedTaskInput, encodeManagedTaskInput, managedLaunchEnvironment, readManagedLaunchContext, validateManagedSnapshot } from "./managed.ts";
export type * from "./model.ts";
export type * from "./coordination.ts";
export type * from "./managed.ts";
