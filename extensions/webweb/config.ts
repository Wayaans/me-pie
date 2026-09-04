import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ConfigError } from "./errors.ts";

export interface WebwebConfig {
	readonly firecrawlApiKey: string | null;
	readonly openaiApiKey: string | null;
	readonly openaiSearchModel: string;
	readonly firecrawlApiVersion: "v1" | "v2";
	readonly firecrawlBaseUrl: string;
}

export const DEFAULT_OPENAI_SEARCH_MODEL = "gpt-5-mini";

export const FIRECRAWL_DEFAULT_BASE_URL = "https://api.firecrawl.dev";
/** The legacy .app host; used as fallback when the primary host is unreachable. */
export const FIRECRAWL_FALLBACK_BASE_URL = "https://api.firecrawl.app";

export const FIRECRAWL_BASE_URL = "https://api.firecrawl.app";
export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export const SEARCH_TIMEOUT_MS = 30_000;
export const SCRAPE_TIMEOUT_MS = 60_000;
export const GITHUB_CLONE_TIMEOUT_MS = 120_000;
export const MAX_BATCH_URLS = 5;
export const MAX_BATCH_QUERIES = 4;
export const FETCH_CONCURRENCY = 3;
export const MAX_SOURCES = 20;
export const MAX_VERIFY_FETCHES = 5;

export function globalConfigPath(): string {
	return path.join(getAgentDir(), "webweb.json");
}

export function cacheDirPath(): string {
	return path.join(getAgentDir(), "webweb-cache");
}

interface ConfigFile {
	firecrawlApiKey?: unknown;
	openaiApiKey?: unknown;
	openaiSearchModel?: unknown;
	firecrawlApiVersion?: unknown;
	firecrawlBaseUrl?: unknown;
}

function readConfigFile(filePath: string): ConfigFile {
	if (!existsSync(filePath)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		throw new ConfigError({ message: `Failed to parse ${filePath}: ${errorMessage(error)}` });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ConfigError({ message: `Invalid config in ${filePath}: expected a JSON object` });
	}
	return parsed as ConfigFile;
}

function optionalKey(value: unknown, label: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || value.trim() === "") {
		throw new ConfigError({ message: `${label} must be a non-empty string when set` });
	}
	return value.trim();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Resolution order per key: environment variable first, then the global config
 * file. Keys live outside the repository so they can never be committed.
 */
export function loadConfig(
	environment: NodeJS.ProcessEnv = process.env,
	configPath: string = globalConfigPath(),
): WebwebConfig {
	const file = readConfigFile(configPath);
	const firecrawlApiKey = optionalKey(environment.FIRECRAWL_API_KEY, "FIRECRAWL_API_KEY")
		?? optionalKey(file.firecrawlApiKey, "firecrawlApiKey");
	const openaiApiKey = optionalKey(environment.OPENAI_API_KEY, "OPENAI_API_KEY")
		?? optionalKey(file.openaiApiKey, "openaiApiKey");
	const openaiSearchModel = optionalKey(environment.WEBWEB_OPENAI_MODEL, "WEBWEB_OPENAI_MODEL")
		?? optionalKey(file.openaiSearchModel, "openaiSearchModel")
		?? DEFAULT_OPENAI_SEARCH_MODEL;
	let firecrawlApiVersion: "v1" | "v2" = "v2";
	if (file.firecrawlApiVersion !== undefined) {
		if (file.firecrawlApiVersion !== "v1" && file.firecrawlApiVersion !== "v2") {
			throw new ConfigError({ message: "firecrawlApiVersion must be \"v1\" or \"v2\"" });
		}
		firecrawlApiVersion = file.firecrawlApiVersion;
	}
	const firecrawlBaseUrlRaw = optionalKey(environment.FIRECRAWL_BASE_URL, "FIRECRAWL_BASE_URL")
		?? optionalKey(file.firecrawlBaseUrl, "firecrawlBaseUrl");
	let firecrawlBaseUrl = FIRECRAWL_DEFAULT_BASE_URL;
	if (firecrawlBaseUrlRaw) {
		const parsed = new URL(firecrawlBaseUrlRaw);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new ConfigError({ message: "firecrawlBaseUrl must be an http or https URL" });
		}
		firecrawlBaseUrl = firecrawlBaseUrlRaw.replace(/\/+$/, "");
	}
	return { firecrawlApiKey, openaiApiKey, openaiSearchModel, firecrawlApiVersion, firecrawlBaseUrl };
}

export function ensureCacheDir(dirPath: string = cacheDirPath()): string {
	mkdirSync(dirPath, { recursive: true, mode: 0o700 });
	return dirPath;
}

/**
 * Persist one key in the global config file (read-modify-write, 0600 perms).
 * Passing null removes the key. Takes effect on the next tool call without a
 * reload, because loadConfig re-reads the file every time.
 */
export function setConfigValue(key: string, value: string | null, configPath: string = globalConfigPath()): void {
	let file: ConfigFile = {};
	try {
		file = readConfigFile(configPath);
	} catch {
		file = {};
	}
	const next: Record<string, unknown> = { ...file };
	if (value === null) delete next[key];
	else next[key] = value;
	mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
	writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

/** Mask a secret for display: keep the first 3 and last 4 characters. */
export function maskKey(key: string): string {
	if (key.length <= 8) return "***";
	return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
