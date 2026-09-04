import { lookup } from "node:dns/promises";
import { SsrfBlockedError } from "./errors.ts";

const MAX_REDIRECTS = 5;
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

export type LookupFunction = typeof lookup;

function isReservedIpv4(ip: string): boolean {
	const parts = ip.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return true;
	const [a, b] = parts as [number, number, number, number];
	if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
	if (a === 169 && b === 254) return true; // link-local
	if (a === 172 && b >= 16 && b <= 31) return true; // private
	if (a === 192 && b === 168) return true; // private
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	if (a === 192 && b === 0) return true; // protocol assignments
	if (a === 192 && b === 0 && (parts[2] ?? 0) === 2) return true; // TEST-NET-1 (192.0.2.0/24)
	if (a === 198 && b === 51 && (parts[2] ?? 0) === 100) return true; // TEST-NET-2
	if (a === 203 && b === 0 && (parts[2] ?? 0) === 113) return true; // TEST-NET-3
	if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
	if (a >= 224) return true; // multicast + reserved
	return false;
}

function isReservedIpv6(ip: string): boolean {
	const lower = (ip.toLowerCase().split("%")[0] ?? ip);
	if (lower === "::" || lower === "::1") return true;
	if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // link-local
	if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
	if (lower.startsWith("::ffff:")) {
		const mapped = lower.slice("::ffff:".length);
		if (mapped.includes(".")) return isReservedIpv4(mapped);
	}
	return false;
}

function isReservedIp(ip: string): boolean {
	return ip.includes(":") ? isReservedIpv6(ip) : isReservedIpv4(ip);
}

export async function validateRemoteUrl(
	rawUrl: string,
	options: { lookup?: LookupFunction | undefined } = {},
): Promise<URL> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new SsrfBlockedError({ message: `Invalid URL: ${rawUrl}` });
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new SsrfBlockedError({ message: `Blocked URL scheme "${parsed.protocol}": only http and https are allowed` });
	}
	if (parsed.username || parsed.password) {
		throw new SsrfBlockedError({ message: "Blocked URL with embedded credentials" });
	}
	if (!ALLOWED_PORTS.has(parsed.port)) {
		throw new SsrfBlockedError({ message: `Blocked URL port ${parsed.port}` });
	}
	const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
	let addresses;
	try {
		addresses = await (options.lookup ?? lookup)(hostname, { all: true, verbatim: true });
	} catch (error) {
		throw new SsrfBlockedError({
			message: `DNS resolution failed for ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
	if (addresses.length === 0) {
		throw new SsrfBlockedError({ message: `No DNS addresses for ${hostname}` });
	}
	for (const { address } of addresses) {
		if (isReservedIp(address)) {
			throw new SsrfBlockedError({ message: `Blocked request to private or reserved address (${address})` });
		}
	}
	return parsed;
}

export interface GuardedFetchResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly headers: Headers;
	readonly url: string;
	readonly arrayBuffer: () => Promise<ArrayBuffer>;
	readonly text: () => Promise<string>;
}

export interface GuardedFetchInit {
	method?: string | undefined;
	headers?: Record<string, string> | undefined;
	signal?: AbortSignal | undefined;
	lookup?: LookupFunction | undefined;
}

/**
 * Fetch that follows redirects manually and revalidates every hop against the
 * SSRF rules, so a redirect cannot bypass the private-address checks.
 */
export async function guardedFetch(
	rawUrl: string,
	init: GuardedFetchInit = {},
): Promise<GuardedFetchResponse> {
	let currentUrl = rawUrl;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
		const validated = await validateRemoteUrl(currentUrl, { lookup: init.lookup });
		const response = await fetch(validated, {
			method: init.method ?? "GET",
			redirect: "manual",
			...(init.headers ? { headers: init.headers } : {}),
			...(init.signal ? { signal: init.signal } : {}),
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) return response;
			response.body?.cancel();
			currentUrl = new URL(location, validated).toString();
			continue;
		}
		return response;
	}
	throw new SsrfBlockedError({ message: `Too many redirects (more than ${MAX_REDIRECTS})` });
}
