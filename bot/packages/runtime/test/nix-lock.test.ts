import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the standalone Nix npm lock matches the package manifest", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../nix/package-lock.json", import.meta.url), "utf8"));
  assert.equal(lock.lockfileVersion, 3);
  for (const key of ["name", "version", "dependencies", "devDependencies", "engines", "bin"]) {
    assert.deepEqual(lock.packages[""][key], manifest[key], `${key} changed: run nix/update-lock.sh in the dev shell`);
  }
  for (const [path, entry] of Object.entries(lock.packages) as [string, { link?: boolean; resolved?: string; integrity?: string }][]) {
    if (path === "") continue;
    assert.equal(entry.link, undefined, `Nix dependencies must not link to another workspace: ${path}`);
    assert.match(entry.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, path);
    assert.ok(entry.integrity, `Missing integrity hash: ${path}`);
  }
});
