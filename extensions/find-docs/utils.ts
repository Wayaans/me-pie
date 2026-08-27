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
	readonly status: "found" | "library-not-found" | "docs-not-found";
	readonly library?: string;
	readonly libraryId?: string;
	readonly query: string;
	readonly truncated?: boolean;
	readonly fullOutputPath?: string;
};

export function formatFindDocsSummary(details: FindDocsDetails | undefined): string {
	if (!details) return "";
	if (details.status === "library-not-found") {
		return summarizeText(`${details.library ?? "library"} • no Context7 match`, 88);
	}

	const library = details.libraryId?.trim() || details.library?.trim() || "docs";
	if (details.status === "docs-not-found") {
		return summarizeText(`${library} • no matching docs`, 88);
	}
	const query = details.query.trim() ? summarizeText(details.query, 56) : undefined;
	return [library, query].filter(Boolean).join(" • ");
}

export function isCtx7Bash(command: string): boolean {
	return /^(?:command\s+)?(?:ctx7|bunx\s+(?:--bun\s+)?ctx7(?:@latest)?|npx\s+(?:--yes\s+)?ctx7(?:@latest)?)\b/.test(command.trim());
}
