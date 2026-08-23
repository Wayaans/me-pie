import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer } from "@earendil-works/pi-tui";

const THINKING_ICON = "󰧑";
const THINKING_RENDER_PATCH = Symbol.for("mepie.tool-ui.thinking-render-patch");

type AssistantUpdateContent = typeof AssistantMessageComponent.prototype.updateContent;

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
	return useThinkingRendering();
}

function useThinkingRendering(): () => void {
	const currentUpdateContent = AssistantMessageComponent.prototype.updateContent;
	const originalUpdateContent = originalPatchedFunction<AssistantUpdateContent>(
		currentUpdateContent,
		THINKING_RENDER_PATCH,
	);
	const updateContentWithThinkingStyle = function (
		this: AssistantMessageComponent,
		message: AssistantMessage,
		isStreaming?: boolean,
	): void {
		Reflect.apply(originalUpdateContent, this, [withThinkingIcons(message), isStreaming]);
		setRegularThinkingWeight(this);
		if (!needsTrailingSpacer(message)) return;

		const contentContainer = this.children[0];
		if (contentContainer instanceof Container) contentContainer.addChild(new Spacer(1));
	};

	Reflect.set(updateContentWithThinkingStyle, THINKING_RENDER_PATCH, { original: originalUpdateContent });
	AssistantMessageComponent.prototype.updateContent = updateContentWithThinkingStyle;

	return () => {
		if (AssistantMessageComponent.prototype.updateContent === updateContentWithThinkingStyle) {
			AssistantMessageComponent.prototype.updateContent = originalUpdateContent;
		}
	};
}

function withThinkingIcons(message: AssistantMessage): AssistantMessage {
	const content: AssistantMessage["content"] = [];

	for (let index = 0; index < message.content.length; index += 1) {
		const current = message.content[index];
		if (!current || current.type !== "thinking") {
			if (current) content.push(current);
			continue;
		}

		const thinkingBlocks: string[] = [];
		let firstVisibleBlock = current;
		for (; index < message.content.length; index += 1) {
			const block = message.content[index];
			if (!block || block.type !== "thinking") break;
			const thinking = block.thinking
				.trim()
				.replace(/\r\n?/g, "\n")
				.replace(/\n[\t ]*\n+/g, "\n");
			if (!thinking) continue;
			if (thinkingBlocks.length === 0) firstVisibleBlock = block;
			thinkingBlocks.push(thinking);
		}
		index -= 1;

		if (thinkingBlocks.length === 0) continue;
		const thinking = thinkingBlocks.join("\n");
		content.push({
			...firstVisibleBlock,
			thinking: thinking.startsWith(THINKING_ICON) ? thinking : `${THINKING_ICON} ${thinking}`,
		});
	}

	return { ...message, content };
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

function originalPatchedFunction<T extends object>(current: T, marker: symbol): T {
	const patch: unknown = Reflect.get(current, marker);
	return isRecord(patch) && typeof patch.original === "function" ? patch.original as T : current;
}

function needsTrailingSpacer(message: AssistantMessage): boolean {
	const hasToolCalls = message.content.some((content) => content.type === "toolCall");
	const hasTrailingStatus = message.stopReason === "length"
		|| (!hasToolCalls && (message.stopReason === "aborted" || message.stopReason === "error"));
	if (hasTrailingStatus) return false;

	let hasToolCallAfter = false;
	for (let index = message.content.length - 1; index >= 0; index -= 1) {
		const content = message.content[index];
		if (content?.type === "toolCall") {
			hasToolCallAfter = true;
			continue;
		}
		if (content?.type === "text" && content.text.trim()) return hasToolCallAfter;
		if (content?.type === "thinking" && content.thinking.trim()) return true;
	}
	return false;
}
