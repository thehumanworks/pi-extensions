import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests never read or write the real ~/.pi/agent: pi's global settings and the guidance file are looked up here.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-recall-agent-"));
