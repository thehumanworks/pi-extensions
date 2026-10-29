# @nothumanwork/bot-ui

The maintained browser workspace for a separately supervised bot daemon. Next.js 16.4.3, React 19.3.1, AI SDK 7.0.155 and `@ai-sdk/react` 4.0.159 are pinned. The application uses `useChat` and the published `@nothumanwork/bot-ai-sdk` package; it does not import the runtime, Pi, providers, or sibling source files.

## Run locally

Requires Node.js **22.19 or newer** and the workspace dependencies installed by the workspace owner. From the `bot` workspace root:

```sh
# Build the adapter's package exports before building/running the app.
npm run build:adapter
cp apps/web/.env.example apps/web/.env.local
# Start the real bot daemon separately, using the runtime's documented serve command.
npm run dev --workspace @nothumanwork/bot-ui
```

Open **http://[::1]:3001**. Both `dev` and `start` bind IPv6 loopback `::1`, port `3001`, by default. The app does not start a bot, bundle a mock backend, or make paid provider calls itself. The daemon controls model execution and tool permissions; sending a message to your real daemon can incur whatever costs that daemon is configured to incur.

Production:

```sh
npm run build:adapter
npm run build --workspace @nothumanwork/bot-ui
npm run start --workspace @nothumanwork/bot-ui
```

To change the Next host's listen address/port deliberately, run its CLI from `apps/web` (for example `npm exec -- next start --hostname ::1 --port 3002`), or change the service launch command.

## Native distribution

The same application also builds into **`bot-web`**, a single native executable. From `bot/`:

```sh
# Nix: builds and runs the native UI, not next start.
nix run "path:$PWD#web"
nix build "path:$PWD#bot-web"    # result/bin/bot-web

# Non-Nix: requires Node, Bun (tested with 1.4.2), and workspace npm dependencies.
npm run build:native
./dist/bot-web web --host ::1 --port 3001
./dist/bot-web --help
```

`web` is optional. `--backend-url http://[::1]:8787` overrides `BOT_SERVER_URL`; the daemon token remains environment-only. The daemon must be started separately. The runtime's existing `bot` CLI/default flake app is not replaced or coupled to UI dependencies.

The build stages the existing Next application without `app/api`, statically exports its production HTML/client assets, then embeds those assets and a Bun HTTP host with `bun build --compile`. The Bun host and Next route wrappers share **`lib/api.ts`**; streaming and cancellation still use the adapter's public API. It is not a different frontend or a second agent loop. Export staging is isolated under `.build/` and cleaned on success/failure; the normal `.next` build is untouched. No Node, Bun, Next installation, `node_modules`, source checkout or asset directory is needed to run the binary. It works from an unrelated directory with empty `PATH`. Normal native OS libraries still apply; Nix-built ELFs need their Nix shared-library closure rather than being portable to an arbitrary non-Nix host.

Native configuration comes from the invoking process environment. Unlike `next dev`, the native binary deliberately **does not auto-load `.env.local`, `.env`, `bunfig.toml`, package.json or tsconfig.json** from its working directory. Set/export the documented server variables explicitly. They are read at runtime and are not compiled into browser assets. The default is loopback-only `http://[::1]:3001`; the same access-control requirements below apply.

This distribution supports the current static UI plus the shared streaming API. A bare static file host is **not** sufficient: it cannot handle `/api/*`. Future UI features requiring Next's dynamic server rendering, Server Actions, middleware or image optimizer need a deliberate native-host design change, or must use the normal Next server. A failed static export fails the native build rather than silently dropping dynamic behavior. Builds target the current OS/CPU; the flake advertises Linux x86-64 and ARM64 (x86-64 is exercised here). It does not fetch foreign Bun runtimes for cross-compilation.

### Server configuration

Set these in `apps/web/.env.local` for Next development or in the server process environment in production/native deployments:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BOT_SERVER_URL` | `http://[::1]:8787` | Trusted, server-configured daemon HTTP(S) address. No embedded user/password, query string, or fragment. |
| `BOT_SERVER_TOKEN` | unset | Optional daemon bearer token, sent only by the UI server. |
| `BOT_UI_ORIGIN` | incoming loopback origin | Explicit public origin (scheme, host, optional port) behind an authenticated reverse proxy. |

**Never use `NEXT_PUBLIC_` for these values.** Browser code has no backend URL/token or provider credentials. Restart the server after configuration changes. Configure the daemon's own provider authentication separately; do not put provider keys in this application.

Keep the loopback binding unless you add an authenticated reverse proxy or equivalent access control. The UI deliberately does **not** provide user authentication, tenant separation, or a tool-execution sandbox. Anyone able to reach its routes can operate the configured daemon and read that daemon's sessions. A daemon token protects the server-to-daemon hop, not access to this UI. Do not expose an unauthenticated instance publicly. Use HTTPS and authentication when accessing it remotely.

API requests validate the browser's exact `Origin` when present (including scheme/port) and reject cross-site Fetch Metadata. The default Host allowlist is loopback-only, including for Origin-less GETs, to resist DNS rebinding. Next.js's normalized loopback URLs are restored to the incoming browser authority before adapter validation. Origin-less trusted server/CLI requests remain permitted. This is CSRF/Host protection, **not authentication**. Behind an authenticated reverse proxy, explicitly set `BOT_UI_ORIGIN=https://bot.example.com`; preserve the public Host or use a loopback upstream. Untrusted forwarded headers are not used to choose the allowed origin. There are no CORS-enabled mutation routes, browser-selected backend addresses, or browser-selected filesystem workspaces.

## Conversation behavior

- The sidebar reads the daemon's persisted sessions. Selecting one replaces the displayed transcript with canonical history. Refresh the list with its refresh control; **Sync history** reconciles the current desktop conversation. On small screens use the session menu and reselect a session to reload it.
- Text streams through the same-origin server route and AI SDK's standard UI message transport. The browser submits only the newest user message, not a second copy of the transcript. Request identity and its original admission session option are stable for each chat/user-message pair, including a retry after a missing acknowledgement or adapter restart. A newly learned session is used for new turns and reconnects, never to change an earlier turn's retry fingerprint.
- The first accepted `data-bot-run` stores the session in the URL and optional local storage **without remounting `useChat`**. Only conversation/run references are stored locally; transcript persistence belongs to the daemon. A copied `?session=…` URL can reopen it.
- Reload or session selection fetches persisted history, then reattaches if a run is active. Reconnection first replaces optimistic messages with canonical history, then uses the adapter's complete replay and stable assistant IDs. AI SDK 7's `resumeStreamIsReplay` resets streamed parts rather than appending full final text to old deltas; canonical user messages stay in place.
- Accepted run/session IDs and last observed status are saved as browser references (local storage and the selected URL's `run` parameter), never as a second transcript. This lets a reload reattach even when a run is still queued and has no active snapshot generation yet. The daemon validates the run/session pairing and supplies authoritative status.
- Interrupted known sessions are reconciled every five seconds and on the browser's `online` event. **Reconnect** does the same immediately. Reconnection is GET-only: it never starts a new run. If a submission's acknowledgement was lost, the optimistic user turn is kept until canonical history confirms it. **Retry submission** reuses the original user-message/request ID instead of creating another user message, including when a new session ID has not yet arrived.
- **Stop** explicitly posts cancellation for the accepted run and stops the local reader. Until the run ID is accepted it cannot safely cancel an unknown run. A network failure, tab close, navigation, or session change only detaches the observer; accepted work continues on the daemon. Cancellation failures remain observable and the saved state is checked again. EOF alone never implies successful completion.
- Errors/status and the saved transcript are separate: queued/running/completed/failed/cancelled run metadata is shown when known. A reloaded idle session may have no latest-run metadata; its history is still available. New messages are blocked while work or reconciliation is active, avoiding an accidental second tool loop.
- Text-only append requests are supported. Attachments, editing/regeneration, tool approvals and browser tool execution are intentionally not offered by this adapter contract.

### Rendering and accessibility

Markdown supports ordinary headings, lists, links and code blocks. Raw HTML is skipped, unsafe URL schemes are filtered by `react-markdown`, and remote images are not rendered (including tracking pixels). External links use `noopener noreferrer`. User messages and tool inputs/results are escaped text. Tool activity is inert expandable detail; the browser does not execute tools. Reasoning, when the daemon exposes it, is collapsed by default.

The layout adapts to mobile, system light/dark themes and reduced-motion preferences. Controls have accessible names, the transcript has a keyboard-focusable region, navigation identifies the selected session, and connection/run status is announced separately rather than repeatedly announcing every streamed token. The composer supports Enter to send, Shift+Enter for a new line, and IME composition. Auto-scroll stops when you scroll up to read earlier messages.

## Server routes

These uncached routes share the same handler in the Next.js Node host and the native Bun host. The adapter owns bounded parsing, backend validation, canonical projection and streaming; the app owns same-origin guards and client-safe route errors. The native transport also enforces a 1 MiB request-body ceiling.

| Method | Route | Adapter operation |
| --- | --- | --- |
| POST | `/api/chat` | `chat(request)` |
| GET | `/api/chat?sessionId=…&runId=…` | `resume(request, sessionId, runId?)` |
| GET | `/api/sessions` | `{ sessions: await sessions() }` |
| GET | `/api/sessions/:id` | `history(id)` |
| GET | `/api/info` | `info()` |
| POST | `/api/runs/:id/cancel` | `cancel(id)` |

Typed adapter errors retain their documented client-safe messages; unknown server errors never serialize exception bodies, daemon URLs, credentials or stack traces. The app includes frame-embedding, MIME-sniffing, referrer and permissions protections. It does not use a permissive raw-HTML Markdown plugin or enable a second AI SDK tool loop.

## Checks

From the workspace root, after building the adapter:

```sh
npm run check --workspace @nothumanwork/bot-ui
npm run test --workspace @nothumanwork/bot-ui
npm run build --workspace @nothumanwork/bot-ui
npm run test:native --workspace @nothumanwork/bot-ui  # Bun HTTP/CLI tests
```

The deterministic tests cover same-origin mutation guards, bounded path-safe IDs, safe error envelopes, metadata validation, escaped Markdown/tool rendering, accessible sidebar structure, and the **real AI SDK 7 `Chat` + `DefaultChatTransport`** request/retry/replay behavior. Transport tests use in-memory response streams, not a bundled bot or a provider. They verify canonical replay preserves users, replaces assistants without doubled text, and never posts on reconnect.

The workspace-level `npm run test:e2e` exercises the actual Next server and a temporary scripted durable Pi backend in headless Chromium, without a live provider. After `npm run build:native`, `npm run test:native` runs the same acceptance suite against the compiled binary copied to a fresh directory, with empty `PATH` and hostile incidental cwd configuration to verify that it is ignored. Set `BOT_TEST_WEB_BINARY` to test a different prebuilt artifact, including a Nix store executable. Browser tests require that layer's documented browser setup. This app's unit suite does not download browsers or install system dependencies.

## Files and maintenance

- `app/api/**`: thin, same-origin Node adapter routes.
- `lib/backend.ts`: server-only backend configuration and adapter ownership.
- `lib/http.ts`: route security and safe errors.
- `lib/api.ts`: framework-neutral API routing shared by both hosts.
- `native/`: native CLI/server and offline Bun tests; shutdown detaches streams, never cancels daemon runs.
- `scripts/build-native.ts`: isolated static export, asset manifest and single-file compilation.
- `lib/transport.ts`: browser-safe, same-origin SDK transport and stable request identity.
- `lib/recovery.ts`: accepted run references for queued/active recovery across reloads.
- `components/`: session navigation, conversation lifecycle and safe transcript rendering.
- `test/`: deterministic logic, transport and server-rendered UI checks.

Keep the adapter's published API and AI SDK's actual installed types authoritative. Update pinned Next/React/SDK versions together and rerun type checks, production build, deterministic tests and the workspace browser integration before upgrading.
