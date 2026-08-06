import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	assertTmuxSetupContext,
	parseTicketflowCommand,
	runSetupWizard,
	ticketflowArgumentCompletions,
} from "../ticket-flow/command.ts";
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

test("setup wizard asks questions in its documented order and confirms the prepared natural order", async () => {
	const project = await temp("ticketflow-command-wizard-");
	const ticketsDirectory = await makeTicketDirectory(project, ["1-first.md"]);
	const reference = path.join(project, "reference.md");
	await writeFile(reference, "reference\n");
	const calls: string[] = [];
	const ctx = {
		cwd: project,
		model: { provider: "provider", id: "model" },
		ui: {
			input: async (label: string) => { calls.push(`input:${label}`); return label === "Tickets" ? ticketsDirectory : "provider/model"; },
			editor: async (label: string, initial: string) => { calls.push(`editor:${label}`); return label === "Other Reference" ? reference : initial; },
			select: async (label: string) => { calls.push(`select:${label}`); return "medium"; },
			confirm: async (label: string, message: string) => { calls.push(`confirm:${label}:${message.includes("1-first.md")}`); return true; },
		},
	} as never;
	const prepared = await runSetupWizard(ctx);
	assert.ok(prepared);
	assert.deepEqual(calls.map((call) => call.split(":").slice(0, 2).join(":")), [
		"input:Tickets", "editor:Other Reference", "input:Model worker", "select:Thinking worker", "editor:Delegation prompt", "confirm:Start Ticket Flow?",
	]);
	assert.match(calls.at(-1)!, /true$/);
	assert.equal(prepared.tickets[0]!.name, "1-first.md");
	assert.equal(await readFile(prepared.tickets[0]!.path, "utf8"), "- [ ] Do the work\n");
});
