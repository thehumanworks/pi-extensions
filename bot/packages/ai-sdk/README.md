# @nothumanwork/bot-ai-sdk

A framework-independent, server-side AI SDK 7 UI message stream adapter for a durable bot backend. Use the bot daemon's existing `/v1` API with `useChat`, or inject a structurally compatible backend. There is **no bot runtime, Pi, React or Next dependency**, no provider configuration, no second agent loop and no Vercel hosting requirement. The backend remains responsible for execution, tools, sessions and durable history.

Requires Node **22.19+** and peer `ai ^7.0.155`. Development and tests use **ai 7.0.155's actual types and stream consumer**, including its supported `reset-step` and complete replay behavior.

See [API.md](./API.md) for the route/browser integration contract and complete public type names.

## Server integration

```ts
import { connectBotBackend, createBotChatAdapter } from '@nothumanwork/bot-ai-sdk/server';

// Server configuration, never values from a browser request.
const backend = connectBotBackend(process.env.BOT_SERVER_URL ?? 'http://[::1]:8787', {
  token: process.env.BOT_SERVER_TOKEN,
});
const adapter = createBotChatAdapter({ backend });

// Framework-neutral Request -> Response handler:
export function POST(request: Request) {
  return adapter.chat(request);
}
export function GET(request: Request) {
  const url = new URL(request.url);
  return adapter.resume(request, url.searchParams.get('sessionId') ?? '',
    url.searchParams.get('runId') ?? undefined);
}
```

Keep the adapter instance on the server; each stream is an observer, not an execution owner. The adapter does not close an injected backend. It does not instantiate a runtime, open persistence files or run tools locally.

The HTTP client uses only implemented daemon endpoints: `GET /v1/info`, `GET /v1/sessions`, `POST /v1/runs`, `GET /v1/runs/:id`, `POST /v1/runs/:id/cancel`, and the session NDJSON watch `GET /v1/sessions/:id/stream`. The optional submit observer negotiates the existing run NDJSON endpoint using `Accept: application/x-ndjson`. There is no invented `/history` endpoint. A session history read obtains the watch's atomic initial snapshot and immediately unsubscribes.

## Browser integration (no React import in this package)

In the UI's React component, install/use the separate `@ai-sdk/react` package:

```ts
import { DefaultChatTransport } from 'ai';
import type { BotUIMessage } from '@nothumanwork/bot-ai-sdk';

const admissionSessions = new Map<string, string | undefined>();
const transport = new DefaultChatTransport<BotUIMessage>({
  api: '/api/chat',
  resumeStreamIsReplay: true,
  prepareSendMessagesRequest: ({ id, messages }) => {
    const newest = messages.at(-1)!;
    const requestId = `${id}:${newest.id}`;
    if (!admissionSessions.has(requestId)) {
      if (admissionSessions.size >= 1024) admissionSessions.delete(admissionSessions.keys().next().value!);
      admissionSessions.set(requestId, sessionRef.current);
    }
    return { body: {
      id, messages: [newest], requestId,
      // Freeze this per turn: learning the accepted session must not change a retry.
      sessionId: admissionSessions.get(requestId),
    } };
  },
  prepareReconnectToStreamRequest: () => ({
    api: `/api/chat?sessionId=${encodeURIComponent(sessionRef.current!)}&runId=${encodeURIComponent(runRef.current!)}`,
  }),
});
// useChat<BotUIMessage>({ transport, onData(part) { ... } })
```

On `data-bot-run`, store `{sessionId,runId,status}`. Update session URL/storage without changing the `useChat` component key/remounting the chat during an accepted stream. Load `adapter.history(sessionId)` when selecting a session or reloading; its messages include completed text, reasoning and inert tool data. Resume replays the canonical **latest assistant turn**, not the entire conversation or a byte offset. With `resumeStreamIsReplay:true`, AI SDK replaces its stable-ID assistant message instead of duplicating already-rendered text. Older turns come from `history`. A supplied `runId` is validated against the selected session and used for run status/completion; it does not request edits/regeneration. When a terminal run has output, its exact final assistant text and canonical message timestamps identify its replay, rather than matching a suffix of a later answer. A custom backend that omits timestamps and supplies multiple identical candidate answers cannot establish an older run's identity from the existing protocol; this is reported as transcript unavailable instead of silently replaying the wrong turn. Full canonical `history` remains available.

Do not submit the browser transcript to the bot as a prompt: the adapter extracts only the final user message's text. Do not configure automatic tool-result submission, `sendAutomaticallyWhen`, browser tool execution or a second agent loop. Backend tool parts are `data-bot-tool`, intentionally **not** executable AI SDK tool calls. Render tool input/output as escaped text. Markdown rendering belongs in the UI; do not enable raw HTML for backend text.

### Stream parts

* `text-*` and `reasoning-*`: incremental assistant content. Full starts/ends, coalesced updates, missing tails, retries and snapshot replacement are reconciled against canonical message content. A final full message is never blindly appended over existing deltas. AI SDK 7 `reset-step` replaces the current turn's parts when a retry/correction is not append-only.
* `data-bot-run`: transient `{runId,sessionId,status}`, sent immediately after admission and on observed status transitions. Status is `queued`, `running`, `completed`, `failed` or `cancelled`. `onData` receives this even before text exists.
* `data-bot-tool`: durable display part with stable data ID, `{toolCallId,toolName,state,input?,output?,parentToolCallId?}`. State `running | completed | failed`. Partial tool progress uses replacement semantics, not duplicate tool calls. Nested IDs are opaque; they may contain `/` and must not be parsed as resource paths.
* `data-bot-progress`: transient safe `{type,attempt?}` for retry/compaction/deferred notices, without raw provider errors.
* `data-bot-usage`: transient numeric `{input,output,cacheRead,cacheWrite,cost,turns}`.

One UI assistant message contains all assistant generations/tools after one durable user entry, with a stable ID based on the session and entry identity. Each generation/block has a stable text part ID. A backend snapshot can contain both completed entries and an in-flight generation. Compaction summaries are not exposed as extra user prompts.

A completed run emits `finish`; cancelled runs emit `abort`; failed runs and stream loss emit a client-safe `error`, **not a successful finish**. A background `getRun` check covers structural backends without `run_settled`. Terminal completion reads a fresh snapshot to avoid losing a final tail when a poll outruns watch delivery. Late events from another run/session are not attached to the selected run.

## Cancellation, retries and durability

**Explicit Stop:** call your authenticated same-origin cancellation route (`await adapter.cancel(runId)`) and stop the local stream reader. Reader cancellation alone is not a Stop request. Request abort, network disconnect, session selection and unmount only detach observers. They never cancel admitted backend work. Cancellation errors are not success acknowledgements; inspect the run before retrying.

**Acceptance retries:** a stable request ID defaults to a hash of chat ID + final user message ID. The backend's durable request-ID deduplication is authoritative. The adapter additionally bounds an in-memory cache to 1,024 correlation records (hashes, original session option and a promise of accepted run/session IDs only; no browser transcript or retained run output), covering concurrent acceptance retries and explicit request ID changes for the same UI user message. Reusing a UI message/request ID for changed text/session fails with 409. Admission scope is immutable: a retry keeps an originally omitted `sessionId` omitted even after acceptance reveals the new session ID. The maintained UI freezes this option per user turn, while genuinely new turns use the live session. This rule is the same with a warm or cold adapter; changing scope is rejected in both cases. The cache is not a durable transcript or replacement for backend deduplication. Across server restarts, retry ambiguous admission with the **same original message, session option and request ID**, or reconnect with known run/session IDs. Never turn reconnection into a new chat submission.

**History/reconnect:** history is a read-only snapshot and never submits, cancels, opens or takes over execution. It returns `{messages,session,run?}`; `run` is present when the backend snapshot identifies the active run. Historical session-only snapshots need not contain terminal run IDs. Stream interruption must be surfaced as disconnected/unknown in the UI; do not claim success because a socket closed.

## Structural injection

```ts
import type { BotBackend } from '@nothumanwork/bot-ai-sdk';

const backend: BotBackend = {
  info, submit, getRun, listSessions, watch, cancel,
};
```

`submit(text,{session?,requestId?,onEvent?})` returns acceptance, not completion. `watch(sessionId,listener,{onError?}?)` returns `Promise<() => Promise<void>>` and supplies an initial `snapshot` atomically with live subscription. The third argument is optional; the runtime's existing two-argument watch is structurally compatible. Each event is `{type,sessionId?,runId?,data?}`. Snapshot data has `entries` (`id`, `kind`, `model`), optional `generation.message`, live `tools`/`nestedTools`, and optional `run`. Entry model messages use the backend's public user/assistant/tool-result message shapes. Custom backends must report watch failure via `onError` or an error event, or provide run IDs for authoritative status polling; a silent observer cannot distinguish idle work from a broken transport.

The remote client implements safe EOF reporting. Callers using its optional `submit(...,{onEvent})` receive an `adapter_stream_error` event on premature run-stream loss; disconnect never cancels the run. The adapter itself uses bounded JSON acceptance plus a canonical session watch rather than persisting duplicate browser history.

## Input and security boundaries

* Only standard POST JSON `{id,messages,sessionId?,requestId?,trigger?,messageId?}` is accepted. An optional trigger must be `submit-message`; optional messageId must name the final user message. Empty text, attachments, tool submissions/approvals, edits, regeneration and unknown fields fail explicitly. Old browser messages are shape-checked but are not authoritative history.
* Resource IDs are non-empty, at most 256 characters, contain no slash, backslash, ASCII whitespace/control characters, and cannot be `.`/`..`/`new`/`last`. Malformed/cross-session run IDs are rejected. Request correlation IDs are at most 1,024 UTF-8 bytes without control characters.
* Backend URL/token are trusted server configuration. URL must use HTTP(S) without embedded credentials/query/fragment; redirects are disabled. Do not let browser input select backend URLs, cwd/source/state paths or workspaces.
* `chat` enforces same Origin for browser mutations; missing Origin is permitted for trusted server/test clients. Cancellation route wrappers must perform the same check and application authentication/authorization. This package is **not** a multi-tenant authorization layer.
* Backend HTTP response bodies, network exception strings, provider retry errors, raw run errors, source paths and diagnostics are not used in client-facing **errors**. `info` projects display capabilities without source paths. Session cwd is retained because it is part of the structural public session type. Transcript/tool output remains application data; render it safely and control access to it.
* `chat`/`resume` return safe JSON `{error:{code,message}}` before streaming. Other methods throw exported `BotAdapterError` with safe `.status/.code/.message`. Do not serialize arbitrary framework exceptions from route wrappers.

### Fixed resource limits

Exported `LIMITS` is frozen: 1 MiB request JSON, 100,000 user text characters, 1,000 browser messages, 1,024 parts/changes per message/event, 10,000 durable entries, 8 MiB JSON responses/snapshot/event data and retained canonical transcript, 1 MiB outgoing buffered chunk data, 15-second snapshot/subscription acquisition deadline, 30-second ordinary HTTP/admission/body-read timeout, and 250 ms fallback status checks. UTF-8 decoding is strict. Unterminated final NDJSON lines are accepted; malformed, oversized, invalid-UTF-8 or cross-session lines are not. Slow readers fail with a safe reconnect error instead of unbounded buffering. Oversized history is an explicit error, never a silently truncated conversation.

## Development

From this package, after the coordinating workspace installation:

```sh
npm run check
npm run build
npm test
```

Tests use deterministic structural backends, controlled web streams, mock clocks for timeouts, and AI SDK 7's real `DefaultChatTransport` and `readUIMessageStream`; no live model/provider calls, Vercel account, runtime import or global installation is needed. They cover acceptance/deduplication, canonical history/replay, coalesced and whole-message changes, tools/nesting, retries/reset, terminal polling, cancellation/disconnect separation, malformed/oversized inputs/NDJSON, stream loss and secret-safe errors.
