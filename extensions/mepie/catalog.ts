import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface MepieExtension {
	readonly id: string;
	readonly description: string;
	/** Imported only when enabled, so disabled extensions never load their modules. */
	readonly load: () => Promise<{ readonly default: ExtensionFactory }>;
}

/** The only registry of Mepie extensions. The `mepie` manager loads these and cannot disable itself. */
export const MEPIE_EXTENSIONS = [
	{ id: "answer", description: "Answer assistant questions interactively", load: () => import("../answer/index.ts") },
	{ id: "ask-me", description: "Ask structured interactive questions", load: () => import("../ask-me/index.ts") },
	{ id: "checkpoint-compaction", description: "Create structured continuation checkpoints", load: () => import("../checkpoint-compaction/index.ts") },
	{ id: "codex-usage", description: "Show Codex subscription usage", load: () => import("../codex-usage/index.ts") },
	{ id: "file-search", description: "Add bounded fd and rg search tools", load: () => import("../file-search/index.ts") },
	{ id: "find-docs", description: "Retrieve current Context7 documentation", load: () => import("../find-docs/index.ts") },
	{ id: "localize", description: "Translate and refine prompts into English", load: () => import("../localize/index.ts") },
	{ id: "mepie-tool-ui", description: "Render compact built-in tool rows", load: () => import("../mepie-tool-ui/index.ts") },
	{ id: "mepie-ui", description: "Add the Mepie dashboard footer", load: () => import("../mepie-ui/index.ts") },
	{ id: "pi-github", description: "Add typed GitHub operations", load: () => import("../pi-github/index.ts") },
	{ id: "skill-shortcut", description: "Invoke skills with $skill-name", load: () => import("../skill-shortcut/index.ts") },
	{ id: "terminal-environment", description: "Add tmux-backed workspace coordination", load: () => import("../terminal-environment/index.ts") },
	{ id: "webweb", description: "Add web search, fetch, and read tools", load: () => import("../webweb/index.ts") },
] as const satisfies readonly MepieExtension[];

export type MepieExtensionId = (typeof MEPIE_EXTENSIONS)[number]["id"];

export function isMepieExtensionId(value: string): value is MepieExtensionId {
	return MEPIE_EXTENSIONS.some(({ id }) => id === value);
}
