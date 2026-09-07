import { expect } from "bun:test";
import { createServer, request, type RequestListener } from "node:http";
import type { GitHubTransport } from "../webweb/github.ts";

/** Offline server behind the real guarded transport. Only the connector maps public DNS to loopback. */
export async function withHttpFixture<T>(handler: RequestListener, run: (transport: GitHubTransport, urls: Array<string>) => Promise<T>): Promise<T> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture address");
	const urls: Array<string> = [];
	try {
		return await run({
			lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			request: (url, options, callback) => {
				urls.push(url.href);
				expect(options.agent).toBe(false);
				const pinnedLookup = options.lookup;
				if (!pinnedLookup) throw new Error("Missing pinned lookup");
				const local = new URL(url);
				local.protocol = "http:";
				return request(local, {
					...options, port: address.port,
					lookup(hostname, lookupOptions, done) {
						pinnedLookup(hostname, { ...lookupOptions, all: false }, (error, ip) => {
							if (error) { done(error, "", 4); return; }
							expect(ip).toBe("93.184.216.34");
							if (lookupOptions.all) done(null, [{ address: "127.0.0.1", family: 4 }]);
							else done(null, "127.0.0.1", 4);
						});
					},
				}, callback);
			},
		}, urls);
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
			server.closeAllConnections();
		});
	}
}
