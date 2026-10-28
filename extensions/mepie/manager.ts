import { Effect } from "effect";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MEPIE_EXTENSIONS, type MepieExtensionId } from "./catalog.ts";
import { parseExtensionChoices, withExtensionChoices, type ExtensionChoices } from "./enablement.ts";
import { globalSettingsPath, projectSettingsPath, readSettings, updateSettings } from "./settings.ts";
import { changeToolRenderMode, type ToolRenderMode, TOOL_RENDER_MODES } from "./tool-mode.ts";

const APPLY = "Apply changes";
const CANCEL = "Cancel";
const USAGE = "Usage: /mepie or /mepie tool compact|builtin|simple|custom";

function disabledIds(choices: ExtensionChoices): Set<MepieExtensionId> {
	return new Set([...choices].filter(([, enabled]) => !enabled).map(([id]) => id));
}

/** Toggles extensions on or off. Locked ids are disabled globally and cannot change in this scope. */
async function editDisabled(
	ctx: ExtensionCommandContext,
	title: string,
	initial: ReadonlySet<MepieExtensionId>,
	locked: ReadonlySet<MepieExtensionId>,
): Promise<Set<MepieExtensionId> | undefined> {
	const disabled = new Set(initial);
	while (true) {
		const rows = MEPIE_EXTENSIONS.map(({ id, description }) => {
			const state = locked.has(id) ? "[off (global)]" : disabled.has(id) ? "[off]" : "[on] ";
			return `${state} ${id} · ${description}`;
		});
		const selected = await ctx.ui.select(title, [...rows, APPLY, CANCEL]);
		if (selected === undefined || selected === CANCEL) return undefined;
		if (selected === APPLY) return disabled;
		const extension = MEPIE_EXTENSIONS[rows.indexOf(selected)];
		if (!extension) continue;
		if (locked.has(extension.id)) {
			ctx.ui.notify(`${extension.id} is disabled globally. Enable it in the global settings first.`, "info");
		} else if (!disabled.delete(extension.id)) {
			disabled.add(extension.id);
		}
	}
}

async function manageExtensions(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/mepie requires TUI mode.", "error");
		return;
	}

	const globalPath = globalSettingsPath();
	const global = parseExtensionChoices(readSettings(globalPath));
	const scope = await ctx.ui.select("Configure Mepie extensions", ["Global", "This project"]);
	if (scope === undefined) return;

	if (scope === "Global") {
		const disabled = await editDisabled(ctx, `Mepie extensions · global · ${globalPath}`, disabledIds(global), new Set());
		if (!disabled) return;
		updateSettings(globalPath, (settings) => withExtensionChoices(settings, disabled));
		await ctx.reload();
		return;
	}

	if (!ctx.isProjectTrusted()) {
		ctx.ui.notify("Trust this project before writing project extension settings.", "warning");
		return;
	}
	const projectPath = projectSettingsPath(ctx.cwd);
	const project = parseExtensionChoices(readSettings(projectPath));
	// Project choices for globally disabled ids are kept so they apply again if the global setting changes.
	const disabled = await editDisabled(ctx, `Mepie extensions · this project · ${projectPath}`, disabledIds(project), disabledIds(global));
	if (!disabled) return;
	updateSettings(projectPath, (settings) => withExtensionChoices(settings, disabled));
	await ctx.reload();
}

export function registerMepieCommand(pi: Pick<ExtensionAPI, "registerCommand">, activeMode: ToolRenderMode): void {
	pi.registerCommand("mepie", {
		description: "Manage Mepie extensions and tool rendering",
		getArgumentCompletions(prefix) {
			const choices = ["tool", ...TOOL_RENDER_MODES.map((mode) => `tool ${mode}`)];
			const items = choices.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: (args, ctx) => Effect.runPromise(
			Effect.tryPromise({
				try: () => {
					if (args.trim().split(/\s+/)[0] === "tool") return changeToolRenderMode(args, activeMode, ctx);
					if (args.trim()) {
						if (ctx.hasUI) ctx.ui.notify(USAGE, "error");
						return Promise.resolve();
					}
					return manageExtensions(ctx);
				},
				catch: (error) => error instanceof Error ? error : new Error(String(error)),
			}),
		),
	});
}
