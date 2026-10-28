import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { globalSettingsPath, readSettings, updateSettings, type MepieSettings } from "./settings.ts";

export const TOOL_RENDER_MODES = ["compact", "builtin", "simple", "custom"] as const;
export type ToolRenderMode = typeof TOOL_RENDER_MODES[number];

export function isToolRenderMode(value: unknown): value is ToolRenderMode {
	return TOOL_RENDER_MODES.some((mode) => mode === value);
}

/** Resolve the mixed mode once for both renderers and transcript spacing. */
export function toolPresentation(mode: ToolRenderMode, toolName: string): "compact" | "builtin" | "simple" | "native-preview" {
	if (mode !== "custom") return mode;
	return toolName === "edit" || toolName === "write" ? "native-preview" : "compact";
}

/** Rejects an unknown mode so a save never silently replaces a user's typo. */
function readToolSettings(agentDir: string): MepieSettings {
	const settings = readSettings(globalSettingsPath(agentDir));
	if (settings.toolRenderMode !== undefined && !isToolRenderMode(settings.toolRenderMode)) {
		throw new Error(`Cannot read ${globalSettingsPath(agentDir)}: unknown toolRenderMode. Choose compact, builtin, simple, or custom.`);
	}
	return settings;
}

export function readToolRenderMode(agentDir = getAgentDir()): { mode: ToolRenderMode; warning?: string } {
	return Effect.runSync(Effect.try({
		try: () => {
			const settings = readToolSettings(agentDir);
			return { mode: isToolRenderMode(settings.toolRenderMode) ? settings.toolRenderMode : "compact" as const };
		},
		catch: (error) => error instanceof Error ? error : new Error(String(error)),
	}).pipe(Effect.catch((error) => Effect.succeed({ mode: "compact" as const, warning: `${error.message} Using compact; the file was not changed.` }))));
}

/** Each extension reads independently so file-search also works without mepie-tool-ui. */
export function loadToolRenderMode(pi: ExtensionAPI): ToolRenderMode {
	const { mode, warning } = readToolRenderMode();
	if (warning) pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.notify(warning, "warning");
	});
	return mode;
}

export function saveToolRenderMode(mode: ToolRenderMode, agentDir = getAgentDir()) {
	return Effect.try({
		try: () => {
			// Refuse to overwrite malformed settings, including when changing the fallback mode.
			readToolSettings(agentDir);
			updateSettings(globalSettingsPath(agentDir), (settings) => ({ ...settings, toolRenderMode: mode }));
		},
		catch: (error) => new Error(`Could not save Mepie tool mode: ${error instanceof Error ? error.message : String(error)}`),
	});
}

export async function changeToolRenderMode(args: string, active: ToolRenderMode, ctx: ExtensionCommandContext): Promise<void> {
	const tokens = args.trim().split(/\s+/);
	if (tokens.length === 1) {
		if (ctx.hasUI) ctx.ui.notify(`Mepie tool mode: ${active}. Choices: compact, builtin, simple, custom.`, "info");
		return;
	}
	const mode = tokens[1];
	if (tokens.length !== 2 || !isToolRenderMode(mode)) {
		if (ctx.hasUI) ctx.ui.notify("Usage: /mepie tool compact|builtin|simple|custom", "error");
		return;
	}
	if (mode === active) return;
	await ctx.waitForIdle();
	const saved = await Effect.runPromise(saveToolRenderMode(mode).pipe(
		Effect.map(() => true),
		Effect.catch((error) => Effect.sync(() => {
			if (ctx.hasUI) ctx.ui.notify(error.message, "error");
			return false;
		})),
	));
	if (!saved) return;
	await ctx.reload();
	return;
}
