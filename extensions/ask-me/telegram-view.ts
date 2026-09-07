export interface TelegramText {
	text: string;
	bold?: boolean;
}

export function escapeTelegramHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Split source text, never markup or escaped entities. Each chunk is valid HTML.
 * Bound serialized UTF-16 length too, conservatively below Telegram's parsed limit.
 */
export function telegramHtmlChunks(parts: readonly TelegramText[], limit: number): string[] {
	if (limit < 16) throw new Error("Telegram HTML chunk limit must be at least 16");
	const chunks: string[] = [];
	let chunk = "";
	for (const part of parts) {
		const open = part.bold ? "<b>" : "";
		const close = part.bold ? "</b>" : "";
		let fragment = "";
		for (const character of part.text) {
			const escaped = escapeTelegramHtml(character);
			if (chunk.length + open.length + fragment.length + escaped.length + close.length > limit) {
				chunks.push(chunk + (fragment ? open + fragment + close : ""));
				chunk = "";
				fragment = "";
			}
			fragment += escaped;
		}
		if (fragment) chunk += open + fragment + close;
	}
	if (chunk) chunks.push(chunk);
	return chunks;
}

/** Labels are display-only. Full question/option text is retained in the body. */
export function compactTelegramLabel(text: string, limit = 48): string {
	const line = text.replace(/\s+/g, " ").trim();
	const characters = Array.from(line);
	return characters.length <= limit ? line : `${characters.slice(0, limit - 1).join("")}…`;
}

export function shortRequestId(id: string): string { return id.slice(0, 8); }
