import { constants, accessSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicBorder, type ExtensionCommandContext, keyHint } from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	Container,
	Editor,
	type EditorTheme,
	Spacer,
	Text,
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

export type PathAttachmentKind = "directory" | "file";

export interface PathAttachmentEditorOptions {
	readonly title: string;
	readonly description: string;
	readonly prefill?: string;
	readonly kind: PathAttachmentKind;
	readonly multiline?: boolean;
}

function executableNames(environment: NodeJS.ProcessEnv): readonly string[] {
	if (process.platform !== "win32") return ["fd", "fdfind"];
	const extensions = (environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
	return ["fd", "fdfind"].flatMap((name) => extensions.map((extension) => `${name}${extension.toLowerCase()}`));
}

function isExecutable(candidate: string): boolean {
	try {
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function findFdExecutable(environment: NodeJS.ProcessEnv = process.env): string | null {
	const names = executableNames(environment);
	const pathCandidates = (environment.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean)
		.flatMap((directory) => names.map((name) => path.join(directory, name)));
	const extensionDirectory = path.dirname(fileURLToPath(import.meta.url));
	const bundledCandidates = names.map((name) => path.join(extensionDirectory, "..", "file-search", "bin", name));
	return [...pathCandidates, ...bundledCandidates].find(isExecutable) ?? null;
}

function attachmentTokenBeforeCursor(lines: string[], cursorLine: number, cursorCol: number): string | undefined {
	const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
	return /(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/.exec(beforeCursor)?.[1];
}

function withoutAttachmentMarker(lines: string[], cursorLine: number, cursorCol: number, token: string): { readonly lines: string[]; readonly cursorCol: number } {
	const next = [...lines];
	const current = next[cursorLine] ?? "";
	const tokenStart = cursorCol - token.length;
	next[cursorLine] = `${current.slice(0, tokenStart)}${token.slice(1)}${current.slice(cursorCol)}`;
	return { lines: next, cursorCol: cursorCol - 1 };
}

function withAttachmentMarker(item: AutocompleteItem): AutocompleteItem {
	return { ...item, value: item.value.startsWith("@") ? item.value : `@${item.value}` };
}

function keepKind(suggestions: AutocompleteSuggestions | null, kind: PathAttachmentKind): AutocompleteSuggestions | null {
	if (!suggestions || kind === "file") return suggestions;
	const items = suggestions.items.filter((item) => item.label.endsWith("/"));
	return items.length > 0 ? { ...suggestions, items } : null;
}

export function createPathAttachmentProvider(cwd: string, kind: PathAttachmentKind, fdPath = findFdExecutable()): AutocompleteProvider {
	const combined = new CombinedAutocompleteProvider([], cwd, fdPath);
	return {
		triggerCharacters: ["@"],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const suggestions = keepKind(await combined.getSuggestions(lines, cursorLine, cursorCol, options), kind);
			if (suggestions) return suggestions;

			// CombinedAutocompleteProvider uses fd for fuzzy @ completion. Preserve
			// directory-by-directory @ completion when fd is unavailable.
			const token = attachmentTokenBeforeCursor(lines, cursorLine, cursorCol);
			if (!token) return null;
			const fallback = withoutAttachmentMarker(lines, cursorLine, cursorCol, token);
			const local = keepKind(await combined.getSuggestions(fallback.lines, cursorLine, fallback.cursorCol, { ...options, force: true }), kind);
			return local ? { prefix: token, items: local.items.map(withAttachmentMarker) } : null;
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return combined.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return combined.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
		},
	};
}

export function normalizePathAttachment(value: string, field: string): string {
	let normalized = value.trim();
	if (!normalized) throw new Error(`${field} must be non-empty.`);
	if (normalized.includes("\n") || normalized.includes("\r")) throw new Error(`${field} must contain exactly one path.`);
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized.startsWith('"')) {
		if (!normalized.endsWith('"') || normalized.length < 2) throw new Error(`${field} has an unterminated quoted path.`);
		normalized = normalized.slice(1, -1);
	}
	if (!normalized) throw new Error(`${field} must be non-empty.`);
	return normalized;
}

export function normalizeReferenceAttachments(value: string | undefined): string[] {
	return (value ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line, index) => normalizePathAttachment(line, `Reference path ${index + 1}`));
}

export async function editPathAttachments(ctx: ExtensionCommandContext, options: PathAttachmentEditorOptions): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const editorTheme: EditorTheme = {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		};
		const editor = new Editor(tui, editorTheme, { autocompleteMaxVisible: 8 });
		editor.setAutocompleteProvider(createPathAttachmentProvider(ctx.cwd, options.kind));
		if (options.prefill) editor.setText(options.prefill);
		editor.onSubmit = (value) => done(value);

		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", theme.bold(options.title)), 1, 0));
		container.addChild(new Text(theme.fg("muted", options.description), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(editor);
		container.addChild(new Spacer(1));
		const hints = [
			"@ browse paths",
			keyHint("tui.select.confirm", "submit"),
			...(options.multiline ? [keyHint("tui.input.newLine", "new line")] : []),
			keyHint("tui.select.cancel", "cancel"),
		];
		container.addChild(new Text(theme.fg("dim", hints.join(" · ")), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

		return {
			get focused(): boolean { return editor.focused; },
			set focused(value: boolean) { editor.focused = value; },
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (keybindings.matches(data, "tui.select.cancel") && !editor.isShowingAutocomplete()) {
					done(undefined);
					return;
				}
				editor.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
