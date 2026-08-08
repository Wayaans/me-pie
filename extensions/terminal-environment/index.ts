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
import type { WorkspaceResult } from "./model.ts";

export interface TerminalEnvironmentExtensionOptions extends TmuxAdapterOptions, WorkspaceOptions {}

function resultText(result: WorkspaceResult): string {
	switch (result.action) {
		case "spawn": return `Spawned tmux ${result.target.paneId} in ${result.target.windowId} (${result.target.sessionId}).`;
		case "run": return `${result.spawnedTarget ? "Spawned" : "Started"} ${result.agent} in ${result.target.paneId}.`;
		case "send": return `Delivered ${result.input} from ${result.sourcePaneId} to ${result.target.paneId}; recipient sequence ${result.sequence}. To wait on ${result.sourcePaneId} for a reply from ${result.target.paneId}, use afterSequence ${result.replyAfterSequence}.`;
		case "wait": return result.reason === "signaled"
			? `Received a workspace send on ${result.target.paneId} from ${result.sourcePaneId} at sequence ${result.sequence}.`
			: `No workspace send reached ${result.target.paneId} before timeout. Call workspace wait again with afterSequence ${result.sequence}.`;
		case "close": return `Closed tmux ${result.kind} ${result.kind === "window" ? result.target.windowId : result.target.paneId}.`;
	}
}

function bounded(text: string): string {
	const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	return truncated.truncated ? `${truncated.content}\n[workspace output truncated]` : truncated.content;
}

export default function terminalEnvironment(
	pi: ExtensionAPI,
	options: TerminalEnvironmentExtensionOptions = {},
): void {
	let workspace: Workspace | undefined;
	let registered = false;
	let sessionAbort = new AbortController();

	pi.on("session_start", async (_event, ctx) => {
		sessionAbort = new AbortController();
		if (registered) return;
		try {
			const adapter = await Effect.runPromise(TmuxAdapter.detect(options), { signal: sessionAbort.signal });
			if (!adapter) return;
			workspace = new Workspace(adapter, options);
			const currentPaneId = adapter.currentTarget.paneId;
			pi.registerTool({
				name: "workspace",
				label: "Workspace",
				description: `Control the active terminal environment from ${currentPaneId}. Actions: spawn a tmux session/window/pane; close a tmux pane/window; run Pi, Codex, Claude, or OpenCode; send literal Markdown prompts or commands; or wait for an inbox signal. Defaults: spawn creates a detached tmux window; run without a target creates a window and starts a fresh Pi agent with no initial prompt. Send delivers input and signals the destination inbox from ${currentPaneId}. Wait listens on the target inbox; use ${currentPaneId} to wait for worker reports sent back to this agent. Close rejects the calling pane and its containing window; sessions cannot be closed.`,
				promptSnippet: "Spawn terminal targets, close tmux panes or windows, launch fresh coding agents, deliver terminal input, or wait on a target inbox for worker signals",
				promptGuidelines: [
					"Use workspace only for terminal-environment coordination; prefer pane IDs returned by workspace over window or session IDs.",
					"Use workspace run only to start a fresh coding agent; deliver its task afterward with workspace send.",
					`When delegating through workspace from ${currentPaneId}, tell the worker to report completion with workspace send targeting ${currentPaneId}; the worker should not call workspace wait for its task.`,
					`After delivering a task, call workspace wait with targetId ${currentPaneId} and the send result's replyAfterSequence; the wait result identifies which worker sent the signal.`,
					`If workspace wait on ${currentPaneId} times out, call workspace wait again with the returned sequence.`,
					"Treat a workspace wait signal as the worker's cooperative report, not independently verified coding-agent completion.",
					"Use workspace close with a worker's pane ID after its work and any verification are complete; do not close the calling pane or its window.",
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
						? await runWithWorkspaceWaitProgress(onUpdate, execute)
						: await execute();
					return {
						content: [{ type: "text", text: bounded(resultText(result)) }],
						details: result,
					};
				},
				renderCall: renderWorkspaceCall,
				renderResult: renderWorkspaceResult,
			});
			registered = true;
		} catch (cause) {
			workspace = undefined;
			if (ctx.hasUI && process.env.TMUX?.trim()) {
				ctx.ui.notify(`terminal-environment disabled: ${cause instanceof Error ? cause.message : String(cause)}`, "warning");
			}
		}
	});

	pi.on("session_shutdown", () => {
		sessionAbort.abort(new Error("terminal-environment session shut down."));
		workspace = undefined;
	});
}

export { Workspace } from "./workspace.ts";
export { TmuxAdapter } from "./tmux.ts";
export { SignalStore } from "./signals.ts";
export { buildAgentInvocation } from "./agents.ts";
export { normalizeWorkspaceParameters, WorkspaceParametersSchema } from "./schema.ts";
export { renderWorkspaceCall, renderWorkspaceResult } from "./tool-ui.ts";
export type * from "./model.ts";
