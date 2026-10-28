import { getAgentDir, ProjectTrustStore, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MEPIE_EXTENSIONS, type MepieExtension, type MepieExtensionId } from "./catalog.ts";
import { isExtensionEnabled, parseExtensionChoices, type ExtensionChoices } from "./enablement.ts";
import { globalSettingsPath, projectSettingsPath, readSettings } from "./settings.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readChoices(path: string, warnings: string[]): ExtensionChoices {
	try {
		return parseExtensionChoices(readSettings(path));
	} catch (error) {
		warnings.push(`Ignoring Mepie extension settings in ${path}: ${errorMessage(error)}`);
		return new Map();
	}
}

/**
 * Pi gives factories neither the session cwd nor the trust decision, so the project file is read
 * from the process cwd. It is skipped only for explicitly distrusted projects; a project can only
 * disable extensions, never re-enable one that is disabled globally.
 */
function projectChoices(cwd: string, agentDir: string, warnings: string[]): ExtensionChoices {
	if (new ProjectTrustStore(agentDir).get(cwd) === false) return new Map();
	return readChoices(projectSettingsPath(cwd), warnings);
}

export interface LoadOptions {
	readonly cwd?: string;
	readonly agentDir?: string;
	readonly extensions?: readonly { readonly id: MepieExtensionId; readonly load: MepieExtension["load"] }[];
}

/** Loads enabled extensions in catalog order. One failing extension does not block the rest. */
export async function loadEnabledExtensions(pi: ExtensionAPI, options: LoadOptions = {}): Promise<readonly string[]> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const warnings: string[] = [];
	const global = readChoices(globalSettingsPath(agentDir), warnings);
	const project = projectChoices(cwd, agentDir, warnings);

	for (const extension of options.extensions ?? MEPIE_EXTENSIONS) {
		if (!isExtensionEnabled(extension.id, global, project)) continue;
		try {
			const module = await extension.load();
			await module.default(pi);
		} catch (error) {
			warnings.push(`Mepie could not load ${extension.id}: ${errorMessage(error)}`);
		}
	}
	return warnings;
}
