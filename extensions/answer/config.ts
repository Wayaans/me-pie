import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { parse, stringify } from "yaml";

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAnswerExtension(value: unknown): boolean {
	return typeof value === "string" && value.trim().toLowerCase() === "answer";
}

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

function extractAnswerConfig(document: unknown): Partial<AnswerConfig> {
	if (Array.isArray(document)) {
		let config: Partial<AnswerConfig> = {};
		for (const item of document) {
			if (!isRecord(item) || !isAnswerExtension(item.extension)) continue;
			config = { ...config, ...parseAnswerFields(item) };
		}
		return config;
	}

	if (!isRecord(document)) return {};
	if (isAnswerExtension(document.extension)) return parseAnswerFields(document);
	if (document.answer === undefined) return {};
	if (!isRecord(document.answer)) throw new Error("answer config must be a mapping");
	return parseAnswerFields(document.answer);
}

function readYamlFile(filePath: string): unknown {
	if (!fs.existsSync(filePath)) return undefined;
	try {
		return parse(fs.readFileSync(filePath, "utf-8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse answer config at ${filePath}: ${message}`);
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

export function getProjectAnswerConfigPath(cwd: string): string {
	return path.join(findProjectRoot(cwd), CONFIG_DIR_NAME, "mepie", "config.yaml");
}

export function loadMergedAnswerConfig(
	cwd: string,
	options: { includeProject?: boolean } = {},
): AnswerConfig {
	if (options.includeProject === false) return { ...DEFAULT_ANSWER_CONFIG };
	const project = extractAnswerConfig(readYamlFile(getProjectAnswerConfigPath(cwd)));
	return {
		model: project.model ?? DEFAULT_ANSWER_CONFIG.model,
		thinking: project.thinking ?? DEFAULT_ANSWER_CONFIG.thinking,
	};
}

function mergeAnswerConfig(existingDocument: unknown, saved: AnswerConfig): unknown {
	if (Array.isArray(existingDocument)) {
		const filtered = existingDocument.filter(
			(item) => !isRecord(item) || !isAnswerExtension(item.extension),
		);
		return [...filtered, { extension: "answer", ...saved }];
	}

	if (existingDocument === undefined || existingDocument === null) {
		return { answer: saved };
	}

	if (!isRecord(existingDocument)) {
		throw new Error("Mepie config must be a mapping or sequence");
	}

	if (isAnswerExtension(existingDocument.extension)) {
		const { extension: _extension, model: _model, thinking: _thinking, ...rest } = existingDocument;
		void _extension;
		void _model;
		void _thinking;
		return { ...rest, answer: saved };
	}

	return { ...existingDocument, answer: saved };
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
	const configPath = getProjectAnswerConfigPath(cwd);
	const nextDocument = mergeAnswerConfig(readYamlFile(configPath), saved);
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, stringify(nextDocument), "utf-8");
	return { path: configPath, saved };
}
