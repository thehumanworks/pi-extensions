import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SpaceXAI } from "@xai-official/sdk";
import { registerXaiTools } from "../index.ts";
import { getPiApiKey } from "../pi-auth.ts";

const pi = { registerTool() {} } as unknown as ExtensionAPI;

test("Pi auth reads both access token formats from disk without modifying credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xai-pi-auth-"));
  const authPath = join(directory, "auth.json");
  try {
    for (const credential of [
      { access_token: "raw-access-token" },
      {
        type: "oauth",
        access: "canonical-access-token",
        refresh: "refresh",
        expires: Date.now() + 60000,
      },
      { access_token: "raw-access-token", access: "canonical-access-token" },
    ]) {
      const original = JSON.stringify({
        xai: credential,
        other: { access_token: "other-provider" },
      });
      await writeFile(authPath, original);
      assert.equal(
        await getPiApiKey({
          readLocalToken: async () => undefined,
          authPath,
          env: () => "inherited-key",
        }),
        "access_token" in credential
          ? credential.access_token
          : credential.access,
      );
      assert.equal(await readFile(authPath, "utf8"), original);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("saved Pi login takes precedence over environment credentials", async () => {
  const reads: string[] = [];
  const key = await getPiApiKey({
    readLocalToken: async () => undefined,
    authPath: "fixture-auth.json",
    readCredential(provider, authPath) {
      assert.equal(provider, "xai");
      assert.equal(authPath, "fixture-auth.json");
      return { access_token: "saved-token" };
    },
    env(name) {
      reads.push(name);
      return "environment-key";
    },
  });
  assert.equal(key, "saved-token");
  assert.deepEqual(reads, []);
});

test("missing or unusable Pi credentials fall back only to XAI_API_KEY", async () => {
  for (const credential of [
    undefined,
    null,
    "wrong-shape",
    {},
    { access_token: "" },
    { access_token: 42 },
    { access: "   " },
    { refresh: "refresh-only" },
  ]) {
    const reads: string[] = [];
    assert.equal(
      await getPiApiKey({
        readLocalToken: async () => undefined,
        readCredential: () => credential,
        env(name) {
          reads.push(name);
          return "environment-key";
        },
      }),
      "environment-key",
    );
    assert.deepEqual(reads, ["XAI_API_KEY"]);
  }
  await assert.rejects(
    () =>
      getPiApiKey({
        readLocalToken: async () => undefined,
        readCredential: () => undefined,
        env: () => undefined,
      }),
    /log in to xai in Pi, set XAI_API_KEY/,
  );
});

test("missing and malformed auth files remain untouched during environment fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xai-pi-auth-"));
  const authPath = join(directory, "auth.json");
  try {
    assert.equal(
      await getPiApiKey({
        readLocalToken: async () => undefined,
        authPath,
        env: () => "environment-key",
      }),
      "environment-key",
    );
    await assert.rejects(readFile(authPath), { code: "ENOENT" });
    await writeFile(authPath, "malformed JSON");
    assert.equal(
      await getPiApiKey({
        readLocalToken: async () => undefined,
        authPath,
        env: () => "environment-key",
      }),
      "environment-key",
    );
    assert.equal(await readFile(authPath, "utf8"), "malformed JSON");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi adapter lazily uses the saved login and picks up later token changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xai-pi-auth-"));
  const authPath = join(directory, "auth.json");
  const sent: string[] = [];
  try {
    const toolkit = registerXaiTools(pi, {
      authPath,
      localAuthPath: join(directory, "managed-auth.json"),
      clientOptions: {
        fetch: (async (input: Request | string | URL) => {
          assert(input instanceof Request);
          sent.push(input.headers.get("authorization")!);
          return Response.json({
            object: "list",
            data: [{ id: "fixture-model" }],
          });
        }) as typeof fetch,
      },
    });
    const capabilities = await toolkit.meta.capabilities({});
    assert.match(capabilities.authentication, /saved Pi xai login/);
    assert.deepEqual(sent, []);
    await assert.rejects(readFile(authPath), { code: "ENOENT" });
    await writeFile(
      authPath,
      JSON.stringify({ xai: { access_token: "first-token" } }),
    );
    const first = await toolkit.getClient();
    assert.equal(await toolkit.getClient(), first);
    await toolkit.models.list({});
    await writeFile(
      authPath,
      JSON.stringify({ xai: { type: "oauth", access: "second-token" } }),
    );
    const second = await toolkit.getClient();
    assert.notEqual(first, second);
    await toolkit.models.list({});
    assert.deepEqual(sent, ["Bearer first-token", "Bearer second-token"]);
    assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), {
      xai: { type: "oauth", access: "second-token" },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit keys and clients override Pi auth resolution", async () => {
  const toolkit = registerXaiTools(pi, {
    authPath: "missing-auth.json",
    localAuthPath: "/nonexistent/xai-pi-explicit-auth.json",
    apiKey: "explicit-key",
    clientOptions: {
      fetch: (async (input: Request) => {
        assert.equal(input.headers.get("authorization"), "Bearer explicit-key");
        return Response.json({ object: "list", data: [] });
      }) as typeof fetch,
    },
  });
  await toolkit.models.list({});
  const client = new SpaceXAI({ apiKey: "explicit-client" });
  const injected = registerXaiTools(pi, {
    client,
    apiKey: () => {
      throw new Error("Must not resolve credentials");
    },
  });
  assert.equal(await injected.getClient(), client);
});

test("managed local login precedes Pi login and environment credentials", async () => {
  let reads = 0;
  assert.equal(
    await getPiApiKey({
      localAuthPath: "/fixture/local-auth.json",
      readLocalToken: async (path) => {
        assert.equal(path, "/fixture/local-auth.json");
        return "managed-token";
      },
      readCredential: () => {
        reads++;
        return { access_token: "pi-token" };
      },
      env: () => {
        reads++;
        return "environment-token";
      },
    }),
    "managed-token",
  );
  assert.equal(reads, 0);
});

test("managed cache refresh errors propagate without switching accounts", async () => {
  const error = new Error("Cannot refresh the managed login");
  await assert.rejects(
    getPiApiKey({
      readLocalToken: async () => {
        throw error;
      },
      readCredential: () => {
        assert.fail("must not read another account");
      },
      env: () => {
        assert.fail("must not fall back to environment");
      },
    }),
    (actual) => actual === error,
  );
});

test("Pi adapter picks up updated managed cached tokens without changing Pi credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xai-pi-managed-"));
  const authPath = join(directory, "pi-auth.json");
  const localAuthPath = join(directory, "local-auth.json");
  const originalPi = JSON.stringify({ xai: { access_token: "pi-token" } });
  const sent: string[] = [];
  try {
    await writeFile(authPath, originalPi);
    const toolkit = registerXaiTools(pi, {
      authPath,
      localAuthPath,
      clientOptions: {
        fetch: (async (input: Request | string | URL) => {
          assert(input instanceof Request);
          sent.push(input.headers.get("authorization")!);
          return Response.json({ object: "list", data: [] });
        }) as typeof fetch,
      },
    });
    for (const token of ["managed-first", "managed-second"]) {
      const obtainedAt = Date.now();
      await writeFile(
        localAuthPath,
        JSON.stringify({
          version: 1,
          obtainedAt,
          expiresAt: obtainedAt + 3600000,
          token: {
            access_token: token,
            refresh_token: "refresh",
            expires_in: 3600,
            token_type: "Bearer",
          },
        }),
        { mode: 0o600 },
      );
      await toolkit.models.list({});
    }
    assert.deepEqual(sent, ["Bearer managed-first", "Bearer managed-second"]);
    assert.equal(await readFile(authPath, "utf8"), originalPi);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
