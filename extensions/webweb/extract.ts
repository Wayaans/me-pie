import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { Effect } from "effect";
import { SCRAPE_TIMEOUT_MS } from "./config.ts";
import { HttpError, SsrfBlockedError } from "./errors.ts";
import type { PageContent } from "./firecrawl.ts";
import { guardedFetch } from "./ssrf.ts";

const MAX_BYTES = 5 * 1024 * 1024;

const turndown = new TurndownService({
	codeBlockStyle: "fenced",
});

export interface ExtractDeps {
	readonly signal?: AbortSignal | undefined;
}

function htmlToMarkdown(html: string, url: string): PageContent | null {
	const { document } = parseHTML(html);
	const title = document.querySelector("title")?.textContent?.trim()
		?? document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim()
		?? url;
	document.querySelectorAll("script, style, noscript, iframe, svg").forEach((node) => node.remove());
	const reader = new Readability(document.cloneNode(true) as Document);
	const article = reader.parse();
	const htmlContent = article?.content ?? document.body?.innerHTML ?? "";
	if (!htmlContent.trim()) return null;
	const markdown = turndown.turndown(htmlContent).trim();
	if (!markdown) return null;
	return { url, title: article?.title?.trim() || title, content: markdown };
}

/** Keyless fetch + readability extraction. The fallback when Firecrawl is unavailable. */
export function httpExtract(url: string, deps: ExtractDeps = {}): Effect.Effect<PageContent, HttpError | SsrfBlockedError> {
	return Effect.tryPromise({
		try: async (signal) => {
			const signals = [AbortSignal.timeout(SCRAPE_TIMEOUT_MS), signal];
			if (deps.signal) signals.push(deps.signal);
			const response = await guardedFetch(url, {
				signal: AbortSignal.any(signals),
				headers: {
					"User-Agent": "Mozilla/5.0 (compatible; webweb/0.1; pi extension)",
					Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
				},
			});
			if (!response.ok) {
				throw new HttpError({ message: `HTTP ${response.status} for ${url}`, status: response.status });
			}
			const contentType = response.headers.get("content-type") ?? "";
			if (!/text\/html|application\/xhtml|text\/plain/.test(contentType)) {
				throw new HttpError({
					message: `Unsupported content-type "${contentType.split(";")[0]}" for ${url}`,
					status: response.status,
				});
			}
			const buffer = await response.arrayBuffer();
			if (buffer.byteLength > MAX_BYTES) {
				throw new HttpError({ message: `Response too large for ${url} (> ${MAX_BYTES} bytes)`, status: response.status });
			}
			const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
			if (/text\/plain/.test(contentType)) {
				return { url, title: url, content: text.trim() };
			}
			const extracted = htmlToMarkdown(text, response.url || url);
			if (!extracted) {
				throw new HttpError({ message: `No readable content extracted from ${url}`, status: response.status });
			}
			return extracted;
		},
		catch: (error) => {
			if (error instanceof HttpError || error instanceof SsrfBlockedError) return error;
			return new HttpError({ message: `Fetch failed for ${url}: ${String(error)}` });
		},
	}).pipe(
		Effect.timeout(SCRAPE_TIMEOUT_MS),
		Effect.catchTag("TimeoutError", () =>
			Effect.fail(new HttpError({ message: `Fetch timed out for ${url}` }))),
	);
}
