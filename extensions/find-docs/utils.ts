export function summarizeText(text: string, maxLength = 140): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLength) return singleLine;
	return `${singleLine.slice(0, maxLength - 3)}...`;
}

export function formatFindDocsTarget(args: { library?: unknown; libraryId?: unknown; query?: unknown }): string {
	const library =
		typeof args.libraryId === "string" && args.libraryId.trim()
			? args.libraryId.trim()
			: typeof args.library === "string" && args.library.trim()
				? args.library.trim()
				: "library?";
	const query = typeof args.query === "string" ? summarizeText(args.query, 56) : "query?";
	return summarizeText(`${library} • ${query}`, 88);
}

export type FindDocsDetails = {
	library?: string;
	libraryId?: string;
	query?: string;
	resolved?: boolean;
	fullOutputPath?: string;
};

export function formatFindDocsSummary(details: FindDocsDetails | undefined): string {
	if (!details) return "";
	if (details.resolved === false) {
		const library = details.library?.trim() || "library lookup";
		return summarizeText(`${library} • no Context7 match`, 88);
	}

	const library = details.libraryId?.trim() || details.library?.trim() || "docs";
	const query = details.query?.trim() ? summarizeText(details.query, 56) : undefined;
	return [library, query].filter(Boolean).join(" • ");
}

export function extractContext7LibraryId(output: string): string | undefined {
	const match = output.match(/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?/);
	return match?.[0];
}

export function isCtx7Bash(command: string): boolean {
	return /^(ctx7|bunx\s+ctx7|bunx\s+ctx7@latest|npx\s+ctx7|npx\s+ctx7@latest)\b/.test(command.trim());
}
