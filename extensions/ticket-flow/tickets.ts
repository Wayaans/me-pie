import { lstat, realpath, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Ticket, TicketflowSetup, WorkerProfile } from "./model.ts";
import { exactModelParts, THINKING_LEVELS } from "./model.ts";

export const DELEGATION_PLACEHOLDERS = ["ticketPath", "ticketName", "ticketIndex", "ticketCount", "referencePaths"] as const;
export const COMPLETION_CONVENTION = "all-markdown-checkboxes" as const;
const CHECKBOX = /^\s*[-*+]\s+\[([ xX])\]\s+(\S.*)$/gm;
const CONTROL = /[\0\r\n]/;

export interface SetupInput {
	readonly projectPath: string;
	readonly ticketsDirectory: string;
	readonly referencePaths: readonly string[];
	readonly workerProfile: WorkerProfile;
	readonly delegationTemplate: string;
}

export interface PreparedSetup {
	readonly setup: TicketflowSetup;
	readonly tickets: readonly Ticket[];
}

export function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function assertSafeText(value: string, field: string, preserveBytes = false): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${field} must be non-empty.`);
	if (value.includes("\0") || (!preserveBytes && CONTROL.test(value))) throw new Error(`${field} contains control characters.`);
	return preserveBytes ? value : normalized;
}

async function canonicalExisting(input: string, projectPath: string, expected: "file" | "directory"): Promise<string> {
	const candidate = path.isAbsolute(input) ? input : path.resolve(projectPath, input);
	const canonical = await realpath(candidate);
	const metadata = await stat(canonical);
	if (expected === "file" ? !metadata.isFile() : !metadata.isDirectory()) throw new Error(`${input} is not a ${expected}.`);
	return canonical;
}

function ticketOrder(name: string): number {
	const match = /^(\d+)(?:[-_.\s]|$)/.exec(name);
	if (!match) throw new Error(`Ticket ${name} has no unambiguous numeric filename prefix.`);
	const order = Number(match[1]);
	if (!Number.isSafeInteger(order) || order < 1) throw new Error(`Ticket ${name} has an invalid order prefix.`);
	return order;
}

export function substituteDelegationTemplate(
	template: string,
	values: Readonly<Record<(typeof DELEGATION_PLACEHOLDERS)[number], string>>,
): string {
	const unsupported = [...template.matchAll(/\{([^{}]+)\}/g)]
		.map((match) => match[1]!)
		.filter((name) => !DELEGATION_PLACEHOLDERS.includes(name as (typeof DELEGATION_PLACEHOLDERS)[number]));
	if (unsupported.length > 0) throw new Error(`Unsupported delegation placeholder: {${unsupported[0]}}.`);
	return template.replace(/\{(ticketPath|ticketName|ticketIndex|ticketCount|referencePaths)\}/g, (_marker, name: keyof typeof values) => values[name]);
}

export async function prepareSetup(input: SetupInput): Promise<PreparedSetup> {
	exactModelParts(input.workerProfile.model);
	if (!THINKING_LEVELS.includes(input.workerProfile.thinking)) throw new Error("Worker thinking level must be explicit and supported.");
	const projectPath = await realpath(input.projectPath);
	const ticketsDirectory = await canonicalExisting(assertSafeText(input.ticketsDirectory, "Tickets directory"), projectPath, "directory");
	const referencePaths = await Promise.all(input.referencePaths.map((candidate) => canonicalExisting(assertSafeText(candidate, "Reference path"), projectPath, "file")));
	const delegationTemplate = assertSafeText(input.delegationTemplate, "Delegation prompt", true);
	const names = (await readdir(ticketsDirectory, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
		.map((entry) => entry.name);
	if (names.length === 0) throw new Error("Tickets directory contains no Markdown ticket files.");
	const ordered = names.map((name) => ({ name, order: ticketOrder(name) }))
		.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name, undefined, { numeric: true }));
	for (let index = 0; index < ordered.length; index += 1) {
		const current = ordered[index]!;
		if (index > 0 && ordered[index - 1]!.order === current.order) throw new Error(`Duplicate ticket order ${current.order}: ${ordered[index - 1]!.name} and ${current.name}.`);
		if (current.order !== index + 1) throw new Error(`Missing ticket order ${index + 1}; found ${current.order} (${current.name}).`);
	}
	const referenceText = referencePaths.join("\n");
	const tickets: Ticket[] = [];
	for (let index = 0; index < ordered.length; index += 1) {
		const entry = ordered[index]!;
		const ticketPath = await realpath(path.join(ticketsDirectory, entry.name));
		const content = await readFile(ticketPath, "utf8");
		CHECKBOX.lastIndex = 0;
		const checkboxMatches = [...content.matchAll(CHECKBOX)];
		if (!checkboxMatches.length) throw new Error(`Ticket ${entry.name} has no Markdown checkbox; v1 completion requires every checkbox to be checked.`);
		const prompt = substituteDelegationTemplate(delegationTemplate, {
			ticketPath,
			ticketName: entry.name,
			ticketIndex: String(index + 1),
			ticketCount: String(ordered.length),
			referencePaths: referenceText,
		});
		if (Buffer.byteLength(prompt, "utf8") > 30 * 1024 || prompt.split("\n").length > 1_500) throw new Error(`Delegation prompt for ${entry.name} exceeds Ticket Flow transport bounds.`);
		tickets.push({ index, order: entry.order, name: entry.name, path: ticketPath, delegationPrompt: prompt, requirements: checkboxMatches.map((match) => match[2]!), status: "queued", acceptedCommitIds: [] });
	}
	return {
		setup: { ticketsDirectory, referencePaths, workerProfile: input.workerProfile, delegationTemplate, completionConvention: COMPLETION_CONVENTION },
		tickets,
	};
}

export async function isTicketComplete(ticketPath: string): Promise<boolean> {
	const metadata = await lstat(ticketPath);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || await realpath(ticketPath) !== ticketPath) throw new Error("Canonical ticket path was replaced or is not a safe regular file.");
	const content = await readFile(ticketPath, "utf8");
	CHECKBOX.lastIndex = 0;
	const matches = [...content.matchAll(CHECKBOX)];
	return matches.length > 0 && matches.every((match) => match[1]?.toLowerCase() === "x");
}
