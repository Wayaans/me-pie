import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { codemodeRenderers } from "./render.ts";

/** Draw codemode rows as a live activity line, with the script's nested tool calls as a tree when expanded. */
export default function codemodeUi(pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, next) => (toolName === "codemode" ? codemodeRenderers : next()));
}
