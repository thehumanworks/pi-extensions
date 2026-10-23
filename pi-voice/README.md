# pi-voice

Experimental realtime, speech-to-speech voice mode for [Pi](https://pi.dev), using
ChatGPT's Codex voice service. This is **not** dictation followed by text-to-speech.

```text
 voice ● listening                         ctrl+x mute   /voice off
   mic ▁▂▄▆▃▂▁▁▁▁   pi ▁▁▁▂▄▇▅▂▁▁
 you › Could you fix the failing test?
  pi › I'll take a look.
```

The compact strip sits above the existing editor, inspired by the Codex CLI
recording in `assets/`. Microphone and speaker meters reflect actual audio
levels. Transcripts animate as they arrive, then become persistent chat entries.
You can still type and use Pi's normal tools and permission dialogs.

## Status and authentication

The service is private/alpha and can change or reject accounts that lack access.
On 2026-10-19 a live connection with a Codex login succeeded for signaling, the
WebRTC data channel, `session.started` and the sideband. Full spoken
conversations and delegation have been tested with mocks only.

**Voice uses the Codex login, the same one Codex CLI uses.** In Pi that is
provider **`openai-codex`**, labeled **OpenAI (ChatGPT Plus/Pro)** or "OpenAI
Codex (legacy)". Sign in with `/login openai-codex`. Pi owns token refresh and
storage. pi-voice reads the credential through Pi's model registry and does not
read Codex CLI's `~/.codex/auth.json`.

Pi's newer **OpenAI (ChatGPT subscription)** login (provider `openai`) does
**not** work for voice. It issues a token for the public OpenAI API, and the
voice backend rejects it with HTTP 401, even on accounts that have voice
access. pi-voice never falls back to it, to API keys or to environment
variables. You can keep both logins: `openai` for text models and
`openai-codex` for voice.

## Try it

Requires Pi 1.3.0+, Node.js 22.19+, and default local microphone/speaker devices.

```bash
cd /path/to/pi-voice
npm install
pi --extension ./index.ts
```

Or install the local package for future sessions:

```bash
pi install /absolute/path/to/pi-voice
```

Then, inside Pi:

1. Run `/login openai-codex` (**OpenAI (ChatGPT Plus/Pro)**) once. If Codex CLI is
   in the middle of its own login, finish or cancel it first: both use port 1455.
2. Run `/voice on`.
3. Allow microphone access for your terminal/Pi if your operating system asks.
4. Speak normally. Use headphones for reliable interruptions.
5. Press **Ctrl+X** to mute/unmute the microphone.
6. Run `/voice off` to release audio devices and close the call.

The extension does not change the current coding model. ChatGPT provides the
voice conversation; the selected Pi coding model still does repository work.

## Commands and settings

| Command | Action |
|---|---|
| `/voice on` | Connect; start microphone transmission only after the call is ready |
| `/voice off` | Stop capture, playback and signaling; restore normal key behavior |
| `/voice mute` | Toggle microphone mute without stopping playback |
| `/voice status` or `/voice` | Show state, voice and mute key |
| `/voice key f9` | Persist a different mute shortcut; applies immediately |
| `/voice voice cove` | Persist a voice; applies on the next connection |

Voices: `arbor`, `breeze`, `cove`, `ember`, `juniper`, `maple`, `sol`
(default), `spruce`, `vale`. Availability is controlled by the voice service.

Settings live in `<Pi agent directory>/voice.json` (normally
`~/.pi/agent/voice.json`):

```json
{
  "muteKey": "ctrl+x",
  "voice": "sol"
}
```

Use `/voice key <shortcut>`, rather than Pi's `keybindings.json`: this binding
is scoped to an active voice call. **While voice is on, the configured key is
intercepted globally, including in dialogs.** Ctrl+X's normal copy action is
restored on exit. Modified shortcuts and F1–F12 are accepted; Ctrl+C, Ctrl+D and
Ctrl+Z are reserved so exit/suspend controls remain available. Kitty key-up and
auto-repeat events do not toggle mute again.

Voice is terminal-only; RPC/JSON/print invocations do not open audio devices.
Reload, session replacement, forking and tree navigation stop the call. Ending
voice does not abort ongoing Pi work. Voice never starts automatically.

## How work happens

```text
microphone ── WebRTC/Opus ──► ChatGPT realtime voice model
speaker    ◄─ WebRTC/Opus ──┘            │
                              delegation.created
                                       ▼
                          current Pi session / coding model
                          normal tools, extensions, permissions
                                       │
                         silent progress + settled final result
                                       ▼
                             voice model speaks the result
```

The voice model is the conversational surface, **not a second tool executor**.
It handles conversation and delegates coding/investigation to the existing Pi
agent. A delegation starts a run or steers a running one; it does not spawn a
subagent. There is no duplicate coding turn for a transcript.

Final voice transcripts are visible custom session entries, including interrupted
partial turns on shutdown. They are not injected as independent user instructions.
Recent transcript context accompanies each delegated task. Pi's ordinary written
coding responses remain in chat as well as the spoken paraphrase.

See [architecture and source references](docs/architecture.md).

## Audio, privacy and limitations

- Media uses the native WebRTC/audio implementation from
  `@oh-my-pi/pi-natives`, pinned to a known version. No browser, ffmpeg, SoX,
  public OpenAI API key, or separate transcription/TTS service is needed.
- Native audio binaries are optional platform dependencies. Do **not** omit
  optional dependencies. If the load error reports a missing package, run
  `npm install --include=optional` in the pi-voice installation directory.
  Other load failures include the underlying error; reinstalling optional
  dependencies will not fix every runtime or binary compatibility problem.
  The loader supports both Node and Pi's compiled Bun runtime.
- macOS (arm64/x64), Linux (arm64/x64), and Windows (arm64/x64) have upstream
  binaries. Only binary loading on macOS arm64 has been smoke-tested here.
  Linux also needs a functioning system audio server/device backend.
- Audio is transmitted to OpenAI while the microphone is unmuted. Muting stops
  transmission and discards partial native input, but keeps the local capture
  device open for quick unmute. `/voice off` releases it.
- No audio is recorded to disk by this extension. **Transcripts are stored in
  the Pi session**, like written chat. Treat the session as sensitive.
- The native peer has no acoustic echo cancellation. A simple level gate suppresses
  quiet speaker leakage; **headphones are recommended** for barge-in.
  Server-side VAD and interruptions control speech turns.
- Speech context is bounded; long final answers are abbreviated and refer the
  listener to the written chat. Full coding output stays in Pi.
- Unexpected connection loss ends the call cleanly. Restart with `/voice on`;
  automatic in-call reconnection is not implemented.
- Auth refresh uses Pi's own registry and locking. Tokens, SDP, raw provider error
  bodies and audio are not logged. The same authenticated headers are used for
  signaling and the sideband. There is no device attestation integration.
- The Codex-compatible `originator`/alpha headers and private backend protocol
  are not an official supported third-party ChatGPT voice API.

## Development and validation

```bash
npm install --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

Tests use fake audio and a local WebSocket server: authentication gating,
protocol payloads/UTF-8 limits, finalization, delegation/steering, stale-settlement
races, mute/Kitty events, startup cancellation, shutdown, Unicode/narrow rendering,
and persisted configuration. They do not access credentials or audio hardware.

For live acceptance testing, use an account that can access the backend and
verify: greeting → streaming transcription → delegated repository task → spoken
settled result → barge-in → mute/unmute → off during connection → reload/quit.
A successful live call and acoustic behavior are still required before treating
this as production-ready.
