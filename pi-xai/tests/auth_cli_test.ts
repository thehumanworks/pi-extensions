import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli, type CliDependencies } from "../cli.ts";

function fixture() {
  const calls: unknown[] = [];
  let stdout = "";
  let stderr = "";
  const status = {
    authenticated: true,
    path: "/fixture/auth.json",
    expiresAt: "2026-01-01T00:00:00Z",
    refreshable: true,
    expired: false,
    access_token: "secret-that-must-not-appear",
  };
  const auth = {
    async login(
      options: Parameters<
        Awaited<ReturnType<NonNullable<CliDependencies["createAuth"]>>>["login"]
      >[0],
    ) {
      calls.push("login");
      await options.onDeviceCode({
        device_code: "private-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://example.com/device",
        expires_in: 600,
        expires_at: Date.now() + 600000,
        interval: 5,
      });
      return status;
    },
    async getAccessToken() {
      calls.push("token");
      return "access-token";
    },
    async refresh() {
      calls.push("refresh");
      return status;
    },
    async status() {
      calls.push("status");
      return status;
    },
    async logout() {
      calls.push("logout");
    },
  };
  const dependencies: CliDependencies = {
    createAuth(options) {
      calls.push(options);
      return auth;
    },
    stdout(text) {
      stdout += text;
    },
    stderr(text) {
      stderr += text;
    },
    async openBrowser(url) {
      calls.push(url);
    },
  };
  return { calls, auth, dependencies, output: () => ({ stdout, stderr }) };
}

test("token prints only the token and overrides the auth file", async () => {
  const f = fixture();
  assert.equal(
    await runCli(["token", "--auth-file", "/custom/auth.json"], f.dependencies),
    0,
  );
  assert.deepEqual(f.calls, [{ authPath: "/custom/auth.json" }, "token"]);
  assert.deepEqual(f.output(), { stdout: "access-token\n", stderr: "" });
});

test("status, refresh and logout print only safe metadata", async () => {
  for (const command of ["status", "refresh", "logout"]) {
    const f = fixture();
    assert.equal(await runCli([command], f.dependencies), 0);
    const value = JSON.parse(f.output().stdout);
    assert.deepEqual(Object.keys(value), [
      "authenticated",
      "path",
      "expiresAt",
      "refreshable",
      "expired",
    ]);
    assert.equal(f.output().stderr, "");
    assert.ok(!f.output().stdout.includes("secret"));
    assert.deepEqual(
      f.calls.slice(1),
      command === "logout" ? ["logout", "status"] : [command],
    );
  }
});

test("login diagnostics use stderr and browser failure falls back to URL", async () => {
  const f = fixture();
  f.dependencies.openBrowser = async () => {
    throw new Error("private browser detail");
  };
  assert.equal(await runCli(["login"], f.dependencies), 0);
  assert.match(f.output().stderr, /https:\/\/example.com\/device/);
  assert.match(f.output().stderr, /ABCD-EFGH/);
  assert.match(f.output().stderr, /Could not open your browser/);
  assert.ok(!f.output().stderr.includes("private"));
  assert.ok(!f.output().stdout.includes("ABCD"));
  assert.ok(!f.output().stdout.includes("secret"));
});

test("no-browser suppresses opening and help avoids all auth calls", async () => {
  const f = fixture();
  f.dependencies.openBrowser = async () => {
    assert.fail("browser called");
  };
  assert.equal(await runCli(["--no-browser", "login"], f.dependencies), 0);
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const f = fixture();
    assert.equal(await runCli(args, f.dependencies), 0);
    assert.deepEqual(f.calls, []);
    assert.match(f.output().stdout, /Usage:/);
  }
});

test("invalid arguments have no auth calls and no stdout", async () => {
  for (const args of [
    ["bad"],
    ["token", "extra"],
    ["--auth-file"],
    ["--bad"],
    ["token", "--no-browser"],
    ["--no-browser"],
    ["login", "--no-browser", "--no-browser"],
    ["status", "--auth-file", "a", "--auth-file", "b"],
  ]) {
    const f = fixture();
    assert.equal(await runCli(args, f.dependencies), 2);
    assert.deepEqual(f.calls, []);
    assert.equal(f.output().stdout, "");
    assert.match(f.output().stderr, /Invalid arguments/);
  }
});

test("provider errors cannot leak credentials or raw response bodies", async () => {
  const f = fixture();
  f.auth.getAccessToken = async () => {
    throw new Error("access-token raw-provider-body");
  };
  assert.equal(await runCli(["token"], f.dependencies), 1);
  assert.equal(f.output().stdout, "");
  assert.match(f.output().stderr, /Authentication command failed/);
  assert.ok(!f.output().stderr.includes("raw-provider"));
  assert.ok(!f.output().stderr.includes("access-token"));
});

test("cancellation promptly returns and prevents late token output", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.dependencies.signal = controller.signal;
  let finish!: (token: string) => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.auth.getAccessToken = () => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const running = runCli(["token"], f.dependencies);
  await startedPromise;
  assert.equal(
    (f.calls[0] as { signal: AbortSignal }).signal,
    controller.signal,
  );
  controller.abort();
  assert.equal(await running, 130);
  finish("late-secret");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.output().stdout, "");
  assert.match(f.output().stderr, /cancelled/);
  const alreadyCancelled = fixture();
  alreadyCancelled.dependencies.signal = controller.signal;
  assert.equal(await runCli(["login"], alreadyCancelled.dependencies), 130);
  assert.deepEqual(alreadyCancelled.calls, []);
});

test("real subprocess help succeeds without accessing the auth file", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("../cli.ts", import.meta.url)),
      "--help",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, XAI_AUTH_FILE: "/nonexistent/for-help/auth.json" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.ok(!result.stderr.includes("Authentication"));
});

test("package bin symlinks execute the CLI and its shebang", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xai-auth-bin-"));
  try {
    const bin = join(directory, "xai-auth");
    await symlink(fileURLToPath(new URL("../cli.ts", import.meta.url)), bin);
    const result = spawnSync(bin, ["--help"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: xai-auth/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
