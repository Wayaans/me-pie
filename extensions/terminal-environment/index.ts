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
		case "send": return `Delivered ${result.input} to ${result.target.paneId}; signal sequence ${result.sequence}.`;
		case "wait": return result.reason === "signaled"
			? `Target ${result.target.paneId} was signaled at sequence ${result.sequence}.`
			: result.reason === "timeout"
				? `Wait for ${result.target.paneId} timed out at sequence ${result.sequence}.`
				: `Target ${result.target.paneId} exited while waiting.`;
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
			pi.registerTool({
				name: "workspace",
				label: "Workspace",
				description: "Control the active terminal environment. Actions: spawn a tmux session/window/pane; run Pi, Codex, Claude, or OpenCode; send literal Markdown prompts or commands; or wait for a later successful workspace send signal. Defaults: spawn creates a detached window in the current tmux session; run without a target spawns a window and starts Pi. Wait observes send signals, not coding-agent completion.",
				promptSnippet: "Spawn terminal targets, launch coding agents, send terminal input, or wait for workspace send signals",
				promptGuidelines: [
					"Use workspace only for terminal-environment coordination; prefer pane IDs returned by workspace over window or session IDs.",
					"Treat workspace wait as send-event synchronization, not proof that a coding agent completed its turn.",
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
