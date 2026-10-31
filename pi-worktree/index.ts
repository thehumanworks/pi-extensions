import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createLocalBashOperations,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

function runGit(args: string[], cwd: string) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    success: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: (result.stderr ?? "") || result.error?.message || "",
  };
}

const NAME_WORDS = [
  "amber",
  "azure",
  "bold",
  "brave",
  "bright",
  "calm",
  "clear",
  "cool",
  "crisp",
  "deep",
  "eager",
  "fair",
  "fast",
  "fine",
  "fresh",
  "glad",
  "happy",
  "kind",
  "lively",
  "lucky",
  "merry",
  "mild",
  "noble",
  "proud",
  "quick",
  "quiet",
  "ready",
  "sharp",
  "smart",
  "smooth",
  "solid",
  "stout",
  "sunny",
  "swift",
  "tidy",
  "tough",
  "vivid",
  "warm",
  "wise",
  "young",
  "ash",
  "bay",
  "berry",
  "birch",
  "brook",
  "cedar",
  "cliff",
  "cloud",
  "cove",
  "creek",
  "delta",
  "dune",
  "fern",
  "field",
  "fjord",
  "frost",
  "garden",
  "glade",
  "glow",
  "grove",
  "harbor",
  "haven",
  "hill",
  "isle",
  "lake",
  "leaf",
  "marsh",
  "meadow",
  "mesa",
  "mist",
  "moor",
  "mountain",
  "ocean",
  "orchard",
  "peak",
  "pine",
  "plain",
  "pond",
  "ridge",
  "river",
  "shore",
  "spring",
  "stream",
  "thicket",
  "trail",
  "valley",
  "vale",
  "willow",
  "wave",
  "wood",
];

function randomName(): string {
  const pick = () => {
    const word = NAME_WORDS[Math.floor(Math.random() * NAME_WORDS.length)];
    if (!word) throw new Error("empty word list");
    return word;
  };
  return `${pick()}-${pick()}-${pick()}`;
}

function normalizeWorktreeName(rawName: string): string | null {
  const name = rawName.trim();
  if (!name) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return null;
  if (name.includes("..") || name.endsWith(".") || name.endsWith(".lock")) {
    return null;
  }
  return name;
}

function worktreeNameRules(): string {
  return "Use 1-64 characters: letters, numbers, dots, underscores, or hyphens; start with a letter or number.";
}

function parseWorktreeFlagName(argv = process.argv.slice(2)): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--worktree") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-") && !next.startsWith("@")) {
        return next;
      }
      return undefined;
    }
    if (arg?.startsWith("--worktree=")) {
      const value = arg.slice("--worktree=".length).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

// Detect whether `--ssh` is present on the command line. pi-ssh overrides
// bash/read/write/edit to route them to a remote host, and pi rejects
// extensions that register the same tool name. Worktree mode (which rewrites
// those same tools to a local worktree path) is mutually exclusive with SSH
// mode at runtime, so when --ssh is active we skip the conflicting tool
// overrides and let pi-ssh own them.
function sshFlagPresent(argv = process.argv.slice(2)): boolean {
  for (const arg of argv) {
    if (arg === "--ssh") return true;
    if (arg?.startsWith("--ssh=")) return true;
  }
  return false;
}

function branchExists(repoRoot: string, branch: string): boolean {
  return runGit(
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    repoRoot,
  ).success;
}

function currentBranch(worktreePath: string): string | null {
  const branch = runGit(["branch", "--show-current"], worktreePath);
  if (!branch.success) return null;
  const trimmed = branch.stdout.trim();
  return trimmed.length > 0 ? trimmed : "detached HEAD";
}

function getUsableWorktree(worktreePath: string): { branch: string } | null {
  if (!existsSync(worktreePath)) return null;

  const insideRepo = runGit(
    ["rev-parse", "--is-inside-work-tree"],
    worktreePath,
  );
  if (!insideRepo.success || insideRepo.stdout.trim() !== "true") {
    return null;
  }

  const topLevel = runGit(["rev-parse", "--show-toplevel"], worktreePath);
  if (
    !topLevel.success ||
    path.resolve(topLevel.stdout.trim()) !== path.resolve(worktreePath)
  ) {
    return null;
  }

  return { branch: currentBranch(worktreePath) ?? "unknown" };
}

function ensureWorktreesExcluded(
  repoRoot: string,
  ctx: ExtensionContext,
  source: string,
) {
  // Keep the worktrees directory out of the parent repo's `git status`
  // by appending it to .git/info/exclude. This file is local-only (never
  // committed) and is shared across linked worktrees via the common git
  // dir, so each worktree inherits the rule.
  const commonDirResult = runGit(["rev-parse", "--git-common-dir"], repoRoot);
  if (!commonDirResult.success) return;

  const commonDir = path.resolve(repoRoot, commonDirResult.stdout.trim());
  const excludePath = path.join(commonDir, "info", "exclude");
  const rule = ".pi/worktrees/";
  try {
    const existing =
      existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    if (!existing.split(/\r?\n/).includes(rule)) {
      mkdirSync(path.dirname(excludePath), { recursive: true });
      const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
      writeFileSync(excludePath, `${existing}${sep}${rule}\n`);
    }
  } catch (err) {
    ctx.ui.notify(
      `${source}: could not update ${excludePath}: ${(err as Error).message}`,
      "warning",
    );
  }
}

export default function (pi: ExtensionAPI) {
  const worktreeFlag = {
    description:
      "Start the pi agent inside a git worktree, optionally named with --worktree=<name>",
    default: false,
    type: "boolean" as const,
    short: "w",
  };

  pi.registerFlag("worktree", worktreeFlag);

  let resolvedWorktree: {
    path: string;
    branch: string;
    throwawayBranch: string;
    repoRoot: string;
    name: string;
    reused: boolean;
  } | null = null;

  function activateWorktree(
    ctx: ExtensionContext,
    source: "--worktree" | "/worktree",
    rawName?: string,
  ): boolean {
    const trimmedRawName = rawName?.trim();
    const requestedName =
      trimmedRawName && trimmedRawName.length > 0
        ? normalizeWorktreeName(trimmedRawName)
        : undefined;

    if (trimmedRawName && !requestedName) {
      ctx.ui.notify(`${source}: invalid worktree name. ${worktreeNameRules()}`, "error");
      return false;
    }

    if (resolvedWorktree) {
      const sameName = !requestedName || requestedName === resolvedWorktree.name;
      ctx.ui.notify(
        sameName
          ? `${source}: already using worktree ${resolvedWorktree.name} at ${resolvedWorktree.path}`
          : `${source}: already using worktree ${resolvedWorktree.name} at ${resolvedWorktree.path}; start a new session to use ${requestedName}`,
        "info",
      );
      return true;
    }

    const insideRepo = runGit(["rev-parse", "--is-inside-work-tree"], ctx.cwd);
    if (!insideRepo.success || insideRepo.stdout.trim() !== "true") {
      ctx.ui.notify(`${source}: not inside a git repository, skipping`, "info");
      return false;
    }

    const topLevel = runGit(["rev-parse", "--show-toplevel"], ctx.cwd);
    if (!topLevel.success) {
      ctx.ui.notify(
        `${source}: failed to resolve repo root: ${topLevel.stderr.trim()}`,
        "warning",
      );
      return false;
    }
    const repoRoot = topLevel.stdout.trim();

    const worktreesDir = path.join(repoRoot, ".pi", "worktrees");
    try {
      mkdirSync(worktreesDir, { recursive: true });
    } catch (err) {
      ctx.ui.notify(
        `${source}: failed to create ${worktreesDir}: ${(err as Error).message}`,
        "error",
      );
      return false;
    }

    ensureWorktreesExcluded(repoRoot, ctx, source);

    let name = requestedName;
    if (!name) {
      for (let i = 0; i < 50; i++) {
        const candidate = randomName();
        const candidateBranch = `pi/${candidate}`;
        if (
          !existsSync(path.join(worktreesDir, candidate)) &&
          !branchExists(repoRoot, candidateBranch)
        ) {
          name = candidate;
          break;
        }
      }
    }

    if (!name) {
      ctx.ui.notify(`${source}: failed to choose an available worktree name`, "error");
      return false;
    }

    const worktreePath = path.join(worktreesDir, name);
    const throwawayBranch = `pi/${name}`;

    if (requestedName && existsSync(worktreePath)) {
      runGit(["worktree", "repair", worktreePath], repoRoot);
      const usableWorktree = getUsableWorktree(worktreePath);
      if (usableWorktree) {
        resolvedWorktree = {
          path: worktreePath,
          branch: usableWorktree.branch,
          throwawayBranch,
          repoRoot,
          name,
          reused: true,
        };
        ctx.ui.setStatus(
          "worktree",
          ctx.ui.theme.fg("accent", `Worktree: ${name} (${usableWorktree.branch})`),
        );
        ctx.ui.notify(
          `Reusing worktree at ${worktreePath} on branch ${usableWorktree.branch}`,
          "info",
        );
        return true;
      }
    }

    if (requestedName && !existsSync(worktreePath)) {
      runGit(["worktree", "prune"], repoRoot);
    }

    const restoringExistingBranch = branchExists(repoRoot, throwawayBranch);
    const created = runGit(
      restoringExistingBranch
        ? ["worktree", "add", worktreePath, throwawayBranch]
        : ["worktree", "add", "-b", throwawayBranch, worktreePath],
      repoRoot,
    );
    if (!created.success) {
      ctx.ui.notify(
        `${source}: failed to create worktree ${name}: ${created.stderr.trim()}`,
        "error",
      );
      return false;
    }

    resolvedWorktree = {
      path: worktreePath,
      branch: currentBranch(worktreePath) ?? throwawayBranch,
      throwawayBranch,
      repoRoot,
      name,
      reused: restoringExistingBranch,
    };
    ctx.ui.setStatus(
      "worktree",
      ctx.ui.theme.fg("accent", `Worktree: ${name} (${resolvedWorktree.branch})`),
    );
    ctx.ui.notify(
      `${restoringExistingBranch ? "Restored" : "Created"} worktree at ${worktreePath} on branch ${resolvedWorktree.branch}`,
      "info",
    );
    return true;
  }

  const localCwd = process.cwd();
  const sshMode = sshFlagPresent();

  if (!sshMode) {
    // Intercept built-in tool calls lazily — only redirect when a worktree is
    // active. Registering replacement tools eagerly causes conflicts with other
    // extensions (e.g. amp-tool-display) that also override the same tools.
    pi.on("tool_call", (event) => {
      if (!resolvedWorktree) return;
      const wt = resolvedWorktree.path;
      const input = event.input as Record<string, unknown>;

      if (event.toolName === "bash") {
        // Prefix every bash command with a cd so it runs inside the worktree.
        // This is equivalent to createBashTool(wt) which also starts fresh in
        // the worktree directory for each invocation.
        const command = input.command as string;
        input.command = `cd ${JSON.stringify(wt)}\n${command}`;
      } else if (
        event.toolName === "read" ||
        event.toolName === "write" ||
        event.toolName === "edit"
      ) {
        // These tools require an explicit path; resolve relative paths against
        // the worktree so the LLM's relative references land in the right place.
        const p = input.path as string | undefined;
        if (p != null && !path.isAbsolute(p)) {
          input.path = path.resolve(wt, p);
        }
      } else if (
        event.toolName === "grep" ||
        event.toolName === "find" ||
        event.toolName === "ls"
      ) {
        // These tools default to the tool's configured cwd when path is absent;
        // override to use the worktree root instead.
        const p = input.path as string | undefined;
        if (p == null || p === "") {
          input.path = wt;
        } else if (!path.isAbsolute(p)) {
          input.path = path.resolve(wt, p);
        }
      }
    });

    // Route user `!cmd` invocations through the worktree as well.
    pi.on("user_bash", () => {
      if (!resolvedWorktree) return;
      const wtPath = resolvedWorktree.path;
      const localOps = createLocalBashOperations();
      return {
        operations: {
          exec: (command, _cwd, options) =>
            localOps.exec(command, wtPath, options),
        },
      };
    });
  }

  pi.registerCommand("worktree", {
    description: "Create or reuse a git worktree: /worktree [name]",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      if (sshMode) {
        ctx.ui.notify(
          "/worktree: disabled because --ssh is active; worktree and SSH modes are mutually exclusive.",
          "warning",
        );
        return;
      }
      activateWorktree(ctx, "/worktree", args);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!(pi.getFlag("worktree") as boolean)) return;
    if (sshMode) {
      ctx.ui.notify(
        "--worktree ignored because --ssh is active; worktree and SSH modes are mutually exclusive.",
        "warning",
      );
      return;
    }
    activateWorktree(ctx, "--worktree", parseWorktreeFlagName());
  });

  pi.on("before_agent_start", async (event) => {
    if (!resolvedWorktree) return;
    const { path: worktreePath, branch, throwawayBranch, name, reused } =
      resolvedWorktree;
    const guidance = [
      "",
      "## Git worktree mode",
      reused
        ? `You are running in a reused git worktree named \`${name}\` at ${worktreePath}, currently checked out on branch \`${branch}\`.`
        : `You are running in a fresh git worktree named \`${name}\` at ${worktreePath}, currently checked out on the throwaway branch \`${throwawayBranch}\`. This branch only exists to host the worktree and is not the branch that should carry the work.`,
      "",
      "All your file and shell tools (bash, read, write, edit, grep, find, ls) execute inside this worktree, so just run normal git commands like `git checkout -b feat/<slug>`, `git add`, `git commit`, and `git push -u origin <feature-branch>` directly — they operate on this worktree's branch, not on the user's original checkout.",
      "",
      reused
        ? "Before making changes, inspect the current branch and git status. If the user is continuing existing work, preserve the current branch; otherwise create a new feature branch off the appropriate base with a short, descriptive, kebab-case name."
        : "When the user describes the task, your first action MUST be to create a new feature branch off the appropriate base (typically the repo's default branch) with a short, descriptive, kebab-case name derived from the request (e.g. `feat/<slug>` or `fix/<slug>`), and switch to it before making any code changes.",
      "",
      `Never push automatically just because the work appears complete. Only push when the user explicitly asks you to push, ship, publish, or open a PR. When you do push, push the feature branch to the remote (using \`git push -u origin <feature-branch>\` on the first push). Never push the worktree host branch \`${throwawayBranch}\`, and never push to \`main\`/\`master\` or any other shared branch.`,
      "",
      "Do not remove or clean up the worktree automatically during the session. Cleanup is an explicit user decision and may be handled by a shutdown prompt outside the model loop.",
    ].join("\n");
    const withCwd = event.systemPrompt.replace(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${worktreePath} (git worktree on branch ${branch})`,
    );
    return { systemPrompt: `${withCwd}\n${guidance}` };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!resolvedWorktree) return;
    const { path: worktreePath, branch, throwawayBranch, repoRoot, name } =
      resolvedWorktree;

    if (!ctx.hasUI) {
      return;
    }

    const status = runGit(["status", "--porcelain"], worktreePath);
    const statusNote =
      status.success && status.stdout.trim().length > 0
        ? "This worktree has uncommitted or untracked changes. Cleanup uses normal git removal and may fail without manual cleanup first."
        : "Cleanup uses normal git removal only (no force).";

    const choice = await ctx.ui.select(
      [
        "Clean up git worktree before leaving?",
        "",
        `Name: ${name}`,
        `Worktree: ${worktreePath}`,
        `Branch at activation: ${branch}`,
        `Throwaway branch: ${throwawayBranch}`,
        "",
        statusNote,
        "Cancel or timeout keeps everything.",
      ].join("\n"),
      [
        "Keep worktree and branch",
        "Remove worktree only",
        "Remove worktree and delete throwaway branch",
      ],
      { timeout: 10000 },
    );

    if (!choice || choice === "Keep worktree and branch") {
      ctx.ui.notify(
        `Keeping worktree at ${worktreePath}`,
        "info",
      );
      return;
    }

    const removed = runGit(["worktree", "remove", worktreePath], repoRoot);
    if (!removed.success) {
      ctx.ui.notify(
        `Could not remove worktree at ${worktreePath}: ${removed.stderr.trim()}. Remove manually with: git -C "${repoRoot}" worktree remove "${worktreePath}"`,
        "warning",
      );
      return;
    }

    ctx.ui.notify(`Removed worktree at ${worktreePath}`, "info");

    if (choice !== "Remove worktree and delete throwaway branch") {
      return;
    }

    const branchExists = runGit(
      ["show-ref", "--verify", "--quiet", `refs/heads/${throwawayBranch}`],
      repoRoot,
    );
    if (!branchExists.success) {
      return;
    }

    const branchDeleted = runGit(["branch", "-D", throwawayBranch], repoRoot);
    if (!branchDeleted.success) {
      ctx.ui.notify(
        `Could not delete throwaway branch \`${throwawayBranch}\`: ${branchDeleted.stderr.trim()}. Remove manually with: git -C "${repoRoot}" branch -D "${throwawayBranch}"`,
        "warning",
      );
      return;
    }

    ctx.ui.notify(`Deleted throwaway branch \`${throwawayBranch}\``, "info");
  });
}
