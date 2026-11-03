/** What one nested codemode call is doing: a status line for the row header and a target for its tree row. */
export interface CallActivity {
	readonly status: string;
	readonly target: string;
}

/** A string argument; `cut` when codemode's 200-character preview ended inside it. */
interface ArgValue {
	readonly text: string;
	readonly cut: boolean;
}

type ArgReader = (key: string) => ArgValue | undefined;

/**
 * Describe a nested call from its name and codemode's argument preview, a JSON string that codemode
 * cuts at 200 characters, so it may not parse.
 */
export function describeCall(name: string, argsPreview: string, cwd: string): CallActivity {
	const field = argReader(argsPreview);
	const arg = (key: string) => {
		const value = field(key);
		return value?.cut ? `${value.text}…` : value?.text;
	};
	const path = () => relativePath(arg("path") ?? "", cwd);
	switch (name) {
		case "bash": {
			const command = field("command");
			return activity("Running", lastCommand(command?.text ?? "", command?.cut ?? false));
		}
		case "read":
			return activity("Reading", path());
		case "edit":
			return activity("Editing", path());
		case "write":
			return activity("Writing", path());
		case "rg":
		case "grep":
			return activity("Searching", quoted(arg("pattern")));
		case "fd":
		case "find":
			return activity("Finding", arg("pattern") ?? path());
		case "ls":
			return activity("Listing", path());
		case "ww_fetch":
			return activity("Fetching", arg("url") ?? arg("urls") ?? "");
		case "ww_search":
			return activity("Searching the web", quoted(arg("query")));
		case "ww_read":
			return activity("Reading", "cached source");
		case "find_docs":
			return activity("Looking up", `${arg("library") ?? arg("libraryId") ?? ""} docs`.trim());
		// Model calls preview their arguments as the plain "provider/id" model reference.
		case "models.classify":
			return { status: "Classifying", target: inline(argsPreview) };
		case "models.generateImages":
			return { status: "Generating images", target: inline(argsPreview) };
		default:
			return { status: `Calling ${inline(name)}`, target: inline(argsPreview) };
	}
}

/**
 * The command a bash call ends with: the last part of a `&&`, `||`, `;`, or newline chain, without
 * leading environment assignments, redirections, or the commands it pipes into.
 *
 * A `cut` command ends mid-step, so it names the last step that came through whole, marked with `…`.
 */
export function lastCommand(command: string, cut = false): string {
	const steps = splitOutsideQuotes(command, ["&&", "||", ";", "\n"]).filter((step) => step.trim() !== "");
	const wholeSteps = cut && steps.length > 1 ? steps.slice(0, -1) : steps;
	const name = commandName(wholeSteps.at(-1) ?? "");
	return cut && name ? `${name} …` : name;
}

function commandName(step: string): string {
	const pipeline = splitOutsideQuotes(step, ["|"]);
	const head = (pipeline[0] ?? "").replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
	return inline(withoutRedirections(head));
}

/**
 * Redirections such as `2>&1` or `> out.txt` name where output goes, not what runs. They usually trail
 * the command, so cut at the first unquoted `>` or `<`, along with a file descriptor (`2`, `&`) attached to it.
 */
function withoutRedirections(command: string): string {
	const parts = splitOutsideQuotes(command, [">", "<"]);
	const beforeRedirect = parts[0] ?? "";
	return parts.length > 1 ? beforeRedirect.replace(/(^|\s)(?:\d+|&)$/, "$1") : beforeRedirect;
}

/** Collapse whitespace and drop control characters, which would break a one-line terminal row. */
export function inline(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function activity(verb: string, target: string): CallActivity {
	const clean = inline(target);
	return { status: clean ? `${verb} ${clean}` : verb, target: clean };
}

function quoted(value: string | undefined): string {
	return value ? `"${value}"` : "";
}

function relativePath(path: string, cwd: string): string {
	const bare = path.startsWith("@") ? path.slice(1) : path;
	return bare.startsWith(`${cwd}/`) ? bare.slice(cwd.length + 1) : bare;
}

function argReader(preview: string): ArgReader {
	const parsed = parseRecord(preview);
	if (parsed) {
		return (key) => {
			const value = parsed[key];
			if (typeof value === "string") return { text: value, cut: false };
			if (Array.isArray(value) && typeof value[0] === "string") return { text: value[0], cut: false };
			return undefined;
		};
	}
	return (key) => truncatedStringField(preview, key);
}

function parseRecord(text: string): Readonly<Record<string, unknown>> | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Read a string field, or the first string of an array field, from a JSON preview that was cut short.
 * A field without its closing quote ran into the cut, which ends with codemode's `...` marker.
 */
function truncatedStringField(preview: string, key: string): ArgValue | undefined {
	const match = new RegExp(`"${key}":\\[?"((?:[^"\\\\]|\\\\.)*)(")?`).exec(preview);
	if (!match?.[1]) return undefined;
	const cut = match[2] === undefined;
	const raw = cut ? match[1].replace(/\.\.\.$/, "") : match[1];
	return { text: decodeJsonString(raw), cut };
}

function decodeJsonString(raw: string): string {
	// The cut can split an escape sequence; drop an unpaired trailing backslash before decoding.
	const closed = raw.replace(/\\+$/, (slashes) => (slashes.length % 2 === 1 ? slashes.slice(1) : slashes));
	try {
		const value: unknown = JSON.parse(`"${closed}"`);
		return typeof value === "string" ? value : raw;
	} catch {
		return raw;
	}
}

function splitOutsideQuotes(text: string, separators: readonly string[]): string[] {
	const parts: string[] = [];
	let start = 0;
	let quote: string | undefined;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quote) {
			if (char === "\\" && quote === '"') index++;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (char === "\\") {
			index++;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		const separator = separators.find((candidate) => text.startsWith(candidate, index));
		if (separator) {
			parts.push(text.slice(start, index));
			index += separator.length - 1;
			start = index + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}
