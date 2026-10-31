import { getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";

export type TrustInput = {
  cwd: string;
  /** Pi's answer, `ctx.isProjectTrusted()`. */
  projectTrusted: boolean;
  /** The `defaultProjectTrust` setting. */
  defaultProjectTrust?: string;
  argv?: readonly string[];
  agentDir?: string;
};

/**
 * Whether project agents in `<cwd>/.pi/agents` may load. Pi does not ask about a folder that
 * holds none of the resources it protects and reports it trusted, and it does not know about
 * `.pi/agents`. A cloned repository could then shadow the user's agents unasked. So project
 * agents need a real decision: Pi asked because other protected resources exist, the folder
 * was trusted with /trust, `defaultProjectTrust` is "always", or `--approve` was given.
 */
export function projectAgentsTrusted(input: TrustInput): boolean {
  if (!input.projectTrusted) return false;
  if (hasTrustRequiringProjectResources(input.cwd)) return true;
  if (input.defaultProjectTrust === "always") return true;
  const argv = input.argv ?? process.argv.slice(2);
  if (argv.includes("--approve") || argv.includes("-a")) return true;
  return new ProjectTrustStore(input.agentDir ?? getAgentDir()).get(input.cwd) === true;
}
