# Architecture and upstream research

## Why two model surfaces?

Both investigated projects use a realtime conversational model plus their normal
coding agent. The speech model handles audio, turn-taking and conversation.
A server-created client delegation hands execution to the main coding session.
This does **not** require spawning a subagent.

pi-voice follows that division:

- `src/auth.ts`: resolve only the `openai-codex` OAuth credential through Pi's
  model registry. Pi owns refresh, locking and persistence. This is the Codex
  OAuth client (`app_EMoamEEZ73f0CkXaXp7hrann`) that Codex CLI also uses; its
  access token carries the `chatgpt_account_id` claim the backend requires.
- `src/native.ts`: lazy N-API binding for microphone PCM and native WebRTC/Opus
  playback. Resolve the native platform package relative to its parent package,
  including nested dependency installs. Bypass the upstream Bun-only JS loader
  under Node without editing dependencies.
- `src/transport.ts`: HTTP SDP signaling and authenticated control WebSocket.
- `src/protocol.ts`: strict parsing, call-ID validation, UTF-8 context chunking.
- `src/dictation.ts`: push-to-talk fallback when WebRTC media is blocked. Buffers
  16 kHz PCM only while recording, uploads one WAV to ChatGPT's
  `backend-api/transcribe` with the Codex ChatGPT login, and returns the text
  for the editor. Modeled on oh-my-pi's buffered cloud STT capture
  (`packages/coding-agent/src/stt`), which uses the public API with an API key.
- `src/session.ts`: capture, mute, echo gate, transcript turns and delegation
  lifecycle. A delegation must be consumed by Pi before a settlement can finish
  it; a pending request cannot accidentally consume an older run's final.
- `index.ts`: Pi commands, scoped raw key listener, persisted transcript entries,
  delegation messages and normal Pi lifecycle events.
- `src/ui.ts`: non-modal above-editor widget with real level histories and
  grapheme-safe animated transcript text. It does not replace the user's editor.

### Persistence and model context

Each finalized voice turn is a `voice-transcript` custom entry, rendered as
`you ›` or `pi ›`. Entries do not become user messages to the coding model.
The most recent 12 transcript entries (up to 12,000 characters) are quoted in the
delegation message. The complete delegated request is the sole new task.

Delegations use hidden custom messages with `triggerTurn: true, deliverAs: steer`.
An idle run attaches the delegation at `before_agent_start`; a steering message
attaches at `message_start`. Tool-use text is silent commentary. Only
`agent_settled` supplies a speakable final, so retries, compaction and queued
continuations do not prematurely announce success. Aborted/error runs are
reported as such. Long outputs are bounded before 500-byte wire chunking.

## Wire contract

This is Codex **Frameless Bidi v3**, not the public Realtime API's WebSocket
`session.update`/`response.create` protocol.

1. Create a native WebRTC offer and data channel named `oai-events`.
2. POST JSON `{sdp, session}` to
   `https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`.
3. Session: model `gpt-live-1-codex`, instructions,
   `audio.output.voice`, `delegation: {type: "client"}`.
4. Headers: Codex OAuth bearer, `ChatGPT-Account-ID` from the JWT claim,
   `OpenAI-Alpha: quicksilver=v2`, `originator: codex_cli_rs`, and session IDs.
   On HTTP 401 the credential is re-read through Pi once, and signaling is retried
   only if the token changed (as with Codex's unauthorized recovery).
5. Apply the plain SDP answer; obtain the call ID from `Location`.
6. Connect `wss://api.openai.com/v1/live/{call_id}` with the same auth headers.
   Connection retries are bounded. Media is native RTP/Opus, not WebSocket PCM.
7. Consume `input_transcript.added`, `output_transcript.added`, `turn.done`,
   `delegation.created`, and service errors. The native track plays audio;
   `output_audio.delta` is ignored to prevent double playback.
8. Send `delegation.context.append` with the delegation ID and
   `channel: commentary | speakable`, each text part at most 500 UTF-8 bytes.
9. Send `session.close` and release microphone, peer, speaker, socket, timers and
   listeners on off/failure/session teardown.

The protocol is private. Pi's newer `openai` provider (Sign in with ChatGPT) uses a
dynamically registered client with `chatgpt.tokens.use.direct` scope for the
public `api.openai.com` Responses API. Its token has no account claim, and this
backend rejects it with HTTP 401 `rejected_by_access_enforcement`
(`no_matching_rule`). That was observed live on 2026-10-19, so it is never used.
With a Codex OAuth token, the same request passed authorization, and the full
transport connected: signaling, data channel, `session.started` and sideband.

Codex additionally sends `x-oai-attestation` when its host (Codex Desktop)
provides an attestation provider; Codex CLI does not require it, and pi-voice
does not send it.

## Pinned research sources

Inspected revisions (not floating assumptions about today's public Realtime API):

### openai/codex — 8c076942cb70fba8e5c4732c23f1faabc4aed484

- [Core conversation orchestration, handoffs and speech limits](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/core/src/realtime_conversation.rs)
- [Call signaling](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/codex-api/src/endpoint/realtime_call.rs)
- [Native voice host](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/voice-host/README.md)
- [Voice strip](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/tui/src/bottom_pane/voice_strip.rs)
- [Animated transcripts](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/tui/src/chatwidget/realtime_split_flap.rs)
- [Voice instructions](https://github.com/openai/codex/blob/8c076942cb70fba8e5c4732c23f1faabc4aed484/codex-rs/prompts/templates/realtime/backend_prompt.md)

### can1357/oh-my-pi — 4a05cbf9f80313e61af17ec98e1bfb97d6fb093d

- [Transport](https://github.com/can1357/oh-my-pi/blob/4a05cbf9f80313e61af17ec98e1bfb97d6fb093d/packages/coding-agent/src/live/transport.ts)
- [Wire protocol](https://github.com/can1357/oh-my-pi/blob/4a05cbf9f80313e61af17ec98e1bfb97d6fb093d/packages/coding-agent/src/live/protocol.ts)
- [Conversation/coding controller](https://github.com/can1357/oh-my-pi/blob/4a05cbf9f80313e61af17ec98e1bfb97d6fb093d/packages/coding-agent/src/live/controller.ts)
- [Native WebRTC implementation](https://github.com/can1357/oh-my-pi/blob/4a05cbf9f80313e61af17ec98e1bfb97d6fb093d/crates/pi-voice/src/live.rs)
- [Live UI](https://github.com/can1357/oh-my-pi/blob/4a05cbf9f80313e61af17ec98e1bfb97d6fb093d/packages/tui/src/apps/live-visualizer.ts)
- [STT controller](https://github.com/can1357/oh-my-pi/blob/0e100b52b6a9eea30353666e085adae0407c8e1e/packages/coding-agent/src/stt/stt-controller.ts) (at 0e100b5)

Differences from upstream are deliberate: Pi's public extension APIs instead of
internal AgentSession hooks, Ctrl+X rather than F9/Space, the original editor is
preserved, no DeviceCheck token, no echo-cancellation DSP, and no automatic
sideband reconnection.
