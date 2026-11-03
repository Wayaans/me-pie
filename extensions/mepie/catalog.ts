import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface MepieExtension {
	readonly id: string;
	readonly description: string;
	/** Imported only when enabled, so disabled extensions never load their modules. */
	readonly load: () => Promise<{ readonly default: ExtensionFactory }>;
}

/** The only registry of Mepie extensions. The `mepie` manager loads these and cannot disable itself. */
export const MEPIE_EXTENSIONS = [
	{ id: "ask-me", description: "Ask structured interactive questions", load: () => import("../ask-me/index.ts") },
	{ id: "codemode-ui", description: "Render codemode as a live activity line with a call tree", load: () => import("../codemode-ui/index.ts") },
	{ id: "file-search", description: "Add bounded fd and rg search tools", load: () => import("../file-search/index.ts") },
	{ id: "find-docs", description: "Retrieve current Context7 documentation", load: () => import("../find-docs/index.ts") },
	{ id: "localize", description: "Translate and refine prompts into English", load: () => import("../localize/index.ts") },
	{ id: "mepie-ui", description: "Add the Mepie dashboard footer", load: () => import("../mepie-ui/index.ts") },
	{ id: "skill-shortcut", description: "Invoke skills with $skill-name", load: () => import("../skill-shortcut/index.ts") },
	{ id: "webweb", description: "Add web search, fetch, and read tools", load: () => import("../webweb/index.ts") },
] as const satisfies readonly MepieExtension[];

export type MepieExtensionId = (typeof MEPIE_EXTENSIONS)[number]["id"];

export function isMepieExtensionId(value: string): value is MepieExtensionId {
	return MEPIE_EXTENSIONS.some(({ id }) => id === value);
}
