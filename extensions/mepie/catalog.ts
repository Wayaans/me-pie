export interface MepieExtension {
	readonly id: string;
	readonly path: `extensions/${string}/index.ts`;
	readonly description: string;
	readonly configurable: boolean;
}

export const MEPIE_MANAGER_PATH = "extensions/mepie/index.ts" as const;

export const MEPIE_EXTENSIONS = [
	{ id: "mepie", path: MEPIE_MANAGER_PATH, description: "Manage Mepie extensions", configurable: false },
	{ id: "answer", path: "extensions/answer/index.ts", description: "Answer assistant questions interactively", configurable: true },
	{ id: "ask-me", path: "extensions/ask-me/index.ts", description: "Ask structured interactive questions", configurable: true },
	{ id: "checkpoint-compaction", path: "extensions/checkpoint-compaction/index.ts", description: "Create structured continuation checkpoints", configurable: true },
	{ id: "codex-usage", path: "extensions/codex-usage/index.ts", description: "Show Codex subscription usage", configurable: true },
	{ id: "file-search", path: "extensions/file-search/index.ts", description: "Add bounded fd and rg search tools", configurable: true },
	{ id: "find-docs", path: "extensions/find-docs/index.ts", description: "Retrieve current Context7 documentation", configurable: true },
	{ id: "localize", path: "extensions/localize/index.ts", description: "Translate and refine prompts into English", configurable: true },
	{ id: "mepie-tool-ui", path: "extensions/mepie-tool-ui/index.ts", description: "Render compact built-in tool rows", configurable: true },
	{ id: "mepie-ui", path: "extensions/mepie-ui/index.ts", description: "Add the Mepie header and dashboard", configurable: true },
	{ id: "pi-github", path: "extensions/pi-github/index.ts", description: "Add typed GitHub operations", configurable: true },
	{ id: "skill-shortcut", path: "extensions/skill-shortcut/index.ts", description: "Invoke skills with $skill-name", configurable: true },
	{ id: "terminal-environment", path: "extensions/terminal-environment/index.ts", description: "Add tmux-backed workspace coordination", configurable: true },
] as const satisfies readonly MepieExtension[];

export const CONFIGURABLE_EXTENSIONS = MEPIE_EXTENSIONS.filter((extension) => extension.configurable);
