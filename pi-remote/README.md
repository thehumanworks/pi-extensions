# pi-remote

Run Pi's built-in `read`, `write`, `edit`, `bash`, `ls`, `find`, and `grep` tools on another machine over SSH. The agent can switch the active execution host mid-session, probe hosts, run one command on many hosts, and copy files between them. Local execution remains the default until a remote host is selected. Supports Pi 1.4.0.

## Install

From this checkout:

```sh
pi install ./pi-remote
```

After publication:

```sh
pi install npm:@nothumanwork/pi-remote
```

## Prerequisites

- An OpenSSH client (`ssh`) on the local machine.
- Key-based SSH access to each remote host. Connections run in `BatchMode`, so password and interactive prompts are not supported; use `ssh-agent` or an identity file.
- A remote system supported by [`@earendil-works/pi-env`](https://www.npmjs.com/package/@earendil-works/pi-env): Linux, macOS, Android (Termux), or Windows on x86-64 or arm64. On first connection pi-env deploys a small verified daemon to the remote host; nothing else needs to be installed there.

## Use

Start on a remote host, or make hosts available for the agent to choose from:

```sh
pi --remote alice@gpu.example:2222/work/app
pi --remote-hosts alice@gpu.example/work/app,build.example --remote-identity ~/.ssh/id_ed25519
```

Hosts use the form `user@host[:port][/absolute/cwd]`. Without a working directory, the remote home directory is used. `local` always refers to this machine.

In the TUI:

```text
/remote                                  # show the active host
/remote use alice@gpu.example /work/app  # switch host and working directory
/remote use local                        # return to this machine
```

The agent gets a `remote_host` tool and a system prompt section naming the active host, its working directory, and the available hosts. `remote_host` actions:

| Action | Purpose |
| --- | --- |
| `status` | Show the active host and every known host |
| `use` / `switch` | Make a host active, optionally with a `cwd` (created if missing) |
| `probe` | Connect to `hosts` and report platform, architecture, home, and latency |
| `exec` | Run `command` on `hosts` (default: all known hosts) in parallel, with an optional `timeoutSeconds` (default 30) |
| `copy` | Copy a file from `sourceHost:sourcePath` to `destinationHost:destinationPath`, reporting its SHA-256 |
| `forget` | Remove a host's trusted key and disconnect it |

User `!` shell commands also run on the active host. The footer shows `remote <host>` while a remote host is active.

## Configuration

Hosts can also be listed in `.pi/remote-hosts.json` in the project directory or `~/.pi/remote-hosts.json`:

```json
{
  "hosts": [
    "alice@gpu.example/work/app",
    { "target": "deploy@build.example:2222", "identityFile": "keys/build_ed25519" }
  ]
}
```

A per-host `identityFile` is resolved relative to the config file. Invalid config files are ignored.

| Flag | Environment variable | Purpose |
| --- | --- | --- |
| `--remote` | | Initial execution host |
| `--remote-hosts` | | Comma-separated hosts available to the agent |
| `--remote-identity` | `PI_REMOTE_IDENTITY` | SSH private key used when a host has none of its own |
| `--remote-trust-new` | `PI_REMOTE_TRUST_NEW=1` | Trust a host key the first time a host is seen |
| | `PI_REMOTE_KNOWN_HOSTS` | Known-hosts file (default `~/.pi/remote/known_hosts`) |

## Host keys

pi-remote keeps its own known-hosts file and checks host keys strictly; it does not use `~/.ssh/known_hosts`. An unknown host is rejected unless `--remote-trust-new` is set, in which case the scanned key fingerprints are logged and saved. A changed key is always rejected: confirm the new key out of band, call `remote_host` with `forget`, and reconnect.

Per-host SSH config is generated under `~/.pi/remote/ssh-config/`; your `~/.ssh/config` is not applied. Agent forwarding, port forwarding, and connection sharing are disabled.

## Development

```sh
npm run check --workspace @nothumanwork/pi-remote
npm test --workspace @nothumanwork/pi-remote
```

Tests require Bun. The end-to-end test starts two disposable `sshd` servers bound to `127.0.0.1`; set `PI_REMOTE_TEST_ADDRESS` to bind them elsewhere.
