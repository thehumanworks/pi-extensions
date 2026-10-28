# Handover: pi-bot server + desktop app

Working notes for whoever picks this up. Not part of the npm package. Delete before publishing.

---

# Objective and outcomes

`pi-bot` (this package) manages persistent Pi agents ("bots"). This work adds two things on top of the existing CLI extension:

1. **A backend daemon** (`src/server/`) that exposes bots over an OpenAPI 3.1.0 HTTP API, so any client can use them. Done and tested.
2. **A desktop app** (`desktop/`, Rust, gpui-kit) that talks only to that API. Done, tested in a real window and headless, with a short list of open items below.

The user's purpose: work with bots visually, with the UI fully decoupled from the backend, reproducible with Nix, usable from WSL, Windows and macOS. Code must be written for the reader: other agents maintain it.

**New requirement from the user (not started):** multiple conversations per bot are fine, but the bot must stay aware of all of them. Like a person, it should remember other chats, not just the one it is in. Use compaction and memory to give that continuity. See "Continuity across conversations" under Requirements.

# Context and inputs

## Repository
- Monorepo `/home/nixos/pi-extensions` (npm workspaces). This package is `pi-bot/`.
- Everything here is **uncommitted**. New: `src/server/`, `bin/`, `desktop/`, `flake.nix`, `flake.lock`, `package-lock.json`, `openapi.json`, `tsconfig.build.json`, `test/server.test.ts`, `test/transcript.test.ts`, `test/fixtures/fake-pi-rpc.mjs`, `research/` (scratch, never commit: contains `*:Zone.Identifier` files). Modified: `package.json`, `src/models.ts`, `README.md`, root `README.md`, root `scripts/packages.test.mjs`. `pi-loop/dist/scheduler.d.ts` shows as modified but is unrelated build output: leave it.
- Do not commit, `git add`, push, publish or `npm login` unless the user asks. Never touch the real bot at `~/.pi/agent/bots/management-partner`.

## Backend (TypeScript, `src/server/`)
- `main.ts` CLI (`--host`, `--port`, `--pi`, `--cwd`, `--idle`; env `PI_BOT_SERVER_HOST/PORT`, `PI_BOT_PI_COMMAND`), `http.ts` routes, `conversations.ts` (`ConversationHub`: one long-lived `pi --mode rpc` child per conversation, event log, SSE), `pi-rpc.ts` (JSONL client), `transcript.ts`, `errors.ts`, `openapi.ts` (hand-written spec, exported to `openapi.json` at build).
- Conversation id = Pi session id, chosen by the client. Sessions live in `<bot home>/sessions/*.jsonl`.
- The system prompt per conversation comes from `src/prompt.ts` (`botSections`): identity, home layout, `MEMORY.md` excerpt (first 200 lines / 25 KB), open `tasks/`, latest `journal/` entry. Other conversations are **not** mentioned to the bot today; that is the continuity gap.
- Pi 1.4.0 has built-in compaction (`dist/core/compaction/`, `agent-session.js`); the hub already sees `compaction_start` events (`conversations.ts:231`).

## Desktop (Rust, `desktop/`)
- Cargo workspace, crates: `pi-bot-api` (HTTP client + SSE iterator + types mirroring `openapi.json`), `pi-bot-bots` (roster, sidebar, editor sheet), `pi-bot-conversation` (transcript model, list, view), `pi-bot-desktop` (app: `Workspace`, `main.rs`, integration tests in `crates/app/tests/`).
- gpui-kit pinned `0.8.1`; HTTP via blocking `ureq` on `cx.background_spawn`; no tokio, no `futures`.
- Build and test only through the toolchain shell: `cd desktop && nix develop /tmp/gpui-probe --max-jobs auto -c cargo <cmd>`. (`/tmp/gpui-probe` is a scratch devshell; if it is gone, `nix develop path:$PWD` from `pi-bot/` provides the same tools.)
- Integration tests use a fake HTTP server on `[::1]:0` and wall-clock polling (`wait_until`), because real sockets do not advance GPUI's test clock. Enter inside a sheet does not reach the input in the headless harness, so the validation test clicks `save-bot`; the real window handles Enter.

## Verified state (2026-10-27, end of session)
- `cargo fmt --check`, `cargo test --workspace`, `cargo clippy --workspace --all-targets`, `cargo build`: all clean.
- pi-bot `npm run check`: clean. `npm test --workspace @nothumanwork/pi-bot`: 63/63. Root `npm run test:scripts`: 15/15.
- Root `npm run check` and `npm run pack:check` fail in **`pi-xai`** (`src/video.ts(81,47)` implicit any). That package is untouched by this work and fails on the committed tree too. Not ours to fix unless asked.
- `nix build path:$PWD#server` works; output verified serving `/health`, `/bots`, `/models`.
- `nix build path:$PWD#desktop` succeeded once on an older snapshot; a rebuild on the final source was started in the background (`/tmp/nix-desktop-build2.log`, result symlink `/tmp/pibot-desktop-result`). Check the log; if the machine was rebooted, rerun it.
- Real-window E2E in WSLg against a real server and model `xai/grok-4.7`: list bots, send a message, streamed reply with a tool row, create/edit/archive bot via sheet and alert dialogs, validation errors, Escape closing overlays, server killed mid-stream (shows an error and Retry; reconnect path then revised, see below), new bot auto-selected after creation.

## Running it locally
```sh
# server (isolated Pi dir with a test bot "tbot"; recreate if /tmp was cleared)
cd pi-bot && npm run build
PI_CODING_AGENT_DIR=/tmp/pibot-agent.XyRm PI_BOT_HOME=/tmp/pibot-agent.XyRm/bots \
PI_BOT_PI_COMMAND=/nix/store/isaxx2q4ka0ra8fs0fdq337431slzd37-pi-coding-agent-1.4.0/bin/pi \
node bin/pi-bot-server.mjs --host 127.0.0.2 --port 7733 --cwd /tmp

# app (X11 so xdotool can drive it)
cd desktop && nix develop /tmp/gpui-probe -c sh -c 'WAYLAND_DISPLAY= ./target/debug/pi-bot-desktop --server http://127.0.0.2:7733'
```
- `127.0.0.2:7733` is bridged to Windows by the user's `wsl-loopback` tool (`wsl-loopback status 7733`); Windows reaches `http://[::1]:7733`. Plain `127.0.0.1` TCP loopback does not answer on this WSL instance; tests bind `[::1]`.
- Screenshots: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\RodaT\AppData\Local\Temp\winshot.ps1' -Title 'pi-bot*' -Out 'C:\Users\RodaT\AppData\Local\Temp\NAME.png'`, then read `/mnt/c/Users/RodaT/AppData/Local/Temp/NAME.png`.
- The bash hook blocks commands whose text contains `rm -rf $VAR`, or words like `Delete`, `Trash`, `Remove-` (even inside grep patterns). Avoid those words in command text.

# Requirements and priorities

## Non-negotiables (from the user and the invoked skills)
- UI and backend stay decoupled; the app talks only to the HTTP API described by `openapi.json`. Keep `desktop/crates/api/src/types.rs` in sync with the spec.
- gpui-kit rules: never invent an API (check the crate source under `~/.cargo/registry/src/*/gpui-{kit,component,base}-0.8.1/`); single dependency `gpui-kit`; theme tokens and rem helpers only, no raw colours or `px()` except hairlines; `Button` for in-app commands; stable, domain-derived `ElementId`s (helper `keyed(prefix, key)`); no `pub` fields across crate seams; all interaction states visible; Escape dismisses the topmost overlay and returns focus; copy names the object and the verb.
- The design guide (`~/.pi/agent/skills/gpui-kit-design-guides/references/design-guides.md`) is a requirement. Its **Design review checklist** and **Accessibility checklist** have not been run yet; run both against the real window and the code, and fix findings.
- End-to-end testing with real models is allowed with the user's accounts: `openai/gpt-6.1-sol` and `xai/grok-4.7`.
- Write for the reader: small, named functions; comments say why; tests describe behaviour.

## Continuity across conversations (new, to design and build)
Goal: a bot behaves like one person with one memory, even though the API exposes many conversations. Requirements as stated by the user: use **compaction and memory** so the bot remembers other chats, not just the current one.

Delegated to the executor: the mechanism. Constraints and pointers:
- Build on what exists: `MEMORY.md` + `memory/` (durable facts), `tasks/` (long work), `journal/` (append-only session log), Pi's compaction. Do not invent a second memory system.
- Likely shape (a proposal, not a decision): when a conversation settles or is compacted, distil it into the bot's home (journal entry and, where warranted, memory files), and inject into every new turn's system prompt a short digest of the bot's other recent conversations (for example the last N journal entries or one-line summaries of the other sessions in `sessions/`, with ids so the bot can read them). Keep the injected size bounded like the existing `MEMORY.md` excerpt. Decide whether the server writes the digest (deterministic, cheap) or asks the model to summarise (better quality, costs tokens); say which and why.
- Expose it in the API (so every client benefits), not in the desktop app alone. Add it to `openapi.ts` and the Rust types if the UI shows it.
- Acceptance: with two conversations A and B on one bot, a fact established in A is used correctly in B without being restated, and a `GET` on the bot or its conversations shows the digest the bot was given. Cover it with a server test using `test/fixtures/fake-pi-rpc.mjs` and one real-model E2E run.
- Industry alignment ideas noted earlier but not decided: `instructions.md` next to `BOT.md`, `schedules/*.md` with `cron:`, an activity view, evals. Raise them with the user before building any of them.

## Open items, in order
1. **Reconnect behaviour (just changed, needs a real-window check).** `ConversationView::load` now retries every 2 s while `Connection::Reconnecting` instead of dropping to `Failed` when the server goes away after a successful load; `Error::Transport` now displays as `Could not reach the server: <io error>.`; the lost-connection notice is `"{error} Reconnecting…"`. Verify by killing and restarting the server with a conversation open: the view should show the notice, keep the transcript, and recover without clicking Retry. Update the README sentence about reconnecting if the wording changed.
2. **Nix desktop build on final source:** check `/tmp/nix-desktop-build2.log`; run `/tmp/pibot-desktop-result/bin/pi-bot-desktop --server http://127.0.0.2:7733` under WSLg once.
3. **Design review checklist and Accessibility checklist** (see above). Known candidates: icon-only buttons already carry labels; check focus order through sidebar → list → composer, contrast of the muted model/thinking tags, keyboard path to `Delete conversation …` buttons, and that `Tab` from the composer does not get trapped.
4. **Windows build of the app** is undecided: no Rust toolchain on Windows and `gpui-pre-windows` needs `GPUI_FXC_PATH`. The README documents running the app on Windows against the WSL server only. Ask the user whether a Windows build is in scope.
5. **Continuity across conversations** (section above). Larger; agree the design with the user first if anything above is unclear, otherwise build the proposal.
6. Final sweep: `cargo fmt --check && cargo clippy --workspace --all-targets && cargo test --workspace`; `npm run check`, `npm test`, `npm run test:scripts` from the root (pi-xai failure is pre-existing); summarise for the user what to commit; stop the background server (`pgrep -f pi-bot-server.mjs`) and app (`pkill -x pi-bot-desktop`); ask before `wsl-loopback disable 7733`.

# Acceptance and evidence
- Rust: fmt, clippy and tests clean, and the five integration tests in `desktop/crates/app/tests/workspace.rs` pass.
- TypeScript: `npm run check`, `npm test` (63) and root `npm run test:scripts` (15) pass.
- `nix build path:$PWD#server` and `#desktop` produce runnable binaries.
- Every UI change is exercised in a real WSLg window with a screenshot read back, not only headless.
- For the continuity work: the two-conversation test above passes with the fake Pi and once with a real model, and the README explains what the bot is told about other conversations.

# Working guidance
- Act within the constraints without re-asking settled questions; the decisions above are the user's. Ask only when a choice changes the deliverable (Windows build, continuity design if the proposal does not fit).
- Keep `README.md` (this package, sections "Server", "Desktop app", "Windows with the server in WSL", "Nix", "Develop") current with any behaviour change.
- When regenerating `package-lock.json` (`npm run lock`), update `npmDepsHash` in `flake.nix` with `nix run nixpkgs#prefetch-npm-deps -- package-lock.json`.

# Delivery
- Code in place, uncommitted, with a final message to the user listing: what changed, what was verified and how, what is left, and the exact file list to commit (excluding `research/` and `HANDOVER.md`).
