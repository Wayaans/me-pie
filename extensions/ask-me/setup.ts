import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { validToken, writeToken } from "./keychain.ts";
import { environmentOverride, readSettings, saveSettings, settingsPaths, SettingsError, validId, type SettingsPaths, type SavedDestination } from "./settings.ts";

/** Never calls Input.render. Secret text, paste buffers and undo history stay outside rendered/session data. */
export class MaskedTokenInput implements Component {
	#input = new Input();
	#closed = false;
	#received = 0;
	#error = "";
	constructor(private readonly done: (token: string | undefined) => void, private readonly refresh: () => void) {
		this.#input.onSubmit = (token) => {
			if (validToken(token.trim())) this.finish(token.trim());
			else { this.#error = "Invalid token format. Paste only the BotFather token."; this.refresh(); }
		};
		this.#input.onEscape = () => this.finish(undefined);
	}
	private finish(token: string | undefined): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#input = new Input();
		this.done(token);
	}
	cancel(): void { this.finish(undefined); }
	handleInput(data: string): void {
		if (this.#closed) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) { this.cancel(); return; }
		// Input buffers bracketed paste and undo internally. Bound their total input too.
		this.#received = Math.min(8193, this.#received + data.length);
		if (this.#received > 8192) { this.#error = "Too much input. Esc cancels; restart setup and paste only the token."; this.refresh(); return; }
		this.#input.handleInput(data);
		if (this.#input.getValue().length > 256) {
			this.#input.setValue("");
			this.#error = "Token too long. Paste only the BotFather token.";
		}
		this.refresh();
	}
	render(width: number): string[] {
		return ["Bot token. Masked, never sent to the agent.", this.#input.getValue() ? "Token: ********" : "Token: ", this.#error, "Paste token, Enter continue, Esc cancel. Backspace edits; Ctrl+U clears."].map((line) => truncateToWidth(line, width));
	}
	invalidate(): void {}
}

export async function maskedToken(ctx: ExtensionContext, signal: AbortSignal): Promise<string | undefined> {
	if (!ctx.hasUI || ctx.mode !== "tui") throw new SettingsError("ask_me setup requires the local Pi TUI for masked token entry. RPC/headless setup is not supported.");
	return ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
		const input = new MaskedTokenInput((token) => { signal.removeEventListener("abort", abort); done(token); }, () => tui.requestRender());
		const abort = () => input.cancel();
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) queueMicrotask(abort);
		return { render: (width) => input.render(width), handleInput: (data) => input.handleInput(data), invalidate: () => input.invalidate(), dispose: () => { signal.removeEventListener("abort", abort); input.cancel(); } };
	});
}

export interface SetupUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	confirm(title: string, detail: string): Promise<boolean>;
	secret(): Promise<string | undefined>;
}
export interface SetupDependencies {
	read: typeof readSettings;
	save: typeof saveSettings;
	writeToken: typeof writeToken;
	reference: () => string;
}
const defaults: SetupDependencies = { read: readSettings, save: saveSettings, writeToken, reference: randomUUID };

async function numericInput(ui: SetupUI, title: string, current: number | undefined): Promise<number | undefined> {
	let prompt = title;
	while (true) {
		const input = await ui.input(prompt, current === undefined ? "Positive numeric ID" : String(current));
		if (input === undefined) return undefined;
		const value = input.trim();
		if (/^[1-9]\d*$/.test(value) && validId(Number(value))) return Number(value);
		prompt = `${title}. Invalid ID: use a positive safe integer, not a username.`;
	}
}

/** Dialog decisions are in memory only until explicit confirmation. No live Telegram test. */
export async function setupWizard(ui: SetupUI, paths: SettingsPaths, signal: AbortSignal, dependencies: SetupDependencies = defaults): Promise<"saved" | "inherited" | "cancelled"> {
	const scope = await ui.select("Save Telegram setup for", ["Global (recommended)", "This project"]);
	if (scope === undefined || signal.aborted) return "cancelled";
	const project = scope === "This project";
	if (project && !paths.trusted) throw new SettingsError("Trust this project in Pi before configuring its Telegram override. Global setup is still available.");
	const path = project ? paths.project : paths.global;
	const existing = dependencies.read(path);
	if (project) {
		const global = dependencies.read(paths.global).destination;
		if (global) {
			const action = await ui.select("Project Telegram destination", ["Use global destination (remove project override)", "Configure separate project destination"]);
			if (action === undefined || signal.aborted) return "cancelled";
			if (action === "Use global destination (remove project override)") {
				if (!await ui.confirm("Remove project override and inherit global?", `Project settings: ${path}\nGlobal user ID: ${global.userId}\nGlobal private chat ID: ${global.chatId}\nFuture global edits apply here. Keychain items are preserved. Running bridges are unchanged.`) || signal.aborted) return "cancelled";
				await dependencies.save(path, existing, undefined, async () => {}, signal);
				return "inherited";
			}
		}
	}
	let token: string | undefined;
	let reference = existing.destination?.tokenRef;
	if (reference) {
		const action = await ui.select("Token already configured. Its value will not be displayed.", ["Keep existing token", "Replace token"]);
		if (action === undefined || signal.aborted) return "cancelled";
		if (action === "Replace token") reference = undefined;
	}
	if (!reference) {
		token = await ui.secret();
		if (token === undefined || signal.aborted) return "cancelled";
		if (!validToken(token)) throw new SettingsError("ask_me token format is invalid. No changes were saved.");
		reference = dependencies.reference();
	}
	try {
		const userId = await numericInput(ui, "Your Telegram user ID, digits only", existing.destination?.userId);
		if (userId === undefined || signal.aborted) return "cancelled";
		const chatId = await numericInput(ui, "Private bot chat ID, digits only", existing.destination?.chatId);
		if (chatId === undefined || signal.aborted) return "cancelled";
		const destination: SavedDestination = { version: 1, tokenRef: reference, userId, chatId };
		if (!await ui.confirm("Save Telegram setup?", `Scope: ${project ? "This project" : "Global"}\nSettings: ${path}\nUser ID: ${userId}\nPrivate chat ID: ${chatId}\nToken: ${token ? "new token present, save to Keychain" : "keep existing Keychain reference, not checked"}\nAFK stays unchanged. No Telegram test or running bridge restart. Existing Keychain items are preserved.`) || signal.aborted) return "cancelled";
		await dependencies.save(path, existing, destination, async () => { if (token) await dependencies.writeToken(reference, token, signal); }, signal);
		return "saved";
	} finally { token = undefined; }
}

export function runSetup(ctx: ExtensionContext, lifetime: AbortSignal) {
	return Effect.tryPromise({
		try: async (effectSignal) => {
			if (process.platform !== "darwin") throw new SettingsError("ask_me setup currently supports macOS Keychain only. Linux can still use the documented environment configuration.");
			if (!ctx.hasUI || ctx.mode !== "tui") throw new SettingsError("ask_me setup requires the local Pi TUI for masked token entry. RPC/headless setup is not supported.");
			const signal = AbortSignal.any([lifetime, effectSignal]);
			// A partial environment override must not let setup appear to fix an unusable destination.
			if (environmentOverride(process.env)) ctx.ui.notify("An explicit environment override is active. Saved settings will not be used until all three MEPIE_ASK_ME override settings are unset.", "warning");
			const result = await setupWizard({
				select: (title, options) => ctx.ui.select(title, options, { signal }),
				input: (title, placeholder) => ctx.ui.input(title, placeholder, { signal }),
				confirm: (title, detail) => ctx.ui.confirm(title, detail, { signal }),
				secret: () => maskedToken(ctx, signal),
			}, settingsPaths(ctx), signal);
			ctx.ui.notify(result === "cancelled" ? "Setup cancelled. No settings or credentials were written." : "Telegram setup saved. AFK preference is unchanged. Use /ask-me afk on when ready. Running bridges were not restarted.", "info");
		},
		catch: (error) => error instanceof SettingsError ? error : new SettingsError("ask_me setup failed. No secret values are shown. Check settings permissions and Keychain access."),
	});
}
