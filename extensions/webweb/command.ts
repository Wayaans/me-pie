import { loadConfig, maskKey, setConfigValue } from "./config.ts";
import { errorMessage } from "./errors.ts";

export type KeyTarget = "firecrawl" | "openai";

const KEY_FIELDS: Record<KeyTarget, string> = {
	firecrawl: "firecrawlApiKey",
	openai: "openaiApiKey",
};

const LABELS: Record<KeyTarget, string> = {
	firecrawl: "Firecrawl",
	openai: "OpenAI",
};

export interface CommandUi {
	readonly hasUI: boolean;
	readonly ui: {
		input(title: string, placeholder?: string): Promise<string | undefined>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
}

function isKeyTarget(value: string | undefined): value is KeyTarget {
	return value === "firecrawl" || value === "openai";
}

async function showStatus(ui: CommandUi["ui"], configPath: string): Promise<void> {
	let firecrawl: string | null = null;
	let openai: string | null = null;
	let model = "";
	let error: string | null = null;
	try {
		const config = loadConfig(process.env, configPath);
		firecrawl = config.firecrawlApiKey;
		openai = config.openaiApiKey;
		model = config.openaiSearchModel;
	} catch (err) {
		error = errorMessage(err);
	}
	const describe = (key: string | null, envName: string) => {
		if (key) return `configured (${maskKey(key)})`;
		if (process.env[envName]) return `configured via ${envName}`;
		return "not configured";
	};
	const lines = [
		`webweb providers`,
		`  firecrawl (primary):  ${describe(firecrawl, "FIRECRAWL_API_KEY")}`,
		`  openai (fallback):    ${describe(openai, "OPENAI_API_KEY")}`,
		`  openai search model:  ${model || "default"}`,
		`  config file:          ${configPath}`,
	];
	if (error) lines.push(`  error: ${error}`);
	lines.push("", "Commands: /webweb firecrawl · /webweb openai · /webweb clear firecrawl|openai · /webweb status");
	ui.notify(lines.join("\n"), error ? "error" : "info");
}

async function promptAndSaveKey(target: KeyTarget, ui: CommandUi, configPath: string): Promise<void> {
	const dialogs = ui.ui;
	const label = LABELS[target];
	const value = await dialogs.input(`${label} API key`, `${target === "firecrawl" ? "fc-" : "sk-"}…`);
	if (value === undefined) return;
	const trimmed = value.trim();
	if (!trimmed) {
		dialogs.notify("No key entered", "warning");
		return;
	}
	try {
		setConfigValue(KEY_FIELDS[target], trimmed, configPath);
		dialogs.notify(`${label} key saved (${maskKey(trimmed)}) to ${configPath}. It applies to the next search, no reload needed.`);
	} catch (err) {
		dialogs.notify(`Failed to save key: ${errorMessage(err)}`, "error");
	}
}

async function clearKey(target: KeyTarget, ui: CommandUi["ui"], configPath: string): Promise<void> {
	try {
		setConfigValue(KEY_FIELDS[target], null, configPath);
		ui.notify(`${LABELS[target]} key removed from ${configPath}`);
	} catch (err) {
		ui.notify(`Failed to clear key: ${errorMessage(err)}`, "error");
	}
}

/**
 * Handle `/webweb [subcommand]`.
 * firecrawl|openai: open an input box to paste the key (saved 0600, never echoed).
 * status (default): show provider configuration with masked keys.
 * clear firecrawl|openai: remove a stored key.
 */
export async function handleWebwebCommand(args: string, ui: CommandUi, configPath: string): Promise<void> {
	const [subcommand, target] = args.trim().split(/\s+/).filter(Boolean);

	if (!subcommand || subcommand === "status") {
		await showStatus(ui.ui, configPath);
		return;
	}

	if (isKeyTarget(subcommand)) {
		if (!ui.hasUI) {
			ui.ui.notify("Saving a key needs an interactive UI (TUI). Set the environment variable instead.", "error");
			return;
		}
		await promptAndSaveKey(subcommand, ui, configPath);
		return;
	}

	if (subcommand === "clear") {
		if (!isKeyTarget(target)) {
			ui.ui.notify("Usage: /webweb clear firecrawl | /webweb clear openai", "warning");
			return;
		}
		await clearKey(target, ui.ui, configPath);
		return;
	}

	ui.ui.notify(`Unknown subcommand "${subcommand}". Use: firecrawl, openai, status, clear`, "warning");
}
