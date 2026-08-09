import os from "node:os";
import path from "node:path";

/** User-owned persistent root; unlike a shared /tmp prefix, other users cannot preempt it. */
export const TERMINAL_ENVIRONMENT_RUNTIME_ROOT = path.join(
	os.homedir(),
	".cache",
	"mepie",
	"terminal-environment",
);
