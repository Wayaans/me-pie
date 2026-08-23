import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, Theme, type ExtensionAPI, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer } from "@earendil-works/pi-tui";

export function registerThinkingTextStyle(pi: ExtensionAPI): void {
	let restore: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		restore?.();
		restore = ctx.mode === "tui" ? useThinkingTextStyle() : undefined;
	});

	pi.on("session_shutdown", () => {
		restore?.();
		restore = undefined;
	});
}

function useThinkingTextStyle(): () => void {
	const restoreColor = useNormalThinkingColor();
	const restoreRendering = useThinkingRendering();
	return () => {
		restoreRendering();
		restoreColor();
	};
}

function useThinkingRendering(): () => void {
	const originalUpdateContent = AssistantMessageComponent.prototype.updateContent;
	const updateContentWithThinkingStyle = function (
		this: AssistantMessageComponent,
		message: AssistantMessage,
		isStreaming?: boolean,
	): void {
		Reflect.apply(originalUpdateContent, this, [message, isStreaming]);
		setRegularThinkingWeight(this);
		if (!endsWithVisibleThinking(message)) return;

		const contentContainer = this.children[0];
		if (contentContainer instanceof Container) contentContainer.addChild(new Spacer(1));
	};

	AssistantMessageComponent.prototype.updateContent = updateContentWithThinkingStyle;

	return () => {
		if (AssistantMessageComponent.prototype.updateContent === updateContentWithThinkingStyle) {
			AssistantMessageComponent.prototype.updateContent = originalUpdateContent;
		}
	};
}

function setRegularThinkingWeight(component: AssistantMessageComponent): void {
	const contentContainer = component.children[0];
	if (!(contentContainer instanceof Container)) return;

	for (const child of contentContainer.children) {
		if (!(child instanceof Markdown)) continue;

		const defaultTextStyle: unknown = Reflect.get(child, "defaultTextStyle");
		if (!isRecord(defaultTextStyle) || typeof defaultTextStyle.color !== "function") continue;

		const markdownTheme: unknown = Reflect.get(child, "theme");
		if (!isRecord(markdownTheme) || typeof markdownTheme.bold !== "function") continue;

		Reflect.set(child, "theme", { ...markdownTheme, bold: (text: string) => text });
		child.invalidate();
	}
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null;
}

function endsWithVisibleThinking(message: AssistantMessage): boolean {
	const hasToolCalls = message.content.some((content) => content.type === "toolCall");
	const hasTrailingStatus = message.stopReason === "length"
		|| (!hasToolCalls && (message.stopReason === "aborted" || message.stopReason === "error"));
	if (hasTrailingStatus) return false;

	for (let index = message.content.length - 1; index >= 0; index -= 1) {
		const content = message.content[index];
		if (content?.type === "text" && content.text.trim()) return false;
		if (content?.type === "thinking" && content.thinking.trim()) return true;
	}
	return false;
}

function useNormalThinkingColor(): () => void {
	const originalForeground = Theme.prototype.fg;
	const normalThinkingForeground = function (this: Theme, color: ThemeColor, text: string): string {
		return originalForeground.call(this, color === "thinkingText" ? "text" : color, text);
	};

	Theme.prototype.fg = normalThinkingForeground;

	return () => {
		if (Theme.prototype.fg === normalThinkingForeground) {
			Theme.prototype.fg = originalForeground;
		}
	};
}
