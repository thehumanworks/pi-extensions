import { homedir } from "node:os";
import { resolve, join } from "node:path";

export function agentDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
}
export function workflowPaths(home?: string) {
  const directory = resolve(home ?? process.env.PI_WORKFLOW_HOME ?? join(agentDirectory(), "workflow-runs"));
  return { home: directory, database: join(directory, "runs.sqlite"), socket: join(directory, "worker.sock"), log: join(directory, "worker.log"), worktrees: join(directory, "worktrees") };
}
