import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_DASHBOARD_URL = "https://chatgpt.com/codex/settings/usage";
const OPEN_DASHBOARD_LABEL = "Open usage dashboard";
const CONFIG_PATH = join(getAgentDir(), "codex-usage.json");
const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const WARN_THRESHOLD = 75;
const ERROR_THRESHOLD = 90;
const DEBOUNCE_MS = 60_000;

export const CODEX_USAGE_STATUS_KEY = "codex-usage";

type UsageWindow = {
	usedPercent?: number | undefined;
	windowSeconds?: number | undefined;
	resetAt?: number | undefined;
};

type JwtMetadata = {
	accountId?: string | undefined;
	planType?: string | undefined;
	email?: string | undefined;
};

export type CodexUsageSnapshot = {
	planType?: string | undefined;
	email?: string | undefined;
	fiveHour?: UsageWindow | undefined;
	weekly?: UsageWindow | undefined;
	fetchedAt: number;
};

export type BadgeTone = "text" | "muted" | "dim" | "accent" | "warning" | "error";

export interface CodexBadge {
	body: string;
	tone: BadgeTone;
}

export type CodexUsagePreferences = {
	showFiveHour: boolean;
	showWeekly: boolean;
};

export const DEFAULT_CODEX_USAGE_PREFERENCES: CodexUsagePreferences = {
	showFiveHour: true,
	showWeekly: false,
};

export function loadCodexUsagePreferences(): CodexUsagePreferences {
	try {
		const value = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<CodexUsagePreferences>;
		const showFiveHour = typeof value.showFiveHour === "boolean" ? value.showFiveHour : true;
		const showWeekly = typeof value.showWeekly === "boolean" ? value.showWeekly : false;
		return showFiveHour || showWeekly ? { showFiveHour, showWeekly } : DEFAULT_CODEX_USAGE_PREFERENCES;
	} catch {
		return DEFAULT_CODEX_USAGE_PREFERENCES;
	}
}

function saveCodexUsagePreferences(preferences: CodexUsagePreferences): void {
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(preferences, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function isOpenAICodexProvider(provider: string | undefined): boolean {
	return /^openai-codex(-\d+)?$/.test(provider ?? "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nestedRecord(record: Record<string, unknown> | undefined, key: string) {
	const val = record?.[key];
	return asRecord(val);
}

function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length < 2) return {};
	try {
		return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function getTokenMetadata(token: string): JwtMetadata {
	const payload = decodeJwtPayload(token);
	const auth = nestedRecord(payload, "https://api.openai.com/auth");
	const profile = nestedRecord(payload, "https://api.openai.com/profile");

	return {
		accountId:
			(typeof payload["https://api.openai.com/auth.chatgpt_account_id"] === "string"
				? payload["https://api.openai.com/auth.chatgpt_account_id"]
				: undefined) ??
			(typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined),
		planType: typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined,
		email: typeof profile?.email === "string" ? profile.email : undefined,
	};
}

function normalizeWindow(value: unknown): UsageWindow | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	return {
		usedPercent: typeof record.used_percent === "number" ? record.used_percent : undefined,
		windowSeconds: typeof record.limit_window_seconds === "number" ? record.limit_window_seconds : undefined,
		resetAt: typeof record.reset_at === "number" ? record.reset_at : undefined,
	};
}

function parseUsageSnapshot(data: unknown): CodexUsageSnapshot {
	const raw = asRecord(data);
	const rateLimit = nestedRecord(raw, "rate_limit");
	const windows = [
		normalizeWindow(rateLimit?.primary_window),
		normalizeWindow(rateLimit?.secondary_window),
	].filter((w): w is UsageWindow => Boolean(w));

	return {
		planType: typeof raw?.plan_type === "string" ? raw.plan_type : undefined,
		email: typeof raw?.email === "string" ? raw.email : undefined,
		fiveHour: windows.find((w) => Math.abs((w.windowSeconds ?? 0) - FIVE_HOUR_SECONDS) <= 120),
		weekly: windows.find((w) => Math.abs((w.windowSeconds ?? 0) - WEEK_SECONDS) <= 120),
		fetchedAt: Date.now(),
	};
}

function clampPercent(value: number | undefined): number {
	return value === undefined ? 0 : Math.max(0, Math.min(100, value));
}

function usageTone(percent: number): BadgeTone {
	if (percent >= ERROR_THRESHOLD) return "error";
	if (percent >= WARN_THRESHOLD) return "warning";
	return "muted";
}

function maskEmail(email: string): string {
	const [local, rawDomain] = email.split("@");
	if (!local || !rawDomain) return "***";
	const maskedLocal = local.length <= 2 ? `${local[0]}***` : `${local.slice(0, 2)}***`;
	const [domainName, ...domainRest] = rawDomain.split(".");
	const maskedDomain = domainName
		? `${domainName[0]}***${domainName.length > 1 ? domainName.slice(-1) : ""}`
		: "***";
	return `${maskedLocal}@${maskedDomain}${domainRest.length > 0 ? `.${domainRest.join(".")}` : ""}`;
}

function formatReset(resetAt: number | undefined): string {
	if (!resetAt) return "unknown";
	const minutes = Math.max(0, Math.round((resetAt * 1000 - Date.now()) / 60000));
	const days = Math.floor(minutes / (60 * 24));
	const hours = Math.floor((minutes % (60 * 24)) / 60);
	const mins = minutes % 60;
	if (days > 0) return `in ${days}d ${hours}h`;
	if (hours > 0) return `in ${hours}h ${mins}m`;
	return `in ${mins}m`;
}

function formatFetchedAt(fetchedAt: number): string {
	return new Date(fetchedAt).toLocaleString();
}

function progressLine(label: string, window: UsageWindow | undefined): string {
	const used = clampPercent(window?.usedPercent);
	const remaining = 100 - used;
	const barWidth = 20;
	const filled = Math.round((used / 100) * barWidth);
	const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
	return `${label}  [${bar}] ${used}% used, ${remaining}% left, resets ${formatReset(window?.resetAt)}`;
}

export function canShowCodexUsage(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	return Boolean(model && isOpenAICodexProvider(model.provider) && ctx.modelRegistry.isUsingOAuth(model));
}

async function fetchUsage(ctx: ExtensionContext): Promise<CodexUsageSnapshot | undefined> {
	const model = ctx.model;
	if (!canShowCodexUsage(ctx) || !model) {
		return undefined;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return undefined;

	const metadata = getTokenMetadata(auth.apiKey);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${auth.apiKey}`,
		Accept: "application/json",
		"User-Agent": "mepie/codex-usage",
	};
	if (metadata.accountId) headers["chatgpt-account-id"] = metadata.accountId;

	const timeoutSignal = AbortSignal.timeout(15_000);
	const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
	const response = await fetch(USAGE_ENDPOINT, { headers, signal });
	if (!response.ok) return undefined;

	const snapshot = parseUsageSnapshot(await response.json());
	return {
		...snapshot,
		email: snapshot.email ?? metadata.email,
		planType: snapshot.planType ?? metadata.planType,
	};
}

type RenderStateRef = {
	requestRender?: () => void;
};

export class CodexUsageManager {
	private current: CodexUsageSnapshot | undefined;
	private lastFetchMs = 0;
	private inFlight: Promise<CodexUsageSnapshot | undefined> | undefined;
	private renderRef: RenderStateRef;
	private preferences: CodexUsagePreferences;

	constructor(renderRef: RenderStateRef, preferences = DEFAULT_CODEX_USAGE_PREFERENCES) {
		this.renderRef = renderRef;
		this.preferences = { ...preferences };
	}

	get footerPreferences(): CodexUsagePreferences {
		return { ...this.preferences };
	}

	setFooterPreference(key: keyof CodexUsagePreferences, enabled: boolean): boolean {
		const next = { ...this.preferences, [key]: enabled };
		if (!next.showFiveHour && !next.showWeekly) return false;
		this.preferences = next;
		saveCodexUsagePreferences(next);
		this.renderRef.requestRender?.();
		return true;
	}

	get snapshot(): CodexUsageSnapshot | undefined {
		return this.current;
	}

	get hasData(): boolean {
		return this.current !== undefined;
	}

	async refresh(ctx: ExtensionContext): Promise<CodexUsageSnapshot | undefined> {
		if (!canShowCodexUsage(ctx)) {
			this.clear();
			this.renderRef.requestRender?.();
			return undefined;
		}

		const now = Date.now();
		if (now - this.lastFetchMs < DEBOUNCE_MS && this.inFlight) return this.inFlight;
		if (now - this.lastFetchMs < DEBOUNCE_MS && this.current) return this.current;

		this.inFlight = this.doRefresh(ctx);
		const result = await this.inFlight;
		this.inFlight = undefined;
		return result;
	}

	private async doRefresh(ctx: ExtensionContext): Promise<CodexUsageSnapshot | undefined> {
		try {
			const snapshot = await Effect.runPromise(
				Effect.tryPromise({
					try: () => fetchUsage(ctx),
					catch: (error) => error instanceof Error ? error : new Error(String(error)),
				}),
				{ signal: ctx.signal },
			);
			if (snapshot) {
				this.current = snapshot;
				this.lastFetchMs = Date.now();
			}
			this.renderRef.requestRender?.();
			return this.current;
		} catch {
			this.renderRef.requestRender?.();
			return this.current;
		}
	}

	clear(): void {
		this.current = undefined;
		this.lastFetchMs = 0;
	}
}

export function createCodexBadge(
	snapshot: CodexUsageSnapshot | undefined,
	preferences = DEFAULT_CODEX_USAGE_PREFERENCES,
): CodexBadge | undefined {
	if (!snapshot) return undefined;
	const windows: Array<{ label: string; used: number }> = [];
	if (preferences.showFiveHour && snapshot.fiveHour?.usedPercent !== undefined) {
		windows.push({ label: "5h", used: clampPercent(snapshot.fiveHour.usedPercent) });
	}
	if (preferences.showWeekly && snapshot.weekly?.usedPercent !== undefined) {
		windows.push({ label: "7d", used: clampPercent(snapshot.weekly.usedPercent) });
	}
	if (windows.length === 0) return undefined;
	return {
		body: `◷ ${windows.map((window) => `${window.label} ${window.used}%`).join(" · ")}`,
		tone: usageTone(Math.max(...windows.map((window) => window.used))),
	};
}

export function formatCodexStatusText(
	snapshot: CodexUsageSnapshot | undefined,
	preferences = DEFAULT_CODEX_USAGE_PREFERENCES,
): string | undefined {
	return createCodexBadge(snapshot, preferences)?.body;
}

export function registerCodexLimitCommand(pi: ExtensionAPI, manager: CodexUsageManager): void {
	pi.registerCommand("codex-limit", {
		description: "Show Codex 5-hour and weekly usage limits",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (!isOpenAICodexProvider(ctx.model?.provider)) {
				ctx.ui.notify("Codex limits are only available for openai-codex models.", "info");
				return;
			}

			const snapshot = await manager.refresh(ctx);
			if (!snapshot) {
				ctx.ui.notify("Could not load Codex usage limits.", "warning");
				return;
			}

			const selected = await showCodexDetail(ctx, snapshot, manager);
			if (selected === OPEN_DASHBOARD_LABEL) {
				openDashboard(ctx);
			}
		},
	});
}

async function showCodexDetail(
	ctx: ExtensionContext,
	snapshot: CodexUsageSnapshot,
	manager: CodexUsageManager,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme: Theme, _keybindings, done) => {
		let selectedIndex = 0;
		let cachedLines: string[] | undefined;

		const buildLines = () => buildDetailLines(snapshot, theme, manager.footerPreferences);
		let lines = buildLines();
		const selectable = () => [
			lines.indexOf(OPEN_DASHBOARD_LABEL),
			lines.findIndex((line) => line.startsWith("5-hour usage")),
			lines.findIndex((line) => line.startsWith("7-day usage")),
		].filter((index) => index >= 0);
		selectedIndex = selectable()[0] ?? 0;

		const refresh = () => {
			cachedLines = undefined;
			tui.requestRender();
		};

		const handleInput = (data: string) => {
			const selectableIndices = selectable();
			const position = selectableIndices.indexOf(selectedIndex);
			if (matchesKey(data, Key.up) || data === "k") {
				selectedIndex = selectableIndices[Math.max(0, position - 1)] ?? selectedIndex;
				refresh();
				return;
			}
			if (matchesKey(data, Key.down) || data === "j") {
				selectedIndex = selectableIndices[Math.min(selectableIndices.length - 1, position + 1)] ?? selectedIndex;
				refresh();
				return;
			}
			const actionIndex = lines.indexOf(OPEN_DASHBOARD_LABEL);
			if (matchesKey(data, Key.enter) && selectedIndex === actionIndex) {
				done(OPEN_DASHBOARD_LABEL);
				return;
			}
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
				const preferences = manager.footerPreferences;
				const key = lines[selectedIndex]?.startsWith("5-hour usage") ? "showFiveHour" : "showWeekly";
				if (!manager.setFooterPreference(key, !preferences[key])) {
					ctx.ui.notify("At least one usage window must remain enabled.", "info");
				}
				lines = buildLines();
				refresh();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
				done(undefined);
			}
		};

		const render = (width: number): string[] => {
			if (cachedLines) return cachedLines;

			const out: string[] = [];
			const add = (line: string) => out.push(truncateToWidth(line, width));

			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("accent", theme.bold(" Codex Usage Limits")));
			add(theme.fg("dim", `  fetched: ${formatFetchedAt(snapshot.fetchedAt)}`));
			out.push("");

			for (let i = 0; i < lines.length; i++) {
				const selected = i === selectedIndex;
				const actionable = selectable().includes(i);
				const prefix = selected ? theme.fg("accent", "→ ") : "  ";
				const color = selected ? "accent" : actionable ? "text" : "muted";
				add(prefix + theme.fg(color, lines[i]!));
			}

			out.push("");
			add(
				theme.fg(
					"dim",
					selectedIndex === lines.indexOf(OPEN_DASHBOARD_LABEL)
						? "↑↓ navigate • Enter to open dashboard • Esc/Ctrl+C close"
						: "↑↓ navigate • Enter/Space toggle • Esc/Ctrl+C close",
				),
			);
			add(theme.fg("accent", "─".repeat(width)));

			cachedLines = out;
			return out;
		};

		return { invalidate() { cachedLines = undefined; }, handleInput, render };
	});
}

function accentForTone(tone: BadgeTone): Parameters<Theme["fg"]>[0] {
	switch (tone) {
		case "error":
			return "error" as Parameters<Theme["fg"]>[0];
		case "warning":
			return "warning" as Parameters<Theme["fg"]>[0];
		default:
			return "accent" as Parameters<Theme["fg"]>[0];
	}
}

function buildDetailLines(
	snapshot: CodexUsageSnapshot,
	theme: Theme,
	preferences: CodexUsagePreferences,
): string[] {
	const used5h = clampPercent(snapshot.fiveHour?.usedPercent);
	const tone5h = usageTone(used5h);
	const usedWeekly = clampPercent(snapshot.weekly?.usedPercent);
	const toneWeekly = usageTone(usedWeekly);

	const detailLines: string[] = [];

	if (snapshot.planType) detailLines.push(`plan: ${snapshot.planType}`);
	if (snapshot.email) detailLines.push(`email: ${maskEmail(snapshot.email)}`);
	detailLines.push("");

	const fiveHourLabel = theme.fg(accentForTone(tone5h), `5-hour (${used5h}%)`);
	detailLines.push(progressLine(fiveHourLabel, snapshot.fiveHour));
	detailLines.push("");

	const weeklyLabel = theme.fg(accentForTone(toneWeekly), `weekly (${usedWeekly}%)`);
	detailLines.push(progressLine(weeklyLabel, snapshot.weekly));
	detailLines.push("");

	detailLines.push(OPEN_DASHBOARD_LABEL);
	detailLines.push("");
	detailLines.push("Footer display");
	detailLines.push(`5-hour usage  ${preferences.showFiveHour ? "on" : "off"}`);
	detailLines.push(`7-day usage   ${preferences.showWeekly ? "on" : "off"}`);

	return detailLines;
}

function getOpenCommand(url: string): { command: string; args: string[] } {
	if (process.platform === "darwin") return { command: "open", args: [url] };
	if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
	return { command: "xdg-open", args: [url] };
}

async function openDashboard(ctx: ExtensionContext): Promise<void> {
	const { command, args } = getOpenCommand(USAGE_DASHBOARD_URL);
	execFile(command, args, (err: Error | null) => {
		if (err) {
			ctx.ui.notify(`Could not open browser. Visit: ${USAGE_DASHBOARD_URL}`, "warning");
		} else {
			ctx.ui.notify("Opened Codex usage dashboard in your browser.", "info");
		}
	});
}

export function refreshCodexUsage(pi: ExtensionAPI, manager: CodexUsageManager): void {
	pi.on("agent_end", (_event, ctx) => {
		void manager.refresh(ctx);
	});

	pi.on("session_shutdown", () => {
		manager.clear();
	});
}
