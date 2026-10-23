import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createLocalAuth, resolveAuthPath, type CachedLogin } from "../auth.ts";

const epoch = 1_800_000_000_000;
const original: CachedLogin = {
  version: 1,
  obtainedAt: epoch,
  expiresAt: epoch + 3_600_000,
  token: {
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_in: 3600,
    id_token: "private-id-token",
    provider_extra: { preserved: true },
  },
};

async function fixture(
  run: (directory: string, authPath: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "xai-local-auth-"));
  try {
    await run(directory, join(directory, "private", "auth.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function seed(path: string, cache = original) {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(cache), { mode: 0o600 });
}

test("cache lookup and status stay lazy, and environment paths are configurable", async () => {
  await fixture(async (directory, authPath) => {
    const auth = createLocalAuth({ authPath });
    assert.equal(await auth.getCachedAccessToken(), undefined);
    assert.deepEqual(await auth.status(), {
      authenticated: false,
      path: authPath,
    });
    await auth.logout();
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(auth.getAccessToken(), /Run pnpm auth login/);
    assert.equal(
      resolveAuthPath({
        env: (name) => (name === "XAI_AUTH_FILE" ? authPath : undefined),
      }),
      authPath,
    );
    assert.equal(
      resolveAuthPath({
        env: (name) => (name === "XDG_CONFIG_HOME" ? directory : undefined),
      }),
      join(directory, "xai", "auth.json"),
    );
  });
});

test("device login saves the full JSON atomically with private permissions", async () => {
  await fixture(async (directory, authPath) => {
    let clock = epoch;
    let requests = 0;
    const fullToken = {
      ...original.token,
      token_type: "Bearer",
      scope: "api:access offline_access",
    };
    const auth = createLocalAuth({
      authPath,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      fetch: (async (_url, init) => {
        const form = new URLSearchParams(init?.body as URLSearchParams);
        requests++;
        if (!form.has("grant_type"))
          return Response.json({
            device_code: "private-device",
            user_code: "ABCD",
            verification_uri: "https://accounts.x.ai/device",
            expires_in: 600,
            interval: 1,
          });
        return Response.json(fullToken);
      }) as typeof fetch,
    });
    const codes: string[] = [];
    const status = await auth.login({
      onDeviceCode: (device) => {
        codes.push(device.user_code);
      },
    });
    assert.deepEqual(codes, ["ABCD"]);
    assert.equal(requests, 2);
    assert.equal(status.authenticated, true);
    assert.equal(status.expired, false);
    assert.equal(JSON.stringify(status).includes("old-access"), false);
    const cache = JSON.parse(await readFile(authPath, "utf8"));
    assert.deepEqual(cache.token, fullToken);
    assert.equal(cache.obtainedAt, clock);
    assert.equal(cache.expiresAt, clock + 3_600_000);
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "private"))).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(join(directory, "private")), ["auth.json"]);
    assert.equal(await auth.getAccessToken(), "old-access");
    assert.equal(requests, 2);
    await auth.logout();
    assert.deepEqual(await auth.status(), {
      authenticated: false,
      path: authPath,
    });
  });
});

test("logout waits for a first login in flight and removes its newly saved cache", async () => {
  await fixture(async (_directory, authPath) => {
    let notify!: () => void;
    let approve!: () => void;
    const notified = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const approval = new Promise<void>((resolve) => {
      approve = resolve;
    });
    const auth = createLocalAuth({
      authPath,
      sleep: async () => {
        await approval;
      },
      fetch: (async (_url, init) => {
        const form = new URLSearchParams(init?.body as URLSearchParams);
        return form.has("grant_type")
          ? Response.json(original.token)
          : Response.json({
              device_code: "device",
              user_code: "code",
              verification_uri: "https://accounts.x.ai/device",
              expires_in: 600,
              interval: 1,
            });
      }) as typeof fetch,
    });
    const loggingIn = auth.login({
      onDeviceCode: () => {
        notify();
      },
    });
    await notified;
    const loggingOut = createLocalAuth({ authPath }).logout();
    await new Promise((resolve) => setTimeout(resolve, 20));
    approve();
    await loggingIn;
    await loggingOut;
    assert.equal((await auth.status()).authenticated, false);
  });
});

test("near-expiry refresh rotates credentials, preserves fields and is shared across instances", async () => {
  await fixture(async (_directory, authPath) => {
    await seed(authPath);
    let requests = 0;
    const options = {
      authPath,
      now: () => epoch + 3_500_000,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        requests++;
        const form = new URLSearchParams(init?.body as URLSearchParams);
        assert.equal(form.get("refresh_token"), "old-refresh");
        await new Promise((resolve) => setTimeout(resolve, 30));
        return Response.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          new_field: "new",
        });
      }) as typeof fetch,
    };
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () =>
        createLocalAuth(options).getAccessToken(),
      ),
    );
    assert.deepEqual(tokens, Array(8).fill("rotated-access"));
    assert.equal(requests, 1);
    const cache = JSON.parse(await readFile(authPath, "utf8"));
    assert.equal(cache.token.refresh_token, "rotated-refresh");
    assert.deepEqual(cache.token.provider_extra, { preserved: true });
    assert.equal(cache.token.id_token, "private-id-token");
    assert.equal(cache.token.new_field, "new");
    assert.equal(cache.expiresAt, epoch + 3_500_000 + 3_600_000);
  });
});

test("short-lived tokens refresh at half their lifetime, and omitted refresh tokens are retained", async () => {
  await fixture(async (_directory, authPath) => {
    const cache = {
      ...original,
      expiresAt: epoch + 60_000,
      token: { ...original.token, expires_in: 60 },
    };
    await seed(authPath, cache);
    let clock = epoch + 20_000;
    let requests = 0;
    const auth = createLocalAuth({
      authPath,
      now: () => clock,
      fetch: (async () => {
        requests++;
        return Response.json({ access_token: "new", expires_in: 60 });
      }) as typeof fetch,
    });
    assert.equal(await auth.getAccessToken(), "old-access");
    assert.equal(requests, 0);
    clock += 11_000;
    assert.equal(await auth.getAccessToken(), "new");
    assert.equal(requests, 1);
    assert.equal(
      JSON.parse(await readFile(authPath, "utf8")).token.refresh_token,
      "old-refresh",
    );
    await auth.refresh();
    assert.equal(requests, 2);
  });
});

test("failed refresh preserves the existing cache and provides a login recovery error", async () => {
  await fixture(async (_directory, authPath) => {
    await seed(authPath);
    const before = await readFile(authPath, "utf8");
    const auth = createLocalAuth({
      authPath,
      now: () => epoch + 4_000_000,
      fetch: (async () =>
        Response.json(
          { error: "invalid_grant", error_description: "secret provider body" },
          { status: 400 },
        )) as typeof fetch,
    });
    await assert.rejects(auth.getAccessToken(), (error: Error) => {
      assert.match(error.message, /Run pnpm auth login again/);
      assert.ok(!error.message.includes("secret"));
      return true;
    });
    assert.equal(await readFile(authPath, "utf8"), before);
    assert.deepEqual(await readdir(join(authPath, "..")), ["auth.json"]);
  });
});

test("malformed and symlinked caches reject without exposing contents or replacing the target", async () => {
  await fixture(async (directory, authPath) => {
    await seed(authPath);
    await writeFile(authPath, '{"access_token":"secret-in-invalid-cache"}');
    const auth = createLocalAuth({ authPath });
    await assert.rejects(auth.status(), /Invalid xAI login cache/);
    await assert.rejects(
      auth.getAccessToken(),
      (error: Error) => !error.message.includes("secret-in-invalid-cache"),
    );
    await rm(authPath);
    const target = join(directory, "unrelated.json");
    await writeFile(target, "preserve this");
    await symlink(target, authPath);
    await assert.rejects(auth.getAccessToken(), /Cannot read/);
    await assert.rejects(auth.logout(), /regular file/);
    assert.equal(await readFile(target, "utf8"), "preserve this");
  });
});

test("abandoned locks recover, while active lock waits can be cancelled", async () => {
  await fixture(async (_directory, authPath) => {
    await seed(authPath);
    await mkdir(`${authPath}.lock`);
    const past = new Date(Date.now() - 60_000);
    await utimes(`${authPath}.lock`, past, past);
    const auth = createLocalAuth({
      authPath,
      fetch: (async () =>
        Response.json({
          access_token: "new",
          expires_in: 3600,
        })) as typeof fetch,
    });
    await auth.refresh();
    await mkdir(`${authPath}.lock`);
    const controller = new AbortController();
    const waiting = createLocalAuth({
      authPath,
      signal: controller.signal,
    }).refresh();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(waiting, { name: "AbortError" });
    await assert.rejects(
      createLocalAuth({ authPath, lockTimeoutMs: 20 }).refresh(),
      /cache is busy/,
    );
  });
});

function child(source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn(
      globalThis.process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", source],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    process.stdout.on("data", (data) => {
      stdout += data;
    });
    process.stderr.on("data", (data) => {
      stderr += data;
    });
    process.on("error", reject);
    process.on("close", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`child failed: ${stderr}`)),
    );
  });
}

test("separate CLI processes refresh a rotating credential exactly once", async () => {
  await fixture(async (_directory, authPath) => {
    await seed(authPath, {
      ...original,
      obtainedAt: Date.now() - 4_000_000,
      expiresAt: Date.now() - 400_000,
    });
    let requests = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      assert.equal(form.get("refresh_token"), "old-refresh");
      requests++;
      await new Promise((resolve) => setTimeout(resolve, 60));
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          access_token: "shared-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      assert(address && typeof address === "object");
      const endpoint = `http://127.0.0.1:${address.port}`;
      const modulePath = fileURLToPath(new URL("../auth.ts", import.meta.url));
      const source = `import {createLocalAuth} from ${JSON.stringify(modulePath)}; const auth=createLocalAuth({authPath:${JSON.stringify(authPath)},fetch:(_url,init)=>fetch(${JSON.stringify(endpoint)},init)}); console.log(await auth.getAccessToken());`;
      assert.deepEqual(
        await Promise.all(Array.from({ length: 4 }, () => child(source))),
        Array(4).fill("shared-access"),
      );
      assert.equal(requests, 1);
      assert.equal(
        JSON.parse(await readFile(authPath, "utf8")).token.refresh_token,
        "rotated-refresh",
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
