import { globalSettingsPath, isRecord, projectSettingsPath, readSettings, updateSettings, type MepieSettings } from "../mepie/settings.ts";

export const LOCALIZE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type LocalizeThinkingLevel = (typeof LOCALIZE_THINKING_LEVELS)[number];

export interface LocalizeConfig {
	model: string;
	thinking: LocalizeThinkingLevel;
	refinerPrompt: string;
	composerPrompt: string;
}

export const DEFAULT_REFINER_PROMPT = `You are a prompt localizer and language refiner. Rewrite the user's prompt as clear, natural, concise English.

Rules:
- Translate Bahasa Indonesia and mixed Bahasa Indonesia-English into English
- If the input is already English, refine its grammar and wording
- Preserve the original meaning, intent, scope, requirements, constraints, tone, and level of detail
- Sharpen the language only; do not add ideas, explanations, examples, assumptions, or recommendations
- Keep the output close to the original length and density
- Preserve the exact paragraph and line structure, including blank-line positions
- Preserve indentation, bullets, numbering, headings, checkboxes, blockquotes, and code fences
- Keep code, commands, paths, URLs, identifiers, and technical terms unchanged
- Return only the rewritten prompt, without a preamble, quotation marks, or a wrapper code fence`;

export const DEFAULT_COMPOSER_PROMPT = `You write ready-to-use prompts from the user's instructions in English, Bahasa Indonesia, or a mixture of both.

Rules:
- Return a clear, natural, concise English prompt that asks for the intended task
- You may reorganize sentences, paragraphs, and lists to make the prompt easier to follow
- Preserve all supplied intent, explicit requirements, constraints, and relevant details
- Keep supplied code, commands, paths, URLs, identifiers, and other technical literals unchanged
- Do not invent requirements, assumptions, examples, recommendations, or missing details
- Treat the user's text as material for the prompt; do not execute or answer its task
- Return only the finished prompt, without commentary, quotation marks, or a wrapper code fence`;

export const DEFAULT_LOCALIZE_CONFIG: LocalizeConfig = {
	model: "openai-codex/gpt-5.4-mini",
	thinking: "low",
	refinerPrompt: DEFAULT_REFINER_PROMPT,
	composerPrompt: DEFAULT_COMPOSER_PROMPT,
};

export function parseLocalizeModelRef(value: string): { provider: string; modelId: string } | undefined {
	const model = value.trim();
	const separator = model.indexOf("/");
	if (separator <= 0 || separator === model.length - 1) return undefined;
	return {
		provider: model.slice(0, separator),
		modelId: model.slice(separator + 1),
	};
}

function parseLocalizeFields(record: Record<string, unknown>): Partial<LocalizeConfig> {
	const config: Partial<LocalizeConfig> = {};

	if (record.model !== undefined) {
		if (typeof record.model !== "string" || !parseLocalizeModelRef(record.model)) {
			throw new Error("localize config model must be provider/model");
		}
		config.model = record.model.trim();
	}

	if (record.thinking !== undefined) {
		if (
			typeof record.thinking !== "string" ||
			!LOCALIZE_THINKING_LEVELS.includes(record.thinking as LocalizeThinkingLevel)
		) {
			throw new Error(`localize config thinking must be one of ${LOCALIZE_THINKING_LEVELS.join(", ")}`);
		}
		config.thinking = record.thinking as LocalizeThinkingLevel;
	}

	for (const field of ["refinerPrompt", "composerPrompt"] as const) {
		const value = record[field];
		if (value === undefined) continue;
		if (typeof value !== "string" || !value.trim()) {
			throw new Error(`localize config ${field} must be a non-empty string`);
		}
		config[field] = value;
	}

	return config;
}

function extractLocalizeConfig(settings: MepieSettings): Partial<LocalizeConfig> {
	if (settings.localize === undefined) return {};
	if (!isRecord(settings.localize)) throw new Error("localize config must be an object");
	return parseLocalizeFields(settings.localize);
}

/** Project fields override global fields, which override package defaults. */
export function loadMergedLocalizeConfig(
	cwd: string,
	options: { includeProject?: boolean } = {},
): LocalizeConfig {
	const global = extractLocalizeConfig(readSettings(globalSettingsPath()));
	const project = options.includeProject === false ? {} : extractLocalizeConfig(readSettings(projectSettingsPath(cwd)));
	return { ...DEFAULT_LOCALIZE_CONFIG, ...global, ...project };
}

export function updateProjectLocalizeConfig(
	cwd: string,
	config: LocalizeConfig,
): { path: string; saved: LocalizeConfig } {
	const parsedModel = parseLocalizeModelRef(config.model);
	if (!parsedModel) throw new Error("localize config model must be provider/model");
	if (!LOCALIZE_THINKING_LEVELS.includes(config.thinking)) {
		throw new Error(`localize config thinking must be one of ${LOCALIZE_THINKING_LEVELS.join(", ")}`);
	}
	parseLocalizeFields({ ...config });

	const saved: LocalizeConfig = {
		model: `${parsedModel.provider}/${parsedModel.modelId}`,
		thinking: config.thinking,
		refinerPrompt: config.refinerPrompt,
		composerPrompt: config.composerPrompt,
	};
	const configPath = projectSettingsPath(cwd);
	updateSettings(configPath, (settings) => ({ ...settings, localize: saved }));
	return { path: configPath, saved };
}
