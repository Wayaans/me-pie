import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerThinkingTextStyle } from "./thinking-text.ts";
import { registerMepieToolUi } from "./tools.ts";

export default function mepieToolUi(pi: ExtensionAPI): void {
	registerMepieToolUi(pi, process.cwd());
	registerThinkingTextStyle(pi);
}
