import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { WorkflowError } from "./errors.ts";

export function agentDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
}
export function workflowPaths(home?: string) {
  const directory = resolve(home ?? process.env.PI_WORKFLOW_HOME ?? join(agentDirectory(), "workflow-runs"));
  return { home: directory, database: join(directory, "runs.sqlite"), socket: join(directory, "worker.sock"), log: join(directory, "worker.log"), worktrees: join(directory, "worktrees") };
}
/** Unix socket paths are limited to sun_path (104 bytes on macOS, 108 on Linux) including the terminating NUL. */
export function assertSocketPath(socket: string, platform: NodeJS.Platform = process.platform): void {
  const limit = platform === "darwin" ? 103 : 107;
  const length = Buffer.byteLength(socket);
  if (length > limit) throw new WorkflowError("home_too_long", `Workflow home is too long for a Unix socket: ${socket} is ${length} bytes, the limit is ${limit}. Pass a shorter --home or set PI_WORKFLOW_HOME to a shorter directory.`);
}
