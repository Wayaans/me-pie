import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { Effect } from "effect";
import { remoteProgressText, remoteQuestionnaire, type RemoteHandle, type RemoteProgress } from "./bridge-client.ts";
import { compactTelegramLabel } from "./telegram-view.ts";
import { draftDetails, type AskMeDraft } from "./draft.ts";
import type { AskMeDetails, AskMeRequest } from "./schema.ts";
import { record } from "./telegram.ts";
import { describeDestination, loadTelegramConfig, resolveDestination, settingsPaths, type Destination } from "./settings.ts";
import { runSetup } from "./setup.ts";

const PREFERENCE_ENTRY = "ask-me-afk";
export type RoutingStatus =
	| { kind: "local" | "afk" }
	| { kind: "remote"; progress: RemoteProgress }
	| { kind: "error"; route: "local" | "telegram"; message: string; requestId?: string };

export function routingFooter(status: RoutingStatus): string | undefined {
	switch (status.kind) {
		case "local": return undefined;
		case "afk": return "☾ AFK";
		case "error": return status.route === "telegram" ? "✗ AFK error" : "✗ ask-me error";
		case "remote": {
			const progress = status.progress;
			switch (progress.phase) {
				case "connecting": return "◌ AFK connecting";
				case "sending": return "◌ AFK sending";
				case "waiting": return `? AFK ${progress.answered}/${progress.total}`;
				case "writing": return `? AFK writing ${progress.answered}/${progress.total}`;
			}
		}
	}
}

function statusDetails(status: RoutingStatus): string {
	switch (status.kind) {
		case "local": return "Local";
		case "afk": return "Telegram connects on the next ask_me.";
		case "remote": return `${remoteProgressText(status.progress)}\nRequest ${status.progress.id}`;
		case "error": return `${status.route === "telegram" ? "Telegram" : "Local"} request failed. ${status.message}${status.requestId ? `\nRequest ${status.requestId}` : ""}`;
	}
}
export type LocalQuestionnaire = (ctx: ExtensionContext, request: AskMeRequest, signal: AbortSignal, draft: AskMeDraft, sendToTelegram: () => boolean) => Promise<AskMeDetails>;

export function restoreAfk(branch: readonly unknown[]): boolean {
	let afk = false;
	for (const entry of branch) {
		if (record(entry) && entry.type === "custom" && entry.customType === PREFERENCE_ENTRY && record(entry.data) && typeof entry.data.enabled === "boolean") afk = entry.data.enabled;
	}
	return afk;
}

export class AskMeRouting {
	private afk = false;
	private lifetime = new AbortController();
	private remote: RemoteHandle | undefined;
	private status: RoutingStatus = { kind: "local" };
	private running = false;
	private settingUp = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly remoteRunner = remoteQuestionnaire,
		private readonly checkConfig?: (ctx: ExtensionContext) => void,
		private readonly loadConfig = loadTelegramConfig,
		private readonly destinationForContext: (ctx: ExtensionContext) => Destination | undefined = (ctx) => resolveDestination(settingsPaths(ctx)),
	) {
		pi.registerFlag("afk", { type: "boolean", default: false, description: "Route ask_me to the configured private Telegram chat for this session" });
		pi.on("session_start", (event, ctx) => {
			this.lifetime = new AbortController();
			this.afk = restoreAfk(ctx.sessionManager.getBranch());
			if (event.reason === "startup" && pi.getFlag("afk") === true) {
				this.afk = true;
				pi.appendEntry(PREFERENCE_ENTRY, { enabled: true });
			}
			this.setStatus(ctx, { kind: this.afk ? "afk" : "local" });
		});
		pi.on("session_tree", async (_event, ctx) => {
			const pending = this.remote;
			this.lifetime.abort();
			pending?.stop("cancel");
			await pending?.result.catch(() => {});
			this.lifetime = new AbortController();
			this.afk = restoreAfk(ctx.sessionManager.getBranch());
			this.setStatus(ctx, { kind: this.afk ? "afk" : "local" });
		});
		pi.on("session_shutdown", async (_event, ctx) => {
			const pending = this.remote;
			this.lifetime.abort();
			pending?.stop("cancel");
			await pending?.result.catch(() => {});
			if (ctx.hasUI) ctx.ui.setStatus("ask-me", undefined);
		});
		pi.registerCommand("ask-me", {
			description: "ask-me setup, ask-me afk [on|off], or ask-me status",
			getArgumentCompletions: (prefix) => ["setup", "afk", "afk on", "afk off", "status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
			handler: async (args, ctx) => {
				if (args.trim() === "setup") {
					if (this.running || this.settingUp) throw new Error("Finish the pending ask_me questionnaire or setup before starting another setup.");
					this.settingUp = true;
					try { await Effect.runPromise(runSetup(ctx, this.lifetime.signal)); }
					finally { this.settingUp = false; }
					return;
				}
				await Effect.runPromise(Effect.sync(() => {
					const command = args.trim();
					if (command === "afk" || command === "afk on" || command === "afk off") {
						const enabled = command === "afk" ? !this.afk : command === "afk on";
						this.setAfk(enabled, ctx);
						if (!enabled) this.remote?.stop(ctx.hasUI && ctx.mode !== "json" && ctx.mode !== "print" ? "handoff" : "cancel");
					} else if (command !== "status") throw new Error("Usage: /ask-me setup, /ask-me afk [on|off], or /ask-me status");
					let configuration = "";
					if (command === "status") {
						try { configuration = describeDestination(this.destinationForContext(ctx)); }
						catch (error) { configuration = error instanceof Error ? error.message : "Configuration unavailable; no fallback was made."; }
					}
					if (ctx.hasUI) ctx.ui.notify(`ask_me ${this.afk ? "AFK on" : "AFK off"}. ${statusDetails(this.status)}${configuration ? `\n${configuration}` : ""}`, "info");
				}));
			},
		});
	}

	private setStatus(ctx: ExtensionContext, status: RoutingStatus): void {
		this.status = status;
		if (!ctx.hasUI) return;
		const text = routingFooter(status);
		const color = status.kind === "error" ? "error" : status.kind === "remote" ? "warning" : "dim";
		ctx.ui.setStatus("ask-me", text && ctx.mode === "tui" ? ctx.ui.theme.fg(color, text) : text);
	}

	private requireConfig(ctx: ExtensionContext): Destination {
		const destination = this.destinationForContext(ctx);
		if (!destination) throw new Error("ask_me AFK is not configured. Run /ask-me setup in the local Pi terminal first.");
		return destination;
	}

	private setAfk(enabled: boolean, ctx: ExtensionContext): void {
		if (enabled) {
			if (this.checkConfig) this.checkConfig(ctx);
			else this.requireConfig(ctx);
		}
		this.afk = enabled;
		this.pi.appendEntry(PREFERENCE_ENTRY, { enabled });
		if (!this.running) this.setStatus(ctx, { kind: enabled ? "afk" : "local" });
	}

	async run(ctx: ExtensionContext, request: AskMeRequest, signal: AbortSignal | undefined, local: LocalQuestionnaire, progress: (status: string) => void): Promise<AskMeDetails> {
		if (this.running || this.settingUp) throw new Error("ask_me already has a pending questionnaire or setup in this Pi instance");
		this.running = true;
		const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
		let draft: AskMeDraft = { answers: [] };
		let route: "local" | "telegram" = "local";
		let lastProgress: RemoteProgress | undefined;
		let failed = false;
		try {
			while (!combined.aborted) {
				if (this.afk) {
					route = "telegram";
					const session = this.pi.getSessionName() ?? `session ${ctx.sessionManager.getSessionId().slice(0, 8)}`;
					const label = `${compactTelegramLabel(basename(ctx.cwd), 32)} / ${compactTelegramLabel(session, 44)}`;
					this.remote = this.remoteRunner(request, draft, label, combined, (status) => {
						if (combined.aborted) return;
						lastProgress = status;
						this.setStatus(ctx, { kind: "remote", progress: status });
						progress(remoteProgressText(status));
					}, undefined, undefined,
						(signal) => Effect.runPromise(this.loadConfig(this.requireConfig(ctx), signal), { signal }));
					const result = await this.remote.result;
					this.remote = undefined;
					draft = result.details;
					if (!result.handoff || combined.aborted) return result.details;
				} else {
					route = "local";
					this.setStatus(ctx, { kind: "local" });
					if (!ctx.hasUI || ctx.mode === "json" || ctx.mode === "print") throw new Error(`ask_me requires interactive input; UI is unavailable in ${ctx.mode} mode. Configure Telegram and opt in with --afk.`);
					let transfer = false;
					const result = await local(ctx, request, combined, draft, () => {
						try { this.setAfk(true, ctx); transfer = true; return true; }
						catch (error) { if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : "Telegram configuration is unavailable", "error"); return false; }
					});
					draft = result;
					if (!transfer || combined.aborted) return result;
				}
			}
			return draftDetails(request, draft);
		} catch (error) {
			failed = true;
			if (!this.lifetime.signal.aborted) this.setStatus(ctx, {
				kind: "error", route, message: error instanceof Error ? error.message : "No fallback was made.",
				...(route === "telegram" && lastProgress ? { requestId: lastProgress.id } : {}),
			});
			throw error;
		} finally {
			this.remote = undefined;
			this.running = false;
			if (!failed && !this.lifetime.signal.aborted) this.setStatus(ctx, { kind: this.afk ? "afk" : "local" });
		}
	}
}
