import { stripVTControlCharacters } from "node:util";

/** Sanitize external text before adding trusted theme escapes. Stored content stays unchanged. */
export function terminalText(value: string): string {
	return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
}
