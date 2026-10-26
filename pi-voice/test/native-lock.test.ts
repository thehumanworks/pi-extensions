import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

interface LockedPackage {
  version: string;
  optional?: boolean;
  os?: string[];
  cpu?: string[];
  optionalDependencies?: Record<string, string>;
}

test("lockfile includes native audio binaries for every supported platform", () => {
  // A macOS-only lockfile makes npm on Linux report "up to date" without
  // installing its binary, even with --include=optional. Check the lock, not
  // node_modules: tests on one OS cannot load the other platforms' binaries.
  const { packages } = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8")) as {
    packages: Record<string, LockedPackage>;
  };
  const { dependencies } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const core = Object.entries(packages).find(([path, pkg]) =>
    path.endsWith("node_modules/@oh-my-pi/pi-natives") && pkg.version === dependencies["@oh-my-pi/pi-natives"]);
  assert.ok(core, "Missing locked native audio package");
  const leaves = core[1].optionalDependencies;
  assert.ok(leaves, "Missing native platform dependencies");
  assert.deepEqual(Object.keys(leaves).sort(), [
    "darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64",
  ].map(tag => `@oh-my-pi/pi-natives-${tag}`));
  for (const [name, version] of Object.entries(leaves)) {
    const leaf = Object.entries(packages).find(([path, pkg]) =>
      path.endsWith(`node_modules/${name}`) && pkg.version === version)?.[1];
    assert.ok(leaf, `Missing locked platform dependency: ${name}@${version}`);
    const [os, cpu] = name.replace("@oh-my-pi/pi-natives-", "").split("-");
    assert.equal(leaf.optional, true);
    assert.deepEqual(leaf.os, [os]);
    assert.deepEqual(leaf.cpu, [cpu]);
  }
});
