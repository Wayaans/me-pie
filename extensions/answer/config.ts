import { globalSettingsPath, isRecord, projectSettingsPath, readSettings, updateSettings, type MepieSettings } from "../mepie/settings.ts";

export const ANSWER_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type AnswerThinkingLevel = (typeof ANSWER_THINKING_LEVELS)[number];

export interface AnswerConfig {
	model: string;
	thinking: AnswerThinkingLevel;
}

export const DEFAULT_ANSWER_CONFIG: AnswerConfig = {
	model: "openai-codex/gpt-5.4-mini",
	thinking: "medium",
};

export function parseAnswerModelRef(value: string): { provider: string; modelId: string } | undefined {
	const model = value.trim();
	const separator = model.indexOf("/");
	if (separator <= 0 || separator === model.length - 1) return undefined;
	return {
		provider: model.slice(0, separator),
		modelId: model.slice(separator + 1),
	};
}

function parseAnswerFields(record: Record<string, unknown>): Partial<AnswerConfig> {
	const config: Partial<AnswerConfig> = {};

	if (record.model !== undefined) {
		if (typeof record.model !== "string" || !parseAnswerModelRef(record.model)) {
			throw new Error("answer config model must be provider/model");
		}
		config.model = record.model.trim();
	}

	if (record.thinking !== undefined) {
		if (
			typeof record.thinking !== "string" ||
			!ANSWER_THINKING_LEVELS.includes(record.thinking as AnswerThinkingLevel)
		) {
			throw new Error(`answer config thinking must be one of ${ANSWER_THINKING_LEVELS.join(", ")}`);
		}
		config.thinking = record.thinking as AnswerThinkingLevel;
	}

	return config;
}

function extractAnswerConfig(settings: MepieSettings): Partial<AnswerConfig> {
	if (settings.answer === undefined) return {};
	if (!isRecord(settings.answer)) throw new Error("answer config must be an object");
	return parseAnswerFields(settings.answer);
}

/** Project fields override global fields, which override package defaults. */
export function loadMergedAnswerConfig(
	cwd: string,
	options: { includeProject?: boolean } = {},
): AnswerConfig {
	const global = extractAnswerConfig(readSettings(globalSettingsPath()));
	const project = options.includeProject === false ? {} : extractAnswerConfig(readSettings(projectSettingsPath(cwd)));
	return { ...DEFAULT_ANSWER_CONFIG, ...global, ...project };
}

export function updateProjectAnswerConfig(
	cwd: string,
	config: AnswerConfig,
): { path: string; saved: AnswerConfig } {
	const parsedModel = parseAnswerModelRef(config.model);
	if (!parsedModel) throw new Error("answer config model must be provider/model");
	if (!ANSWER_THINKING_LEVELS.includes(config.thinking)) {
		throw new Error(`answer config thinking must be one of ${ANSWER_THINKING_LEVELS.join(", ")}`);
	}

	const saved: AnswerConfig = {
		model: `${parsedModel.provider}/${parsedModel.modelId}`,
		thinking: config.thinking,
	};
	const configPath = projectSettingsPath(cwd);
	updateSettings(configPath, (settings) => ({ ...settings, answer: saved }));
	return { path: configPath, saved };
}
