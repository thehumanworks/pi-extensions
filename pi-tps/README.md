# Tokens per second for Pi

Shows an informational notification after each agent run with output tokens per
second, input/output token counts, cache reads/writes, total tokens, and elapsed
time. Usage is summed across all assistant messages in that run.

The rate is output tokens divided by the full run duration, including model
latency and tool execution. It measures the run's overall throughput, rather than
the provider's streaming generation speed. Token counts come from Pi's reported
usage. Runs with no output tokens, no measurable elapsed time, or no interactive
UI produce no notification.

## Install

Requires Pi and Node.js 22.19+. Tested against Pi 1.4.0. After publication:

```sh
pi install npm:@nothumanwork/pi-tps
```

For a local install, from the repository root:

```sh
pi install ./pi-tps
```

Or load it for one session:

```sh
pi --extension ./pi-tps/index.ts
```

Use `/reload` in an existing session after changing the extension. Remove an
older copy of the extension from Pi's configuration to avoid duplicate
notifications. No configuration, commands, or additional credentials are needed.
Non-interactive runs are silent.

## Develop and publish

Run these commands from the repository root, using the shared lockfile:

```sh
npm ci --ignore-scripts
npm run check --workspace @nothumanwork/pi-tps
npm test --workspace @nothumanwork/pi-tps
npm run pack:check
npm run test:scripts
npm run publish:package -- pi-tps --dry-run
```

The tarball contains `index.ts`, this README, and the package manifest. Pi loads
the TypeScript entry point directly; no build step is required. Pi supplies the
host SDK peer dependencies at runtime.

To publish version 0.1.0 after validation, log in with an npm account that can
publish public packages under `@nothumanwork`, then run:

```sh
npm login
npm run publish:package -- pi-tps
```

The dry run does not upload a package. npm enforces scope permissions, version
uniqueness, and any 2FA requirements. For later releases, bump only this
workspace's version and include the shared lockfile change, as described in the
[repository publishing guide](https://github.com/thehumanworks/pi-extensions#publish-one-package).
