/** Userinfo is never needed in tool output, including when a URL is rejected. */
export function displayUrl(value: string): string {
	try {
		const url = new URL(value);
		if (!url.username && !url.password) return value;
		url.username = "";
		url.password = "";
		return url.href;
	} catch {
		return "[Invalid URL]";
	}
}
