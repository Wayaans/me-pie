import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CODEX_USAGE_STATUS_KEY,
	CodexUsageManager,
	formatCodexStatusText,
	loadCodexUsagePreferences,
	refreshCodexUsage,
	registerCodexLimitCommand,
} from "./usage.ts";

export default function (pi: ExtensionAPI): void {
	if (process.env.PI_SUBAGENT_DEPTH) {
		return;
	}

	let activeCtx: ExtensionContext | undefined;
	const manager = new CodexUsageManager(
		{
			requestRender: () => {
				if (activeCtx) {
					updateStatus(activeCtx, manager);
				}
			},
		},
		loadCodexUsagePreferences(),
	);

	refreshCodexUsage(pi, manager);
	registerCodexLimitCommand(pi, manager);

	async function refreshStatus(_event: unknown, ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		activeCtx = ctx;
		await manager.refresh(ctx);
		updateStatus(ctx, manager);
	}

	pi.on("session_start", refreshStatus);
	pi.on("model_select", refreshStatus);
	pi.on("turn_end", refreshStatus);

	pi.on("session_shutdown", async (_event, ctx) => {
		activeCtx = undefined;
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(CODEX_USAGE_STATUS_KEY, undefined);
	});
}

function updateStatus(ctx: ExtensionContext, manager: CodexUsageManager): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(
		CODEX_USAGE_STATUS_KEY,
		formatCodexStatusText(manager.snapshot, manager.footerPreferences),
	);
}
