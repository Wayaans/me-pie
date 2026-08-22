import { Theme, type ExtensionAPI, type ThemeColor } from "@earendil-works/pi-coding-agent";

export function registerThinkingTextStyle(pi: ExtensionAPI): void {
	let restoreTheme: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		restoreTheme?.();
		restoreTheme = ctx.mode === "tui" ? useDimThinkingText() : undefined;
	});

	pi.on("session_shutdown", () => {
		restoreTheme?.();
		restoreTheme = undefined;
	});
}

function useDimThinkingText(): () => void {
	const originalForeground = Theme.prototype.fg;
	const dimThinkingForeground = function (this: Theme, color: ThemeColor, text: string): string {
		return originalForeground.call(this, color === "thinkingText" ? "dim" : color, text);
	};

	Theme.prototype.fg = dimThinkingForeground;

	return () => {
		if (Theme.prototype.fg === dimThinkingForeground) {
			Theme.prototype.fg = originalForeground;
		}
	};
}
