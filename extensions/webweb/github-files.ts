import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { GitHubError } from "./errors.ts";

export const MAX_FILE_BYTES = 50 * 1024;
const MAX_DIRECTORY_ENTRIES = 2000;

function isInside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** Clones are private temporary directories. Never follow repository-controlled symlinks. */
export async function repositoryPath(root: string, relative: string): Promise<string> {
	const base = await realpath(root);
	const target = path.resolve(base, relative);
	if (!isInside(base, target)) throw new GitHubError({ message: "Repository path escapes the clone" });
	let current = base;
	for (const component of path.relative(base, target).split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		if ((await lstat(current)).isSymbolicLink()) {
			throw new GitHubError({ message: "Repository symlinks cannot be read or traversed" });
		}
	}
	const resolved = await realpath(target);
	if (!isInside(base, resolved)) throw new GitHubError({ message: "Repository path escapes the clone" });
	return resolved;
}

export async function readRepositoryFile(root: string, relative: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const target = await repositoryPath(root, relative);
	// O_NONBLOCK also prevents a malicious/special-file fixture from hanging open().
	const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new GitHubError({ message: "Repository target is not a regular file" });
		const buffer = Buffer.alloc(Math.min(info.size, MAX_FILE_BYTES));
		let used = 0;
		while (used < buffer.length) {
			signal?.throwIfAborted();
			const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
			if (bytesRead === 0) break;
			used += bytesRead;
		}
		signal?.throwIfAborted();
		return buffer.subarray(0, used).toString("utf8") + (info.size > MAX_FILE_BYTES ? "\n\n[File truncated at 50KB]" : "");
	} finally {
		await handle.close();
	}
}

export async function repositoryEntries(root: string, relative = "", signal?: AbortSignal) {
	signal?.throwIfAborted();
	const target = await repositoryPath(root, relative);
	const directory = await opendir(target);
	const entries: Array<{ name: string; directory: boolean }> = [];
	let truncated = false;
	for await (const entry of directory) {
		signal?.throwIfAborted();
		if (entry.name === ".git") continue;
		if (entries.length === MAX_DIRECTORY_ENTRIES) { truncated = true; break; }
		entries.push({ name: entry.name, directory: entry.isDirectory() });
	}
	return { entries, truncated };
}

export async function repositoryListing(root: string, relative = "", signal?: AbortSignal): Promise<string> {
	const { entries, truncated } = await repositoryEntries(root, relative, signal);
	const lines = entries.map((entry) => `- ${entry.name}${entry.directory ? "/" : ""}`).sort();
	if (truncated) lines.push(`[Listing truncated at ${MAX_DIRECTORY_ENTRIES} entries]`);
	return lines.join("\n") || "Directory is empty.";
}
