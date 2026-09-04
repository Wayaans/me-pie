import { readdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { cacheDirPath, ensureCacheDir } from "./config.ts";
import { CacheError } from "./errors.ts";

const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 128;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

export interface CachedSource {
	readonly url: string;
	readonly title: string;
	readonly content: string;
}

export interface CacheEntry {
	readonly id: string;
	readonly createdAt: number;
	readonly kind: "search" | "fetch" | "verify";
	readonly sources: ReadonlyArray<CachedSource>;
}

function entryPath(id: string, dir: string): string {
	if (!/^[0-9a-f]{8}$/.test(id)) {
		throw new CacheError({ message: `Invalid responseId "${id}": expected 8 hex characters` });
	}
	return path.join(dir, `${id}.json`);
}

export function newResponseId(): string {
	return randomBytes(4).toString("hex");
}

function serialize(entry: CacheEntry): string {
	return JSON.stringify({
		id: entry.id,
		createdAt: entry.createdAt,
		kind: entry.kind,
		sources: entry.sources,
	});
}

function deserialize(raw: string, fileName: string): CacheEntry | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const record = parsed as Record<string, unknown>;
		const id = typeof record.id === "string" ? record.id : fileName.replace(/\.json$/, "");
		const createdAt = typeof record.createdAt === "number" ? record.createdAt : 0;
		const kind = record.kind === "fetch" || record.kind === "verify" ? record.kind : "search";
		const sources = Array.isArray(record.sources) ? record.sources : [];
		return {
			id,
			createdAt,
			kind,
			sources: sources.flatMap((source) => {
				if (!source || typeof source !== "object") return [];
				const item = source as Record<string, unknown>;
				if (typeof item.url !== "string" || typeof item.content !== "string") return [];
				return [{
					url: item.url,
					title: typeof item.title === "string" ? item.title : item.url,
					content: item.content,
				}];
			}),
		};
	} catch {
		return null;
	}
}

async function prune(dir: string): Promise<void> {
	const names = await readdir(dir).catch(() => [] as Array<string>);
	const items: Array<{ name: string; mtime: number; size: number }> = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const info = await stat(path.join(dir, name)).catch(() => null);
		if (!info) continue;
		items.push({ name, mtime: info.mtimeMs, size: info.size });
	}
	const now = Date.now();
	const isExpired = (item: { mtime: number }) => now - item.mtime > TTL_MS;
	for (const item of items.filter(isExpired)) {
		await rm(path.join(dir, item.name), { force: true }).catch(() => undefined);
	}
	const keep = items.filter((item) => !isExpired(item)).sort((a, b) => a.mtime - b.mtime);
	let excessCount = keep.length - MAX_ENTRIES;
	let totalBytes = keep.reduce((sum, item) => sum + item.size, 0);
	for (const item of keep) {
		if (excessCount <= 0 && totalBytes <= MAX_TOTAL_BYTES) break;
		await rm(path.join(dir, item.name), { force: true }).catch(() => undefined);
		excessCount -= 1;
		totalBytes -= item.size;
	}
}

export function cacheStore(options: { dir?: string } = {}) {
	const dir = options.dir ?? cacheDirPath();

	const write = (entry: CacheEntry): Effect.Effect<void, CacheError> =>
		Effect.tryPromise({
			try: async () => {
				ensureCacheDir(dir);
				await writeFile(entryPath(entry.id, dir), serialize(entry), { mode: 0o600 });
				await prune(dir);
			},
			catch: (error) => new CacheError({ message: `Cache write failed: ${String(error)}` }),
		});

	const read = (id: string): Effect.Effect<CacheEntry | null, CacheError> =>
		Effect.tryPromise({
			try: async () => {
				const filePath = entryPath(id, dir);
				const info = await stat(filePath).catch(() => null);
				if (!info) return null;
				if (info.mtimeMs < Date.now() - TTL_MS) {
					await rm(filePath, { force: true }).catch(() => undefined);
					return null;
				}
				const raw = await readFile(filePath, "utf8");
				return deserialize(raw, path.basename(filePath));
			},
			catch: (error) => new CacheError({ message: `Cache read failed: ${String(error)}` }),
		});

	return { write, read };
}

export function storeSources(
	kind: CacheEntry["kind"],
	sources: ReadonlyArray<CachedSource>,
	store: ReturnType<typeof cacheStore>,
): Effect.Effect<string, CacheError> {
	return Effect.gen(function*() {
		const id = newResponseId();
		yield* store.write({ id, createdAt: Date.now(), kind, sources });
		return id;
	});
}

export interface PassageMatch {
	readonly url: string;
	readonly excerpt: string;
}

/** Find excerpts containing every requested text, with `context` characters around each match. */
export function findPassages(
	entry: CacheEntry,
	findText: ReadonlyArray<string>,
	findMode: "exact" | "case-insensitive" | "fuzzy",
	context = 200,
	maxChars = 20_000,
): Array<PassageMatch> {
	const matches: Array<PassageMatch> = [];
	let used = 0;
	for (const source of entry.sources) {
		for (const needle of findText) {
			const haystack = findMode === "exact" ? source.content : source.content.toLowerCase();
			const term = findMode === "exact" ? needle : needle.toLowerCase();
			let index = haystack.indexOf(term);
			while (index !== -1 && used < maxChars) {
				const start = Math.max(0, index - context);
				const end = Math.min(source.content.length, index + term.length + context);
				const excerpt = `${start > 0 ? "..." : ""}${source.content.slice(start, end)}${end < source.content.length ? "..." : ""}`;
				matches.push({ url: source.url, excerpt });
				used += excerpt.length;
				index = haystack.indexOf(term, index + term.length);
			}
		}
	}
	return matches;
}

export function sliceContent(content: string, offset: number, limit: number): string {
	return content.slice(offset, offset + limit);
}
