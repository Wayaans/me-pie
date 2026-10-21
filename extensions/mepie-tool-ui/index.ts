import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerThinkingTextStyle } from "./thinking-text.ts";
import { registerMepieToolSpacing } from "./tool-renderer.ts";
import { registerMepieToolUi } from "./tools.ts";
import { loadToolRenderMode } from "../mepie/tool-mode.ts";

export default function mepieToolUi(pi: ExtensionAPI): void {
	const mode = loadToolRenderMode(pi);
	registerMepieToolUi(pi, process.cwd(), mode);
	registerMepieToolSpacing(pi, mode, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
	registerThinkingTextStyle(pi);
}
