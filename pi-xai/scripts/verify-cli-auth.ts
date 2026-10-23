/** Real installed xai process -> auth helper -> refresh/cache -> local API fixture. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = await mkdtemp(join(tmpdir(), "xai-cli-auth-e2e-"));
const authPath = join(directory, "auth.json");
const redirectPath = join(directory, "fixture-fetch.mjs");
const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));
let refreshes = 0;
let apiCalls = 0;
const failures: string[] = [];
const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/oauth2/token" && request.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    if (
      form.get("grant_type") !== "refresh_token" ||
      form.get("refresh_token") !== "fixture-refresh"
    ) {
      failures.push("unexpected refresh grant");
      response.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    refreshes++;
    response.end(
      JSON.stringify({
        access_token: "fixture-fresh-access",
        refresh_token: "fixture-rotated-refresh",
        expires_in: 3600,
        extra_field: "retained",
      }),
    );
  } else if (request.url === "/v1/models" && request.method === "GET") {
    apiCalls++;
    if (request.headers.authorization !== "Bearer fixture-fresh-access") {
      failures.push("API did not receive the refreshed token");
      response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    response.end(
      JSON.stringify({
        object: "list",
        data: [
          { id: "fixture-model", object: "model", created: 0, owned_by: "xai" },
        ],
      }),
    );
  } else {
    failures.push(`unexpected request ${request.method} ${request.url}`);
    response.writeHead(404).end("{}");
  }
});

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function run(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.env.XAI_CLI_BIN || "xai", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(stdout)
        : reject(new Error(`Installed xai exited ${code}: ${stderr}`));
    });
  });
}

try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const now = Date.now();
  await writeFile(
    authPath,
    JSON.stringify({
      version: 1,
      obtainedAt: now - 4_000_000,
      expiresAt: now - 400_000,
      token: {
        access_token: "fixture-expired-access",
        refresh_token: "fixture-refresh",
        expires_in: 3600,
        login_metadata: "preserved",
      },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    redirectPath,
    `const nativeFetch=globalThis.fetch; globalThis.fetch=(url,init)=>nativeFetch(String(url)==='https://auth.x.ai/oauth2/token'?${JSON.stringify(origin + "/oauth2/token")}:url,init);\n`,
  );
  const command = [
    process.execPath,
    "--experimental-strip-types",
    "--import",
    redirectPath,
    cliPath,
    "--auth-file",
    authPath,
    "token",
  ]
    .map(quote)
    .join(" ");
  const env = { ...process.env };
  delete env.XAI_API_KEY;
  env.XAI_API_KEY_CMD = command;
  env.XDG_CONFIG_HOME = directory;
  const version = (await run(["--version"], env)).trim();
  for (let call = 0; call < 2; call++) {
    const models = JSON.parse(
      await run(["--base-url", `${origin}/v1`, "models", "--json"], env),
    );
    assert.equal(models.data[0].id, "fixture-model");
  }
  const cache = JSON.parse(await readFile(authPath, "utf8"));
  assert.equal(cache.token.refresh_token, "fixture-rotated-refresh");
  assert.equal(cache.token.login_metadata, "preserved");
  assert.equal(cache.token.extra_field, "retained");
  assert.equal((await stat(authPath)).mode & 0o777, 0o600);
  assert.equal(refreshes, 1);
  assert.equal(apiCalls, 2);
  assert.deepEqual(failures, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        cli: version,
        refreshes,
        apiCalls,
        cachePermissions: "0600",
        network: "local fixtures only",
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
