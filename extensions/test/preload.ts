import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep tests independent of the developer's real ~/.pi/agent settings, such as mepie.json.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "mepie-test-agent-"));
