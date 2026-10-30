import { defineWorkflow } from '@nothumanwork/pi-orchestration';

export default defineWorkflow({
  name: 'native-web',
  description: 'Build a native Bun web host and isolated Nix package in disjoint scopes.',
  budget: { maxAgents: 2, maxDurationMs: 1_800_000 },
  async run(ctx) {
    return ctx.parallel([
      () => ctx.agent(`Read .pi/NATIVE-PLAN.md in full. Implement Agent A's scope only: native/ server CLI, lib/api.ts shared request router, Next API route wrappers, test/api.test.ts and native/test. No manifests/config/build script/docs/Nix edits; coordinator owns those. Build to the exact native main(args,assets) contract. Standalone embedded asset paths passed via map, no runtime Next/Node/checkout or subprocess. Preserve backend durability and guard/security behavior. UI remains the same Next application. Run real offline tests with Bun, use ::1 for sockets. You have 12 minutes: prioritize small robust code and tests over research. No global installs, paid calls, commits or publishing. Report checks and integration details.`, { label: 'native-host', thinkingLevel: 'medium', timeoutMs: 900_000 }),
      () => ctx.agent(`Read .pi/NATIVE-PLAN.md in full. Implement Agent B's scope only: nix/web/. Isolated buildNpmPackage expression, private workspace root manifest, lock/hash updater, useful smoke test/notes. Do not edit root flake or other manifests; coordinator integrates them. Actual build command will be adapter build then npm run build:native --workspace @nothumanwork/bot-ui, producing apps/web/dist/bot-web. Final install must be actual native binary, no Node/Bun/Next/node_modules runtime wrapper. Source must include UI+adapter not runtime; no network during sandbox compile. Keep old runtime lock/hash intact. Do not run update-lock until coordinator completes new dependencies (you may write/test pure helpers). You have 10 minutes, keep scope focused. No installs/commits/publishing.`, { label: 'nix-package', thinkingLevel: 'medium', timeoutMs: 720_000 }),
    ], { failure: 'allSettled' });
  },
});
