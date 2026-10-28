import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadEnabledExtensions } from "./loader.ts";
import { registerMepieCommand } from "./manager.ts";
import { loadToolRenderMode } from "./tool-mode.ts";

/** The package's only Pi entry point: registers `/mepie`, then loads the enabled extensions. */
export default async function mepie(pi: ExtensionAPI): Promise<void> {
	registerMepieCommand(pi, loadToolRenderMode(pi));
	const warnings = await loadEnabledExtensions(pi);
	if (warnings.length > 0) pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) for (const warning of warnings) ctx.ui.notify(warning, "warning");
	});
}
