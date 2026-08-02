import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";

const DELIMITERS = new Set([" ", "\t", "\n"]);
const DOLLAR_SKILL_PATTERN = /(?:^|(?<=\s))\$([a-z0-9][a-z0-9-]*)/g;

type SkillCommand = {
	name: string;
	description?: string;
};

type SkillShortcutInputEvent = {
	text: string;
};

type SkillShortcutInputResult =
	| { action: "transform"; text: string }
	| { action: "continue" };

export function extractDollarPrefix(textBeforeCursor: string): string | null {
	for (let index = textBeforeCursor.length - 1; index >= 0; index -= 1) {
		if (DELIMITERS.has(textBeforeCursor[index]!)) {
			const token = textBeforeCursor.slice(index + 1);
			return token.startsWith("$") ? token : null;
		}
	}
	return textBeforeCursor.startsWith("$") ? textBeforeCursor : null;
}

export function transformSkillShortcuts(text: string, skillNames: readonly string[]): string {
	const knownSkills = new Set(skillNames);
	return text.replace(DOLLAR_SKILL_PATTERN, (match, name: string) =>
		knownSkills.has(name) ? match.replace(`$${name}`, `/skill:${name}`) : match,
	);
}

export function createSkillShortcutInputHandler(
	getSkillNames: () => readonly string[],
): (event: SkillShortcutInputEvent) => SkillShortcutInputResult {
	return (event) => {
		const transformed = transformSkillShortcuts(event.text, getSkillNames());
		return transformed === event.text
			? { action: "continue" }
			: { action: "transform", text: transformed };
	};
}

export default function skillShortcut(pi: ExtensionAPI): void {
	const getSkillCommands = (): SkillCommand[] =>
		pi.getCommands()
			.filter((command) => command.source === "skill")
			.map((command) => ({
				name: command.name.replace(/^skill:/, ""),
				...(command.description ? { description: command.description } : {}),
			}));

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: ["$"],
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
				const prefix = extractDollarPrefix(beforeCursor);
				if (prefix === null) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}

				const query = prefix.slice(1);
				const items = fuzzyFilter(
					getSkillCommands().map((command) => ({
						value: command.name,
						label: command.name,
						...(command.description ? { description: command.description } : {}),
					})),
					query,
					(item) => item.value,
				);
				return { items, prefix };
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				if (!prefix.startsWith("$")) {
					return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				}
				const line = lines[cursorLine] ?? "";
				const before = line.slice(0, cursorCol - prefix.length);
				const after = line.slice(cursorCol);
				const separator = after === "" || /^[ \t]/.test(after) ? "" : " ";
				const completed = `${before}$${item.value}${separator}${after}`;
				return {
					lines: [...lines.slice(0, cursorLine), completed, ...lines.slice(cursorLine + 1)],
					cursorLine,
					cursorCol: before.length + item.value.length + 1 + separator.length,
				};
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	});

	pi.on("input", createSkillShortcutInputHandler(() => getSkillCommands().map(({ name }) => name)));
}
