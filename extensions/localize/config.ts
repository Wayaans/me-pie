import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { parse, stringify } from "yaml";

export const LOCALIZE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type LocalizeThinkingLevel = (typeof LOCALIZE_THINKING_LEVELS)[number];

export interface LocalizeConfig {
	model: string;
	thinking: LocalizeThinkingLevel;
	refinerPrompt: string;
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

export const DEFAULT_LOCALIZE_CONFIG: LocalizeConfig = {
	model: "openai-codex/gpt-5.4-mini",
	thinking: "low",
	refinerPrompt: DEFAULT_REFINER_PROMPT,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLocalizeExtension(value: unknown): boolean {
	return typeof value === "string" && value.trim().toLowerCase() === "localize";
}

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

	if (record.refinerPrompt !== undefined) {
		if (typeof record.refinerPrompt !== "string" || !record.refinerPrompt.trim()) {
			throw new Error("localize config refinerPrompt must be a non-empty string");
		}
		config.refinerPrompt = record.refinerPrompt;
	}

	return config;
}

function extractLocalizeConfig(document: unknown): Partial<LocalizeConfig> {
	if (Array.isArray(document)) {
		let config: Partial<LocalizeConfig> = {};
		for (const item of document) {
			if (!isRecord(item) || !isLocalizeExtension(item.extension)) continue;
			config = { ...config, ...parseLocalizeFields(item) };
		}
		return config;
	}

	if (!isRecord(document)) return {};
	if (isLocalizeExtension(document.extension)) return parseLocalizeFields(document);
	if (document.localize === undefined) return {};
	if (!isRecord(document.localize)) throw new Error("localize config must be a mapping");
	return parseLocalizeFields(document.localize);
}

function readYamlFile(filePath: string): unknown {
	if (!fs.existsSync(filePath)) return undefined;
	try {
		return parse(fs.readFileSync(filePath, "utf-8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse localize config at ${filePath}: ${message}`);
	}
}

function findProjectRoot(startCwd: string): string {
	let current = path.resolve(startCwd);
	while (true) {
		if (fs.existsSync(path.join(current, ".git")) || fs.existsSync(path.join(current, CONFIG_DIR_NAME))) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(startCwd);
		current = parent;
	}
}

export function getProjectLocalizeConfigPath(cwd: string): string {
	return path.join(findProjectRoot(cwd), CONFIG_DIR_NAME, "mepie", "config.yaml");
}

export function loadMergedLocalizeConfig(
	cwd: string,
	options: { includeProject?: boolean } = {},
): LocalizeConfig {
	if (options.includeProject === false) return { ...DEFAULT_LOCALIZE_CONFIG };
	const project = extractLocalizeConfig(readYamlFile(getProjectLocalizeConfigPath(cwd)));
	return {
		model: project.model ?? DEFAULT_LOCALIZE_CONFIG.model,
		thinking: project.thinking ?? DEFAULT_LOCALIZE_CONFIG.thinking,
		refinerPrompt: project.refinerPrompt ?? DEFAULT_LOCALIZE_CONFIG.refinerPrompt,
	};
}

function mergeLocalizeConfig(existingDocument: unknown, saved: LocalizeConfig): unknown {
	if (Array.isArray(existingDocument)) {
		const filtered = existingDocument.filter(
			(item) => !isRecord(item) || !isLocalizeExtension(item.extension),
		);
		return [...filtered, { extension: "localize", ...saved }];
	}

	if (existingDocument === undefined || existingDocument === null) {
		return { localize: saved };
	}

	if (!isRecord(existingDocument)) {
		throw new Error("Mepie config must be a mapping or sequence");
	}

	if (isLocalizeExtension(existingDocument.extension)) {
		const {
			extension: _extension,
			model: _model,
			thinking: _thinking,
			refinerPrompt: _refinerPrompt,
			...rest
		} = existingDocument;
		void _extension;
		void _model;
		void _thinking;
		void _refinerPrompt;
		return { ...rest, localize: saved };
	}

	return { ...existingDocument, localize: saved };
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
	if (!config.refinerPrompt.trim()) {
		throw new Error("localize config refinerPrompt must be a non-empty string");
	}

	const saved: LocalizeConfig = {
		model: `${parsedModel.provider}/${parsedModel.modelId}`,
		thinking: config.thinking,
		refinerPrompt: config.refinerPrompt,
	};
	const configPath = getProjectLocalizeConfigPath(cwd);
	const nextDocument = mergeLocalizeConfig(readYamlFile(configPath), saved);
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, stringify(nextDocument), "utf-8");
	return { path: configPath, saved };
}
