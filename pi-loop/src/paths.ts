import { homedir } from "node:os";
import { resolve, join } from "node:path";

export function loopPaths() {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|\/)/, homedir()) ?? join(homedir(), ".pi", "agent");
  const home = resolve(process.env.PI_LOOP_HOME ?? join(agentDir, "loop"));
  const socket = join(home, "worker.sock");
  if (Buffer.byteLength(socket) > 100) throw new Error("PI_LOOP_HOME is too long for a Unix socket; choose a shorter directory.");
  return { home, socket, database: join(home, "loop.sqlite"), log: join(home, "worker.log") };
}
