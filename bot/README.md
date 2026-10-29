# Bot

A local-first bot workspace with an independently installable runtime, an AI SDK
adapter, and a maintained web application. The web application is a supported
client of the same durable bot used by the CLI and SDK—not a separate demo or
another agent loop.

## Packages

| Package | Location | Responsibility |
| --- | --- | --- |
| [`@nothumanwork/bot`](packages/runtime/README.md) | `packages/runtime` | Pi-powered SDK, CLI, host tools, local SQLite, recovery, capabilities and memory. |
| [`@nothumanwork/bot-ai-sdk`](packages/ai-sdk/README.md) | `packages/ai-sdk` | Framework-independent bridge from a structural bot backend to AI SDK UI message streams and `useChat`. |
| [`@nothumanwork/bot-ui`](apps/web/README.md) | `apps/web` | Supported Next.js chat application. Runs separately from the bot daemon. |

```text
Next.js application / any useChat client
                 │ AI SDK UI message stream
          bot-ai-sdk adapter
                 │ injected backend or HTTP /v1 API
            bot runtime
                 │
       Pi + host tools + SQLite
```

The runtime does not depend on AI SDK, Next.js or React. The adapter does not
import the runtime, Pi, Next.js or React: a small structural backend contract is
its integration boundary. The UI imports only the adapter's public package API
and connects to a separately supervised bot over HTTP. Provider credentials stay
with that bot's OS user. No Vercel hosting, AI Gateway or cloud sandbox is needed.

The runtime inherits the user's global Pi extensions, MCP servers, skills and tool
settings by default. Pi's native `AgentSession` executes these bots; `pi-durable`
owns the persistent queue and run records. Isolated bots with `inherit: none` and
no native extension factories use the durable executor. `BOT.md` has no format or
version discriminator. See the [runtime guide](packages/runtime/README.md) for
capabilities, provider setup, the HTTP/event contract, and operational limits.

## Run locally

Requires Node 22.19+ (Node 24 recommended), npm, a Unix-like host with `flock`,
and existing Pi provider credentials for real conversations. From the parent
`pi-extensions` checkout:

```sh
npm ci --ignore-scripts
cd bot
npm run build:runtime
npm run build:adapter

# Initialize once; bot source and durable state live outside this checkout.
node packages/runtime/bin/bot.mjs init "$HOME/bots/assistant" \
  --name Assistant --model openai/gpt-6.1-sol
node packages/runtime/bin/bot.mjs serve "$HOME/bots/assistant" \
  --host ::1 --port 8787 --cwd "$HOME"
```

In another terminal:

```sh
cd ~/pi-extensions/bot
# Uses http://[::1]:8787 by default. Set BOT_SERVER_URL for another daemon.
npm run dev
```

Open **http://[::1]:3001**. Brackets are required for IPv6 addresses. The default
UI bind is loopback-only, including on WSL where IPv4 localhost may be unavailable.

For production:

```sh
npm run build:ui
npm start
```

### Standalone native web binary

With Node, Bun (tested with 1.4.2), and the workspace dependencies installed:

```sh
# From bot/; this builds the adapter and the same production Next UI.
npm run build:native
./dist/bot-web --host ::1 --port 3001
# Optional daemon override: --backend-url http://[::1]:8787
```

`bot-web` is a Bun-compiled native executable containing the production HTML,
JavaScript, CSS and adapter HTTP host—not a launcher for `next start`. It needs no
Node, Bun, `node_modules`, or checkout at runtime. It still connects to a separately
supervised daemon. The existing `bot` runtime CLI is unchanged; UI dependencies
are never added to the runtime package. Native builds target the current OS/CPU.
The executable reads server configuration from its process environment, **not**
`.env.local`, incidental `.env`/`bunfig.toml`, or other files in its working directory.
See the [UI guide](apps/web/README.md#native-distribution) for deployment limits.

The runtime uses the existing Pi login in `~/.pi/agent/auth.json` by default;
no new provider-key environment variables are needed. The web process never
starts a bot, takes ownership of its SQLite database, or asks for model credentials. Start and supervise the bot daemon separately. Set
`BOT_SERVER_TOKEN` on the web server if the daemon requires a caller token;
never expose that token as a `NEXT_PUBLIC_*` variable. See the UI guide for
configuration, security boundaries and deployment.

## Durability and lifecycle

The bot runtime owns conversations, run acceptance, tools and recovery. The UI
is a projection of that state, not a second transcript database. Refreshing or
closing a browser must not cancel an accepted run; Stop is an explicit request
to the bot's cancellation endpoint. Reconnection reads existing work, never
submits another turn. Accepted IDs survive browser reload in URL/storage references,
including for queued runs not yet present in an active snapshot. New requests use
stable idempotency keys.

Durability does not make arbitrary host effects transactional. Native Pi requests
interrupted by shutdown or a crash fail closed rather than replaying possibly
completed effects. The isolated durable executor replays interrupted tools only
when explicitly safe. Existing durable conversations need a new conversation
when enabling native execution. The runtime is trusted host code, not a security
sandbox. Review the [runtime's operational limits](packages/runtime/README.md#operational-limits)
before network use.

## Development

`bot/package.json` is a private npm-workspace coordinator. The enclosing
repository also registers the nested packages so existing Pi consumers continue
to resolve `@nothumanwork/bot` by its unchanged package name. The repository's
`package-lock.json` is the authoritative development lockfile; install from the
parent checkout, not independently in each package.

```sh
# From bot/:
npm run build
npm run check
npm test
npm run test:e2e             # production Next host; build:ui first
npm run build:native
npm run test:native          # native unit tests + the same browser acceptance suite

# Or target a package from the repository root:
npm run test --workspace @nothumanwork/bot
npm run test --workspace @nothumanwork/bot-ai-sdk
npm run test --workspace @nothumanwork/bot-ui
```

The browser integration test uses a temporary scripted Pi backend and the actual
Next.js app (including its embedded native distribution), with system Chromium. It does not call a live model or use personal
bot state. `CHROMIUM_PATH` can select the browser executable. Build the UI before
running the production browser test.

Each public library has its own manifest, exports, build, tests and release
version. The UI is a private, independently deployable application; it is not
bundled into either library. Root publish helpers skip private packages. No
publishing or service installation is performed by development scripts.

## Nix

The flake remains at `bot/flake.nix`. Its default / `#bot` package and app
continue to provide the runtime CLI; **`#web` runs the native UI**:

```sh
cd ~/pi-extensions/bot
# In one terminal, after initializing this bot once:
nix run "path:$PWD#bot" -- serve "$HOME/bots/assistant" \
  --host ::1 --port 8787 --cwd "$HOME"

# In another terminal:
nix run "path:$PWD#web"                    # http://[::1]:3001
nix run "path:$PWD#web" -- --help
nix build "path:$PWD#bot-web"              # result/bin/bot-web
./result/bin/bot-web --host ::1 --port 3001

nix develop "path:$PWD"                   # Node, Bun and development tools
nix flake check "path:$PWD"               # runtime + native web build/checks
```

`path:` includes new unstaged files; ordinary Git flake references include only
tracked files. Once these changes are in a revision, the same app is available
as `github:thehumanworks/pi-extensions?dir=bot#web`.

Both Nix builds have independent dependency locks: `packages/runtime/nix` for the
runtime and `nix/web` for the adapter/UI. Neither needs the enclosing repository's
workspace lock. The web package installs the actual native executable and no
JavaScript runtime wrapper; it does not start a daemon or install a service.
Nix-built binaries use the normal Nix shared-library closure; use Nix to transfer
that closure, rather than copying an ELF alone to a non-Nix machine. For non-Nix
deployment, build with Bun on the target platform. See the
[runtime Nix guide](packages/runtime/nix/README.md) and
[native web packaging guide](nix/web/README.md).
