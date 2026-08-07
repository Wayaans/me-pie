import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderTicketflowConfirmation } from "../ticket-flow/confirmation.ts";
import {
	assertTmuxSetupContext,
	parseTicketflowCommand,
	runSetupWizard,
	ticketflowArgumentCompletions,
} from "../ticket-flow/command.ts";
import {
	createPathAttachmentProvider,
	normalizePathAttachment,
	normalizeReferenceAttachments,
} from "../ticket-flow/path-attachments.ts";
import {
	COMPLETION_CONVENTION,
	DELEGATION_PLACEHOLDERS,
	isTicketComplete,
	prepareSetup,
	substituteDelegationTemplate,
} from "../ticket-flow/tickets.ts";

async function temp(prefix: string): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeTicketDirectory(project: string, names: readonly string[], body = "- [ ] Do the work\n"): Promise<string> {
	const directory = path.join(project, "tickets");
	await mkdir(directory);
	for (const name of names) await writeFile(path.join(directory, name), body);
	return directory;
}

const profile = { model: "provider/model", thinking: "medium" as const };

function setupInput(projectPath: string, ticketsDirectory: string, template = "{ticketIndex}/{ticketCount} {ticketName} {ticketPath} {referencePaths}"): Parameters<typeof prepareSetup>[0] {
	return {
		projectPath,
		ticketsDirectory,
		referencePaths: [],
		workerProfile: profile,
		delegationTemplate: template,
	};
}

test("Ticket Flow command parsing is strict and completions are subcommand-only", () => {
	for (const action of ["tmux", "herdr", "cmux", "status", "pause", "resume", "stop", "cancel"] as const) {
		assert.deepEqual(parseTicketflowCommand(action), { action });
	}
	assert.throws(() => parseTicketflowCommand("tmux extra"), /do not accept inline arguments/);
	assert.throws(() => parseTicketflowCommand("unknown"), /Unsupported Ticket Flow command/);
	assert.throws(() => parseTicketflowCommand(""), /Usage/);
	assert.deepEqual(ticketflowArgumentCompletions("t")?.map((item) => item.value), ["tmux"]);
	assert.deepEqual(ticketflowArgumentCompletions("" )?.map((item) => item.value), ["tmux", "herdr", "cmux", "status", "pause", "resume", "stop", "cancel"]);
	assert.deepEqual(ticketflowArgumentCompletions("tmux ")?.map((item) => item.value), ["tmux"]);
});

test("tmux setup requires the interactive client to actually be inside tmux", () => {
	assert.throws(() => assertTmuxSetupContext({ mode: "rpc" }, { TMUX: "/tmp/tmux" }), /TUI mode/);
	assert.throws(() => assertTmuxSetupContext({ mode: "tui" }, {}), /inside tmux/);
	assert.doesNotThrow(() => assertTmuxSetupContext({ mode: "tui" }, { TMUX: "/tmp/tmux" }));
});

test("setup orders natural numbered tickets and substitutes the exact supported placeholders", async () => {
	const project = await temp("ticketflow-command-");
	const references = path.join(project, "reference.md");
	await writeFile(references, "reference\n");
	const ticketsDirectory = await makeTicketDirectory(project, ["3-third.md", "2-second.md", "1-first.md"]);
	const template = DELEGATION_PLACEHOLDERS.map((name) => `{${name}}`).join("|");
	const prepared = await prepareSetup({
		...setupInput(project, ticketsDirectory, template),
		referencePaths: [references],
	});
	assert.deepEqual(prepared.tickets.map((ticket) => [ticket.index, ticket.order, ticket.name]), [
		[0, 1, "1-first.md"],
		[1, 2, "2-second.md"],
		[2, 3, "3-third.md"],
	]);
	assert.equal(prepared.setup.completionConvention, COMPLETION_CONVENTION);
	assert.deepEqual(prepared.skippedTickets, []);
	const first = prepared.tickets[0]!;
	const canonicalReference = prepared.setup.referencePaths[0]!;
	assert.equal(first.delegationPrompt, `${first.path}|1-first.md|1|3|${canonicalReference}`);
	assert.equal(first.status, "queued");
	assert.ok(first.path.startsWith(prepared.setup.ticketsDirectory));
	const byteExact = await prepareSetup(setupInput(project, ticketsDirectory, "  {ticketName}\n"));
	assert.equal(byteExact.setup.delegationTemplate, "  {ticketName}\n");
	assert.equal(byteExact.tickets[0]!.delegationPrompt, "  1-first.md\n");
	assert.throws(
		() => substituteDelegationTemplate("{ticketPath} {unsupported}", {
			ticketPath: "/tickets/1.md", ticketName: "1.md", ticketIndex: "1", ticketCount: "1", referencePaths: "",
		}),
		/Unsupported delegation placeholder/,
	);
});

test("setup rejects duplicate and missing numeric ticket orders instead of silently reordering them", async () => {
	const duplicateProject = await temp("ticketflow-command-duplicate-");
	const duplicate = await makeTicketDirectory(duplicateProject, ["1-a.md", "1-b.md"]);
	await assert.rejects(prepareSetup(setupInput(duplicateProject, duplicate)), /Duplicate ticket order 1/);

	const missingProject = await temp("ticketflow-command-missing-");
	const missing = await makeTicketDirectory(missingProject, ["1-a.md", "3-c.md"]);
	await assert.rejects(prepareSetup(setupInput(missingProject, missing)), /Missing ticket order 2/);

	const badPrefixProject = await temp("ticketflow-command-prefix-");
	const badPrefix = await makeTicketDirectory(badPrefixProject, ["feature.md"]);
	await assert.rejects(prepareSetup(setupInput(badPrefixProject, badPrefix)), /unambiguous numeric filename prefix/);
});

test("setup enforces the all-Markdown-checkbox completion convention", async () => {
	const project = await temp("ticketflow-command-checkbox-");
	const mixed = await makeTicketDirectory(project, ["1-mixed.md"], "- [x] done\n- [ ] pending\n");
	const prepared = await prepareSetup(setupInput(project, mixed));
	assert.equal(prepared.setup.completionConvention, "all-markdown-checkboxes");
	assert.equal(await isTicketComplete(prepared.tickets[0]!.path), false);
	await writeFile(prepared.tickets[0]!.path, "- [x] done\n- [X] pending\n");
	assert.equal(await isTicketComplete(prepared.tickets[0]!.path), true);

	const noCheckboxProject = await temp("ticketflow-command-no-checkbox-");
	const noCheckbox = await makeTicketDirectory(noCheckboxProject, ["1-empty.md"], "A prose ticket without a task list.\n");
	await assert.rejects(prepareSetup(setupInput(noCheckboxProject, noCheckbox)), /no Markdown checkbox/);
});

test("setup excludes complete tickets and reindexes only runnable tickets", async () => {
	const project = await temp("ticketflow-command-filter-");
	const ticketsDirectory = path.join(project, "tickets");
	await mkdir(ticketsDirectory);
	await writeFile(path.join(ticketsDirectory, "1-complete.md"), "- [x] already done\n");
	await writeFile(path.join(ticketsDirectory, "2-runnable.md"), "- [x] first part\n- [ ] remaining part\n");
	await writeFile(path.join(ticketsDirectory, "3-complete.md"), "- [X] also done\n");
	const prepared = await prepareSetup(setupInput(project, ticketsDirectory));

	assert.deepEqual(prepared.tickets.map((ticket) => [ticket.index, ticket.order, ticket.name]), [
		[0, 2, "2-runnable.md"],
	]);
	assert.match(prepared.tickets[0]!.delegationPrompt, /^1\/1 2-runnable\.md /);
	assert.deepEqual(prepared.skippedTickets.map((ticket) => [ticket.order, ticket.name, ticket.reason]), [
		[1, "1-complete.md", "already-complete"],
		[3, "3-complete.md", "already-complete"],
	]);
	assert.deepEqual(prepared.setup.skippedTickets, prepared.skippedTickets);

	await writeFile(path.join(ticketsDirectory, "2-runnable.md"), "- [x] first part\n- [x] remaining part\n");
	const allComplete = await prepareSetup(setupInput(project, ticketsDirectory));
	assert.deepEqual(allComplete.tickets, []);
	assert.equal(allComplete.skippedTickets.length, 3);
});

test("setup path attachments normalize @ completion values and preserve ordinary paths", () => {
	assert.equal(normalizePathAttachment("@docs/tickets/ ", "Tickets directory"), "docs/tickets/");
	assert.equal(normalizePathAttachment('@"docs/ticket fixtures/"', "Tickets directory"), "docs/ticket fixtures/");
	assert.equal(normalizePathAttachment("docs/tickets", "Tickets directory"), "docs/tickets");
	assert.deepEqual(normalizeReferenceAttachments('@reference.md\n@"docs/reference notes.md"\n'), ["reference.md", "docs/reference notes.md"]);
	assert.throws(() => normalizePathAttachment("@first.md\n@second.md", "Tickets directory"), /exactly one path/);
	assert.throws(() => normalizePathAttachment('@"unterminated', "Reference path"), /unterminated/);
});

test("setup path autocomplete falls back to directory browsing when fd is unavailable", async () => {
	const project = await temp("ticketflow-path-autocomplete-");
	await mkdir(path.join(project, "tickets"));
	await writeFile(path.join(project, "reference.md"), "reference\n");
	const signal = new AbortController().signal;
	const directoryProvider = createPathAttachmentProvider(project, "directory", null);
	const directorySuggestions = await directoryProvider.getSuggestions(["@t"], 0, 2, { signal });
	assert.deepEqual(directorySuggestions?.items.map((item) => item.value), ["@tickets/"]);
	const fileProvider = createPathAttachmentProvider(project, "file", null);
	const fileSuggestions = await fileProvider.getSuggestions(["@r"], 0, 2, { signal });
	assert.deepEqual(fileSuggestions?.items.map((item) => item.value), ["@reference.md"]);
});

test("setup wizard asks for path attachments before the remaining fields and confirms the prepared order", async () => {
	const project = await temp("ticketflow-command-wizard-");
	const ticketsDirectory = await makeTicketDirectory(project, ["1-first.md"]);
	const reference = path.join(project, "reference.md");
	await writeFile(reference, "reference\n");
	const calls: string[] = [];
	const attachments = [`@${ticketsDirectory}`, `@${reference}`];
	const ctx = {
		cwd: project,
		model: { provider: "provider", id: "model" },
		ui: {
			custom: async () => {
				if (attachments.length > 0) {
					calls.push("custom:path attachment");
					return attachments.shift();
				}
				calls.push("custom:ticketflow confirmation");
				return true;
			},
			input: async (label: string) => { calls.push(`input:${label}`); return "provider/model"; },
			editor: async (label: string, initial: string) => { calls.push(`editor:${label}`); return initial; },
			select: async (label: string) => { calls.push(`select:${label}`); return "medium"; },
		},
	} as never;
	const prepared = await runSetupWizard(ctx);
	assert.ok(prepared);
	assert.deepEqual(calls.map((call) => call.split(":").slice(0, 2).join(":")), [
		"custom:path attachment", "custom:path attachment", "input:Model worker", "select:Thinking worker", "editor:Delegation prompt", "custom:ticketflow confirmation",
	]);
	assert.equal(prepared.tickets[0]!.name, "1-first.md");
	assert.equal(await readFile(prepared.tickets[0]!.path, "utf8"), "- [ ] Do the work\n");
});

test("setup confirmation presents a bounded, informative launch summary", async () => {
	const project = await temp("ticketflow-confirmation-");
	const ticketsDirectory = path.join(project, "tickets");
	await mkdir(ticketsDirectory);
	await writeFile(path.join(ticketsDirectory, "1-complete.md"), "- [x] done\n");
	await writeFile(path.join(ticketsDirectory, "2-build-a-very-long-feature-name.md"), "- [ ] first\n- [ ] second\n");
	const prepared = await prepareSetup(setupInput(project, ticketsDirectory));

	for (const width of [24, 48, 80, 120]) {
		const lines = renderTicketflowConfirmation(prepared, width);
		assert.ok(lines.some((line) => line.includes("TICKET FLOW")));
		assert.ok(lines.some((line) => line.includes("Implement")));
		assert.ok(lines.some((line) => line.includes("RUN SETTINGS")));
		assert.ok(lines.some((line) => line.includes("Start Ticket Flow")));
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
	}
});
