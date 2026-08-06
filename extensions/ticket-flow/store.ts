import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { StoredReport, TicketflowRun, WorkerReport } from "./model.ts";
import { TICKETFLOW_VERSION, isTerminalPhase } from "./model.ts";
import { reportMatchesModel } from "./transport.ts";

export const DIRECTORY_MODE = 0o700;
export const FILE_MODE = 0o600;

export interface TicketflowPaths {
	readonly rootDir: string;
	readonly projectDir: string;
	readonly runDir: string;
	readonly runFile: string;
	readonly reportsDir: string;
	readonly tokenFile: string;
	readonly lockDir: string;
	readonly projectId: string;
	readonly projectPath: string;
}

export interface ProjectLock {
	readonly path: string;
	release(): Promise<void>;
}

interface LockOwner {
	readonly version: 1;
	readonly runId: string;
	readonly acquisitionId: string;
	readonly pid: number;
	readonly sessionId: string;
	readonly createdAt: string;
}

const SECRET_KEY = /(api.?key|authorization|credential|password|secret|token)/i;
const SECRET_TEXT = /(?:api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|authorization|password|token|credential|secret)\s*[:=]\s*\S+/i;

export function projectId(projectPath: string): string {
	return createHash("sha256").update(projectPath).digest("hex");
}

async function canonicalAgentDir(agentDir: string): Promise<string> {
	const resolved = path.resolve(agentDir);
	try { return await realpath(resolved); }
	catch {
		await mkdir(resolved, { recursive: true, mode: DIRECTORY_MODE });
		return realpath(resolved);
	}
}

export async function resolvePaths(projectInput: string, runId: string, agentDir = getAgentDir()): Promise<TicketflowPaths> {
	if (!runId.trim() || runId !== path.basename(runId) || /[\0\r\n]/.test(runId)) throw new Error("Run ID must be path-safe.");
	const projectPath = await realpath(projectInput);
	const agent = await canonicalAgentDir(agentDir);
	const rootDir = path.join(agent, "state", "ticketflow");
	const relative = path.relative(projectPath, rootDir);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) throw new Error("Ticket Flow state must not be inside the project.");
	const id = projectId(projectPath);
	const projectDir = path.join(rootDir, id);
	const runDir = path.join(projectDir, runId);
	return {
		rootDir,
		projectDir,
		runDir,
		runFile: path.join(runDir, "run.json"),
		reportsDir: path.join(runDir, "reports"),
		tokenFile: path.join(runDir, ".transport-token"),
		lockDir: path.join(rootDir, `${id}.lock`),
		projectId: id,
		projectPath,
	};
}

async function ensureDirectories(paths: TicketflowPaths): Promise<void> {
	for (const directory of [paths.rootDir, paths.projectDir, paths.runDir, paths.reportsDir]) {
		await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
		await chmod(directory, DIRECTORY_MODE);
	}
	for (const directory of [paths.runDir, paths.reportsDir]) {
		for (const name of await readdir(directory)) if (name.startsWith(".") && name.endsWith(".tmp")) await rm(path.join(directory, name), { force: true });
	}
}

function containsCredential(value: unknown, seen = new Set<object>()): boolean {
	if (typeof value === "string") return SECRET_TEXT.test(value);
	if (!value || typeof value !== "object" || seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some((item) => containsCredential(item, seen));
	return Object.entries(value).some(([key, item]) => SECRET_KEY.test(key) || containsCredential(item, seen));
}

function stable(value: unknown, ancestors = new Set<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Cannot persist non-finite numbers.");
		return value;
	}
	if (typeof value !== "object") throw new Error(`Cannot persist ${typeof value}.`);
	if (ancestors.has(value)) throw new Error("Cannot persist cyclic values.");
	const next = new Set(ancestors).add(value);
	if (Array.isArray(value)) return value.map((entry) => stable(entry, next));
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Only plain objects may be persisted.");
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item, next)]));
}

export function deterministicJson(value: unknown): string {
	return `${JSON.stringify(stable(value), null, 2)}\n`;
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try { await handle.sync(); } finally { await handle.close(); }
}

export async function atomicWriteJson(filePath: string, value: unknown, signal?: AbortSignal): Promise<void> {
	if (containsCredential(value)) throw new Error("Ticket Flow durable state must not contain credentials.");
	signal?.throwIfAborted();
	const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporary, "wx", FILE_MODE);
		await handle.writeFile(deterministicJson(value), "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		signal?.throwIfAborted();
		await rename(temporary, filePath);
		await chmod(filePath, FILE_MODE);
		await syncDirectory(path.dirname(filePath));
	} finally {
		await handle?.close().catch(() => undefined);
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

function validateRun(run: TicketflowRun, paths: TicketflowPaths): void {
	if (run.version !== TICKETFLOW_VERSION) throw new Error(`Unsupported Ticket Flow state version: ${String(run.version)}.`);
	if (run.id !== path.basename(paths.runDir) || run.projectId !== paths.projectId || run.projectPath !== paths.projectPath) throw new Error("Ticket Flow run identity does not match its storage path.");
	if (!Number.isSafeInteger(run.revision) || run.revision < 0 || !Number.isSafeInteger(run.currentTicket) || run.currentTicket < 0 || run.currentTicket > run.tickets.length) throw new Error("Ticket Flow run cursor is corrupt.");
	if (run.assignment === undefined && run.worker !== undefined) throw new Error("A durable worker cannot exist without an assignment.");
	if (run.assignment && run.worker && (run.worker.handle.runId !== run.id || run.worker.handle.assignmentId !== run.assignment.id)) throw new Error("Worker handle identity does not match the run assignment.");
	if (run.tickets.some((ticket, index) => ticket.index !== index || ticket.order !== index + 1)) throw new Error("Ticket order is not canonical.");
}

export async function saveRun(paths: TicketflowPaths, run: TicketflowRun, signal?: AbortSignal): Promise<void> {
	validateRun(run, paths);
	await ensureDirectories(paths);
	await atomicWriteJson(paths.runFile, run, signal);
}

export async function loadRun(paths: TicketflowPaths): Promise<TicketflowRun> {
	const metadata = await lstat(paths.runFile);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) throw new Error("Ticket Flow run.json is not an owner-only regular file.");
	const parsed = JSON.parse(await readFile(paths.runFile, "utf8")) as TicketflowRun;
	validateRun(parsed, paths);
	return parsed;
}

export async function writeReport(paths: TicketflowPaths, report: StoredReport): Promise<{ readonly path: string; readonly hash: string }> {
	await ensureDirectories(paths);
	if (containsCredential(report)) throw new Error("Ticket Flow reports must not contain credentials.");
	const content = deterministicJson(report);
	const hash = createHash("sha256").update(content).digest("hex");
	const safeId = `${report.assignmentId}-${report.turn}-${hash.slice(0, 16)}`.replace(/[^A-Za-z0-9_.-]/g, "-");
	const finalPath = path.join(paths.reportsDir, `${safeId}.json`);
	try {
		const metadata = await lstat(finalPath);
		if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) throw new Error("Existing report identity is not an owner-only regular file.");
		const existing = await readFile(finalPath, "utf8");
		if (existing !== content) throw new Error("Conflicting immutable report identity.");
		return { path: finalPath, hash };
	} catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
	const temporary = path.join(paths.reportsDir, `.${safeId}.${crypto.randomUUID()}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporary, "wx", FILE_MODE);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, finalPath);
		await chmod(finalPath, FILE_MODE);
		await syncDirectory(paths.reportsDir);
		if (await readFile(finalPath, "utf8") !== content) throw new Error("Conflicting immutable report identity.");
	} finally {
		await handle?.close().catch(() => undefined);
		await rm(temporary, { force: true }).catch(() => undefined);
	}
	return { path: finalPath, hash };
}

export async function readStoredReport(referencePath: string, expectedHash?: string, reportsDirectory?: string): Promise<StoredReport> {
	const resolved = path.resolve(referencePath);
	const canonicalResolved = await realpath(resolved);
	if (canonicalResolved !== resolved) throw new Error("Report reference or one of its parent components is a symlink.");
	if (reportsDirectory !== undefined) {
		const relative = path.relative(await realpath(reportsDirectory), canonicalResolved);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Report reference is outside the run reports directory.");
	}
	const metadata = await lstat(canonicalResolved);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) throw new Error("Report reference is not an owner-only immutable regular file.");
	const content = await readFile(canonicalResolved, "utf8");
	const actualHash = createHash("sha256").update(content).digest("hex");
	if (expectedHash !== undefined && actualHash !== expectedHash) throw new Error("Immutable report content hash does not match its durable reference.");
	const parsed = JSON.parse(content) as StoredReport;
	if (parsed.version !== TICKETFLOW_VERSION) throw new Error("Unsupported report version.");
	if (!parsed.runId || !parsed.assignmentId || !Number.isSafeInteger(parsed.turn) || parsed.turn < 1 || !parsed.worker?.sessionId || !parsed.worker.sessionFile || !reportMatchesModel(parsed.report)) throw new Error("Stored report schema or identity is invalid.");
	return parsed;
}

export async function findLatestReport(paths: TicketflowPaths, assignmentId: string, turn: number): Promise<{ readonly stored: StoredReport; readonly path: string; readonly hash: string } | undefined> {
	let names: string[];
	try { names = await readdir(paths.reportsDir); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw cause; }
	const candidates: Array<{ stored: StoredReport; path: string; hash: string }> = [];
	for (const name of names.filter((name) => name.endsWith(".json"))) {
		const reportPath = path.join(paths.reportsDir, name);
		const content = await readFile(reportPath, "utf8");
		const hash = createHash("sha256").update(content).digest("hex");
		const stored = await readStoredReport(reportPath, hash, paths.reportsDir);
		if (stored.runId === path.basename(paths.runDir) && stored.assignmentId === assignmentId && stored.turn === turn) candidates.push({ stored, path: reportPath, hash });
	}
	if (new Set(candidates.map((candidate) => candidate.hash)).size > 1) throw new Error("Conflicting immutable reports exist for one assignment turn.");
	return candidates.at(0);
}

export async function writeTransportToken(paths: TicketflowPaths, token: string): Promise<void> {
	await ensureDirectories(paths);
	if (!token || token !== token.trim() || /[\x00-\x1f\x7f]/.test(token)) throw new Error("Ticket Flow transport token is invalid.");
	const temporary = path.join(paths.runDir, `.transport-token.${crypto.randomUUID()}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporary, "wx", FILE_MODE);
		await handle.writeFile(token, "utf8"); await handle.sync(); await handle.close(); handle = undefined;
		await rename(temporary, paths.tokenFile); await chmod(paths.tokenFile, FILE_MODE); await syncDirectory(paths.runDir);
	} finally { await handle?.close().catch(() => undefined); await rm(temporary, { force: true }).catch(() => undefined); }
}

export async function readTransportToken(paths: TicketflowPaths): Promise<string> {
	const token = await readFile(paths.tokenFile, "utf8");
	if (!token || token !== token.trim() || /[\0\r\n]/.test(token)) throw new Error("Ticket Flow transport token is invalid.");
	return token;
}

export async function removeTransportToken(paths: TicketflowPaths): Promise<void> {
	await rm(paths.tokenFile, { force: true });
}

function pidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (cause) { return (cause as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export async function acquireProjectLock(paths: TicketflowPaths, runId: string, sessionId: string, expectedPreviousSessionId?: string): Promise<ProjectLock> {
	await mkdir(paths.rootDir, { recursive: true, mode: DIRECTORY_MODE });
	await chmod(paths.rootDir, DIRECTORY_MODE);
	let owner: LockOwner = { version: 1, runId, acquisitionId: crypto.randomUUID(), pid: process.pid, sessionId, createdAt: new Date().toISOString() };
	try { await mkdir(paths.lockDir, { mode: DIRECTORY_MODE }); }
	catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
		let existing: LockOwner | undefined;
		try { existing = JSON.parse(await readFile(path.join(paths.lockDir, "owner.json"), "utf8")) as LockOwner; } catch { throw new Error("Ticket Flow project lock has ambiguous ownership."); }
		if (existing.version !== 1 || !existing.runId || !existing.acquisitionId || !Number.isSafeInteger(existing.pid) || existing.pid < 1 || !existing.sessionId) throw new Error("Ticket Flow project lock owner metadata is invalid.");
		if ((expectedPreviousSessionId !== undefined && (existing.runId !== runId || existing.sessionId !== expectedPreviousSessionId)) || pidAlive(existing.pid)) throw new Error(`Ticket Flow project is locked by run ${existing.runId}.`);
		const ownerPath = path.join(paths.lockDir, "owner.json");
		const snapshot = await readFile(ownerPath, "utf8");
		const quarantine = `${paths.lockDir}.stale.${crypto.randomUUID()}`;
		await rename(paths.lockDir, quarantine);
		try {
			if (await readFile(path.join(quarantine, "owner.json"), "utf8") !== snapshot) throw new Error("Ticket Flow project lock changed during recovery.");
			await mkdir(paths.lockDir, { mode: DIRECTORY_MODE });
			await rm(quarantine, { recursive: true, force: true });
		} catch (cause) {
			await rename(quarantine, paths.lockDir).catch(() => undefined);
			throw cause;
		}
		owner = { ...owner, acquisitionId: crypto.randomUUID() };
	}
	await atomicWriteJson(path.join(paths.lockDir, "owner.json"), owner);
	let released = false;
	return {
		path: paths.lockDir,
		async release() {
			if (released) return;
			released = true;
			const quarantine = `${paths.lockDir}.release.${owner.acquisitionId}`;
			try {
				await rename(paths.lockDir, quarantine);
				const current = JSON.parse(await readFile(path.join(quarantine, "owner.json"), "utf8")) as LockOwner;
				if (current.acquisitionId !== owner.acquisitionId) {
					await rename(quarantine, paths.lockDir).catch(() => undefined);
					return;
				}
				await rm(quarantine, { recursive: true, force: true });
			} catch { /* never remove an unverified replacement lock */ }
		},
	};
}

export async function discoverRuns(projectInput: string, agentDir = getAgentDir()): Promise<readonly { readonly paths: TicketflowPaths; readonly run: TicketflowRun }[]> {
	const projectPath = await realpath(projectInput);
	const id = projectId(projectPath);
	const agent = await canonicalAgentDir(agentDir);
	const projectDir = path.join(agent, "state", "ticketflow", id);
	let entries: string[];
	try { entries = await readdir(projectDir); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return []; throw cause; }
	const found: Array<{ paths: TicketflowPaths; run: TicketflowRun }> = [];
	for (const runId of entries) {
		const paths = await resolvePaths(projectPath, runId, agent);
		try {
			const run = await loadRun(paths);
			if (!isTerminalPhase(run.phase)) found.push({ paths, run });
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot read Ticket Flow run ${runId}: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
	}
	return found.sort((left, right) => right.run.updatedAt.localeCompare(left.run.updatedAt));
}

export async function assertNoLegacyRun(projectInput: string, agentDir = getAgentDir()): Promise<void> {
	const projectPath = await realpath(projectInput);
	const agent = await canonicalAgentDir(agentDir);
	const legacyRoot = path.join(agent, "state", "ticket-flow");
	const id = projectId(projectPath);
	const legacyProject = path.join(legacyRoot, id);
	const entries = await readdir(legacyProject).catch((cause) => {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
		throw cause;
	});
	const lockExists = await stat(path.join(legacyRoot, `${id}.lock`)).then(() => true, (cause) => {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw cause;
	});
	if (entries.length > 0 || lockExists) throw new Error("An unfinished legacy Ticket Flow run exists. The breaking redesign cannot resume it; stop or remove the legacy run state before /ticketflow tmux.");
}

export function reportBody(reference: { readonly report: WorkerReport }): WorkerReport { return reference.report; }
