import { Effect } from "effect";
import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Api,
	type AssistantMessage,
	type Model,
	type ThinkingLevel,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import {
	type LocalizeConfig,
	type LocalizeThinkingLevel,
	loadMergedLocalizeConfig,
	parseLocalizeModelRef,
	updateProjectLocalizeConfig,
} from "./config.ts";
import { projectSettingsPath } from "../mepie/settings.ts";

type CompleteSimple = typeof completeSimple;
type LocalizeMode = "compose" | "refine";
type LocalizeCommand = { mode: LocalizeMode; source: string } | { mode: "config" };

const USAGE = "Usage: /localize compose <instructions> | /localize refine <prompt> | /localize config";

export function parseLocalizeCommand(args: string): LocalizeCommand | undefined {
	const match = /^(\S+)(?:\r\n|\s)?([\s\S]*)$/.exec(args);
	if (!match) return undefined;
	const [, mode, source = ""] = match;
	if (mode === "config") return source.trim() ? undefined : { mode };
	if ((mode === "compose" || mode === "refine") && source.trim()) return { mode, source };
	return undefined;
}

const SUBCOMMANDS = [
	{ value: "compose", label: "compose", description: "Create an English prompt from instructions" },
	{ value: "refine", label: "refine", description: "Refine English wording while preserving structure" },
	{ value: "config", label: "config", description: "Edit the shared model, thinking, and prompts" },
];

export interface StructureValidationResult {
	ok: boolean;
	reason?: string;
}

function structuralPrefix(line: string): string {
	const indent = line.match(/^[\t ]*/)?.[0] ?? "";
	const content = line.slice(indent.length);
	const marker = content.match(
		/^(?:```.*|~~~.*|#{1,6}[\t ]+|>[\t ]*|[-*+][\t ]+(?:\[[ xX]\][\t ]+)?|\d+[.)][\t ]+|[A-Za-z][.)][\t ]+)/,
	)?.[0] ?? "";
	return indent + marker;
}

function protectedTokens(text: string): string[] {
	const patterns = [
		/`+[^`\n]+`+/g,
		/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()]+/gi,
		/(?:^|(?<=[\s("'`]))(?:\.{1,2}\/|~\/|\/)[^\s"'`<>),;]+/g,
		/\b[A-Za-z]:\\[^\s"'`<>|?*]+/g,
		/\\\\[^\s\\]+\\[^\s"'`<>|?*]+/g,
	];
	return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[0]));
}

function fencedCodeLines(lines: string[]): Set<number> {
	const fenced = new Set<number>();
	let activeFence: "```" | "~~~" | undefined;

	for (let index = 0; index < lines.length; index++) {
		const trimmed = lines[index]!.trimStart();
		if (!activeFence) {
			if (trimmed.startsWith("```")) {
				activeFence = "```";
				fenced.add(index);
			} else if (trimmed.startsWith("~~~")) {
				activeFence = "~~~";
				fenced.add(index);
			}
			continue;
		}

		fenced.add(index);
		if (trimmed.startsWith(activeFence)) activeFence = undefined;
	}

	return fenced;
}

export function validateLocalizedStructure(source: string, localized: string): StructureValidationResult {
	const sourceLines = source.split("\n");
	const localizedLines = localized.split("\n");

	if (sourceLines.length !== localizedLines.length) {
		return { ok: false, reason: "line count changed" };
	}

	if (JSON.stringify(protectedTokens(source)) !== JSON.stringify(protectedTokens(localized))) {
		return { ok: false, reason: "inline code, URL, or path changed" };
	}

	const codeLines = fencedCodeLines(sourceLines);
	for (let index = 0; index < sourceLines.length; index++) {
		const sourceLine = sourceLines[index]!;
		const localizedLine = localizedLines[index]!;

		if ((sourceLine.trim() === "") !== (localizedLine.trim() === "")) {
			return { ok: false, reason: `blank-line structure changed at line ${index + 1}` };
		}
		if (structuralPrefix(sourceLine) !== structuralPrefix(localizedLine)) {
			return { ok: false, reason: `formatting changed at line ${index + 1}` };
		}
		if (codeLines.has(index) && sourceLine !== localizedLine) {
			return { ok: false, reason: `fenced code changed at line ${index + 1}` };
		}
	}

	return { ok: true };
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function isProjectTrusted(ctx: ExtensionContext): boolean {
	const checkTrust = (ctx as ExtensionContext & { isProjectTrusted?: () => boolean }).isProjectTrusted;
	return checkTrust?.() ?? false;
}

function requireInteractiveTui(ctx: ExtensionContext, command: string): boolean {
	const mode = (ctx as ExtensionContext & { mode?: string }).mode;
	if (mode === undefined ? ctx.hasUI : mode === "tui") return true;
	ctx.ui.notify(`${command} requires interactive mode`, "error");
	return false;
}

export async function requestLocalizedPrompt(
	mode: LocalizeMode,
	source: string,
	config: LocalizeConfig,
	ctx: Pick<ExtensionContext, "modelRegistry"> & Partial<Pick<ExtensionContext, "model">>,
	signal: AbortSignal,
	complete: CompleteSimple = completeSimple,
): Promise<string> {
	const modelRef = parseLocalizeModelRef(config.model);
	if (!modelRef) throw new Error(`Invalid configured model: ${config.model}`);

	const configuredModel = ctx.modelRegistry.find(modelRef.provider, modelRef.modelId);
	const candidates = [configuredModel, ctx.model]
		.filter((model): model is Model<Api> => model !== undefined)
		.filter((model, index, models) =>
			models.findIndex((candidate) => candidate.provider === model.provider && candidate.id === model.id) === index,
		);
	if (candidates.length === 0) throw new Error(`Configured model not found: ${config.model}`);

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: source }],
		timestamp: Date.now(),
	};
	let response: AssistantMessage | undefined;
	let lastError: Error | undefined;

	for (const model of candidates) {
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);
			const resolvedThinking = clampThinkingLevel(model, config.thinking);
			response = await complete(
				model,
				{ systemPrompt: mode === "compose" ? config.composerPrompt : config.refinerPrompt, messages: [userMessage] },
				{
					apiKey: auth.apiKey ?? "",
					...(auth.headers ? { headers: auth.headers } : {}),
					signal,
					...(resolvedThinking === "off" ? {} : { reasoning: resolvedThinking as ThinkingLevel }),
				},
			);
			if (response.stopReason === "aborted") throw new Error("Localization cancelled");
			if (response.stopReason !== "stop") {
				throw new Error(response.errorMessage ?? `Localization stopped with ${response.stopReason}`);
			}
			break;
		} catch (error) {
			if (signal.aborted) throw new Error("Localization cancelled");
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}

	if (!response || response.stopReason !== "stop") {
		throw lastError ?? new Error("Localization failed");
	}

	const localized = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	if (!localized.trim()) throw new Error("The localization model returned no text");

	if (mode === "refine") {
		const validation = validateLocalizedStructure(source, localized);
		if (!validation.ok) {
			throw new Error(`The localization model changed the prompt structure: ${validation.reason}`);
		}
	}

	return localized;
}

async function showLocalizeConfig(ctx: ExtensionContext): Promise<void> {
	if (!requireInteractiveTui(ctx, "localize config")) return;
	if (!isProjectTrusted(ctx)) {
		ctx.ui.notify("Trust this project before saving localize configuration", "error");
		return;
	}

	let currentConfig: LocalizeConfig;
	try {
		currentConfig = loadMergedLocalizeConfig(ctx.cwd);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}

	await ctx.modelRegistry.refresh();
	const modelRefs = [...new Set(ctx.modelRegistry.getAvailable().map(modelKey))].sort((a, b) => {
		if (a === currentConfig.model) return -1;
		if (b === currentConfig.model) return 1;
		return a.localeCompare(b);
	});
	if (modelRefs.length === 0) {
		ctx.ui.notify("No authenticated models are available", "error");
		return;
	}

	const selectedModelRef = await ctx.ui.select(
		`Localize model (current: ${currentConfig.model})`,
		modelRefs,
	);
	if (!selectedModelRef) return;

	const parsedModel = parseLocalizeModelRef(selectedModelRef);
	const selectedModel = parsedModel
		? ctx.modelRegistry.find(parsedModel.provider, parsedModel.modelId)
		: undefined;
	if (!selectedModel) {
		ctx.ui.notify(`Model not found: ${selectedModelRef}`, "error");
		return;
	}

	const thinkingLevels = getSupportedThinkingLevels(selectedModel).map(String).sort((a, b) => {
		if (a === currentConfig.thinking) return -1;
		if (b === currentConfig.thinking) return 1;
		return 0;
	});
	const selectedThinking = await ctx.ui.select(
		`Localize thinking (current: ${currentConfig.thinking})`,
		thinkingLevels,
	);
	if (!selectedThinking) return;

	const composerPrompt = await ctx.ui.editor("Edit localize composer prompt", currentConfig.composerPrompt);
	if (composerPrompt === undefined) return;
	if (!composerPrompt.trim()) {
		ctx.ui.notify("Localize composer prompt cannot be empty", "error");
		return;
	}

	const refinerPrompt = await ctx.ui.editor("Edit localize refiner prompt", currentConfig.refinerPrompt);
	if (refinerPrompt === undefined) return;
	if (!refinerPrompt.trim()) {
		ctx.ui.notify("Localize refiner prompt cannot be empty", "error");
		return;
	}

	const configPath = projectSettingsPath(ctx.cwd);
	const confirmed = await ctx.ui.confirm(
		"Save localize configuration?",
		`${selectedModelRef} · thinking: ${selectedThinking}\n${configPath}`,
	);
	if (!confirmed) return;

	try {
		updateProjectLocalizeConfig(ctx.cwd, {
			model: selectedModelRef,
			thinking: selectedThinking as LocalizeThinkingLevel,
			refinerPrompt,
			composerPrompt,
		});
		ctx.ui.notify(`Localize configuration saved to ${configPath}`, "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export function registerLocalizeExtension(
	pi: Pick<ExtensionAPI, "registerCommand">,
	complete: CompleteSimple = completeSimple,
): void {
	const runWorkflow = <A>(workflow: () => Promise<A>, signal?: AbortSignal): Promise<A> =>
		Effect.runPromise(
			Effect.tryPromise({
				try: workflow,
				catch: (error) => error instanceof Error ? error : new Error(String(error)),
			}),
			{ signal },
		);

	pi.registerCommand("localize", {
		description: "Compose or refine an English prompt for editor review, or configure localize",
		getArgumentCompletions: (prefix) => {
			const items = SUBCOMMANDS.filter((item) => item.value.startsWith(prefix));
			return items.length ? items : null;
		},
		handler: (args, ctx) => runWorkflow(async () => {
			if (!requireInteractiveTui(ctx, "localize")) return;
			const command = parseLocalizeCommand(args);
			if (!command) {
				ctx.ui.notify(USAGE, "error");
				return;
			}
			if (command.mode === "config") {
				await showLocalizeConfig(ctx);
				return;
			}
			const { mode, source } = command;

			let config: LocalizeConfig;
			try {
				config = loadMergedLocalizeConfig(ctx.cwd, {
					includeProject: isProjectTrusted(ctx),
				});
			} catch (error) {
				ctx.ui.setEditorText(source);
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			let operationError: unknown;
			let cancelled = false;
			const localized = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
				const loader = new BorderedLoader(tui, theme, `Localizing with ${config.model}...`);
				loader.onAbort = () => {
					cancelled = true;
					done(null);
				};

				requestLocalizedPrompt(mode, source, config, ctx, loader.signal, complete)
					.then(done)
					.catch((error) => {
						operationError = error;
						done(null);
					});

				return loader;
			});

			if (localized === null) {
				ctx.ui.setEditorText(source);
				if (operationError) {
					ctx.ui.notify(
						`Localization failed: ${operationError instanceof Error ? operationError.message : String(operationError)}`,
						"error",
					);
				} else if (cancelled) {
					ctx.ui.notify("Localization cancelled; original prompt restored", "info");
				}
				return;
			}

			ctx.ui.setEditorText(localized);
			ctx.ui.notify("Localized prompt loaded. Review and submit when ready.", "info");
		}, ctx.signal),
	});
}

export default function (pi: ExtensionAPI): void {
	registerLocalizeExtension(pi);
}
