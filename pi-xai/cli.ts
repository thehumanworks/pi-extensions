#!/usr/bin/env -S node --experimental-strip-types
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AuthStatus, LocalAuthOptions } from "./auth.ts";
import type { DeviceCode } from "./src/oauth.ts";

type Auth = {
  login(options: {
    onDeviceCode: (device: DeviceCode) => void | Promise<void>;
    signal?: AbortSignal;
  }): Promise<AuthStatus>;
  getAccessToken(): Promise<string>;
  refresh(): Promise<AuthStatus>;
  status(): Promise<AuthStatus>;
  logout(): Promise<void>;
};

export type CliDependencies = {
  createAuth?: (options?: LocalAuthOptions) => Auth | Promise<Auth>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  openBrowser?: (url: string) => Promise<void>;
  signal?: AbortSignal;
};

const help = `Usage: xai-auth [--auth-file PATH] <command>

Commands:
  login [--no-browser]  Sign in using a device code
  token                Print the cached access token, refreshing when needed
  refresh              Refresh the saved login
  status               Print safe login metadata
  logout               Remove the saved login
  help                 Show this help

XAI_AUTH_FILE overrides the default ~/.config/xai/auth.json path.
`;

async function openBrowser(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Invalid browser URL");
  }
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command as string, args as string[], {
      shell: false,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Browser unavailable")),
    );
  });
}

function safeStatus(status: AuthStatus): AuthStatus {
  return {
    authenticated: status.authenticated === true,
    path: status.path,
    ...(typeof status.expiresAt === "string"
      ? { expiresAt: status.expiresAt }
      : {}),
    ...(typeof status.refreshable === "boolean"
      ? { refreshable: status.refreshable }
      : {}),
    ...(typeof status.expired === "boolean" ? { expired: status.expired } : {}),
  };
}

/** Returns an exit code; errors never include provider bodies or credentials. */
export async function runCli(
  args: string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const signal = dependencies.signal;
  const write =
    dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const stdout = (text: string) => {
    if (!signal?.aborted) write(text);
  };
  const stderr = dependencies.stderr ?? ((text) => process.stderr.write(text));
  let authPath: string | undefined;
  let noBrowser = false;
  const positional: string[] = [];
  let invalid = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--auth-file") {
      const value = args[++index];
      if (authPath !== undefined || !value || value.startsWith("-")) {
        invalid = true;
        break;
      }
      authPath = value;
    } else if (arg === "--no-browser") {
      if (noBrowser) invalid = true;
      noBrowser = true;
    } else if (arg === "--help" || arg === "-h") {
      positional.push("help");
    } else if (arg.startsWith("-")) {
      invalid = true;
    } else {
      positional.push(arg);
    }
  }
  const command = positional[0] ?? "help";
  if (
    invalid ||
    positional.length > 1 ||
    !["login", "token", "refresh", "status", "logout", "help"].includes(
      command,
    ) ||
    (noBrowser && command !== "login")
  ) {
    stderr("Invalid arguments. Run xai-auth --help for usage.\n");
    return 2;
  }
  if (command === "help") {
    stdout(help);
    return 0;
  }
  if (signal?.aborted) {
    stderr("Authentication command cancelled.\n");
    return 130;
  }
  let abort: (() => void) | undefined;
  try {
    const work = async () => {
      const createAuth =
        dependencies.createAuth ?? (await import("./auth.ts")).createLocalAuth;
      if (signal?.aborted) throw new Error("Cancelled");
      const auth = await createAuth(
        authPath || signal
          ? { ...(authPath ? { authPath } : {}), ...(signal ? { signal } : {}) }
          : undefined,
      );
      if (signal?.aborted) throw new Error("Cancelled");
      const printStatus = (status: AuthStatus) =>
        stdout(`${JSON.stringify(safeStatus(status))}\n`);
      switch (command) {
        case "login":
          printStatus(
            await auth.login({
              signal,
              async onDeviceCode(device: DeviceCode) {
                if (signal?.aborted) return;
                const url =
                  device.verification_uri_complete ?? device.verification_uri;
                stderr(`Open ${url}\nEnter code: ${device.user_code}\n`);
                if (!noBrowser) {
                  try {
                    await (dependencies.openBrowser ?? openBrowser)(url);
                  } catch {
                    stderr("Could not open your browser. Use the URL above.\n");
                  }
                }
              },
            }),
          );
          break;
        case "token":
          stdout(`${await auth.getAccessToken()}\n`);
          break;
        case "refresh":
          printStatus(await auth.refresh());
          break;
        case "status":
          printStatus(await auth.status());
          break;
        case "logout":
          await auth.logout();
          printStatus(await auth.status());
          break;
      }
    };
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
    });
    await Promise.race([work(), cancelled]);
    return 0;
  } catch {
    if (signal?.aborted) {
      stderr("Authentication command cancelled.\n");
      return 130;
    }
    stderr(
      "Authentication command failed. Check your login with xai-auth status; use xai-auth login to sign in.\n",
    );
    return 1;
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const code = await runCli(process.argv.slice(2), {
    signal: controller.signal,
  });
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  process.exitCode = code;
  if (controller.signal.aborted) process.exit(code);
}
