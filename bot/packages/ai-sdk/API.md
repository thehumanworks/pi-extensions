# Public integration API

The root and `/server` exports are identical. These are server-side APIs; do not ship a backend bearer token to a browser. No runtime, Pi, React, Next, provider or Vercel dependency.

```ts
import {
  connectBotBackend, createBotChatAdapter,
  type BotBackend, type BotChatAdapter, type BotUIMessage,
  type BotRun, type BotSession, type BotInfoSummary,
} from '@nothumanwork/bot-ai-sdk';

const backend = connectBotBackend(process.env.BOT_SERVER_URL ?? 'http://[::1]:8787', {
  token: process.env.BOT_SERVER_TOKEN,
});
const adapter = createBotChatAdapter({ backend });

adapter.chat(request: Request): Promise<Response>;
adapter.resume(request: Request, sessionId: string, runId?: string): Promise<Response>;
adapter.history(sessionId: string): Promise<{
  messages: BotUIMessage[]; session: BotSession; run?: BotRun;
}>;
adapter.sessions(): Promise<BotSession[]>;
adapter.info(): Promise<BotInfoSummary>;
adapter.cancel(runId: string): Promise<void>;

// Optional pure conversion for an application that already has a backend snapshot:
botSnapshotToUIMessages(snapshot: BotEvent): BotUIMessage[];
```

## HTTP route mapping

* POST `/api/chat`: `adapter.chat(request)`.
* GET `/api/chat?sessionId=...&runId=...`: `adapter.resume(request, sessionId, runId)`.
* GET `/api/sessions`: JSON `{ sessions: await adapter.sessions() }`.
* GET `/api/sessions/:id`: JSON `await adapter.history(id)`.
* GET `/api/info`: JSON `await adapter.info()`.
* POST `/api/runs/:id/cancel`: `await adapter.cancel(id)` then JSON `{ok:true}`.

`chat` and `resume` return client-safe JSON errors (non-2xx) before streaming, and AI SDK error parts on an interrupted stream. Other methods throw `BotAdapterError` with safe `.message`, `.code`, `.status`; route wrappers must not serialize unknown exceptions. Mutating browser routes must validate same Origin (chat does this itself; a cancel route wrapper must too). A missing Origin is permitted for trusted server/test clients. IDs and any authentication/authorization checks still belong at the application boundary.

## Browser request/stream contract

Use AI SDK 7 `DefaultChatTransport<BotUIMessage>` with `useChat<BotUIMessage>` from `@ai-sdk/react`. This package does not import React. `prepareSendMessagesRequest` should return `{body:{id,messages,sessionId:originalAdmissionSession,requestId:stableId}}`. Stable request ID may be omitted: the adapter derives it from chat ID and newest user message ID. Freeze the admission `sessionId` per user-message ID: retries keep the original option (including omission), even after acceptance reveals the new session. Only genuinely new turns read the new live session ID. Known run/session IDs are for resume, not a changed-scope POST retry. Send only ordinary append requests; `trigger:'submit-message'` and `messageId` equal to the last user message ID are accepted. Edit, regenerate, tool-approval, tool-result submission, attachments and empty input are explicitly unsupported. Do not configure `sendAutomaticallyWhen` or a second tool loop.

The adapter extracts **only the final user message's text** and never re-submits browser history. Request body fields are limited to `id`, `messages`, `sessionId`, `requestId`, `trigger`, `messageId`. Do not send cwd/source/path/backend URL.

`BotUIMessage = UIMessage<unknown, BotDataParts>`; its data part map is:

* `bot-run`: `{ runId, sessionId, status }`, status `queued | running | completed | failed | cancelled`. `data-bot-run` is emitted immediately after admission, and at status changes. Store IDs via `onData`. Update URL/storage **without remounting useChat** midstream.
* `bot-tool`: `{ toolCallId, toolName, state:'running'|'completed'|'failed', input?:unknown, output?:unknown, parentToolCallId?:string }`. These are display-only escaped data, not executable AI SDK tool calls. Stable data IDs replace earlier tool state. Render these parts alongside text/reasoning; do not treat them as a request for browser execution.
* `bot-progress`: `{type:string, attempt?:number}` (transient, safe retry/compaction notices).
* `bot-usage`: numeric usage totals (transient).

Stop is two independent operations: call the explicit cancellation route using the accepted run ID, and stop the local reader. Disconnect, abort, selection change and unmount **only detach observers**. They never cancel accepted backend work. A stream error means reconnect/inspect history, not that a run succeeded or was cancelled.

On session selection, load `history` and replace browser messages. Reconnection uses `resume` with known session/run IDs, never `chat`. Set `new DefaultChatTransport({ resumeStreamIsReplay: true, ... })` (AI SDK 7's supported replay setting), and configure `prepareReconnectToStreamRequest` to return the resume route URL with known sessionId/runId. Resume replays the **latest assistant turn** from the canonical session snapshot (all its text, reasoning and tool parts), then follows live work; it is not a byte-offset replay. Earlier user/assistant turns come from `history`, not from this response stream. The stable assistant ID replaces the existing turn when `useChat.resumeStream()` consumes the replay; do not append replay text manually. Resume never submits a run. A run/session mismatch is rejected. A session-only resume cannot discover queued runs omitted by the backend snapshot. Retain and pass the accepted runId (as the maintained UI does in URL/storage references) to recover those runs. Without a known run, resume replays the latest available assistant turn and closes when the snapshot has no active generation. For older turns use `history`; `runId` identifies the run whose completion/status to observe, not an instruction to edit or regenerate an older turn. AI SDK 7 `reset-step` chunks reconcile provider retries and authoritative whole-message corrections without duplicating previously streamed text.

## Structural backend

`BotBackend` is injectable and structurally compatible with the runtime's public handle; no import of that runtime is needed. It has `info()`, `submit(text,{session?,requestId?,onEvent?})`, `getRun(runId)`, `listSessions()`, `watch(sessionId, listener)` returning `Promise<() => Promise<void>>`, and `cancel(runId)`. Optional watch error reporting is supported by a third options argument `{onError?}`. An implementation should send `snapshot` first, atomically with live subscription. Events are `{type:string,sessionId?:string,runId?:string,data?:unknown}`; snapshot carries durable `entries`, optional `generation.message` and tool state. `run_settled` contains a run record; session-only implementations are checked via `getRun` while observing.

The HTTP client uses only existing `/v1/info`, `/v1/runs`, `/v1/runs/:id`, `/v1/runs/:id/cancel`, `/v1/sessions`, and `/v1/sessions/:id/stream`. No invented history endpoint. It bounds JSON/NDJSON, rejects malformed IDs, disables redirects, and does not expose backend bodies, URLs, credentials or raw exception messages in errors. History is a read-only snapshot subscription immediately detached after receiving the snapshot; no runtime takeover or second agent loop.

Additional exports: `BotAdapterError`, frozen `LIMITS`, `botSnapshotToUIMessages`, `ConnectBotBackendOptions`, `BotCapability`, `BotChatAdapter`, `BotDataParts`, `BotEvent`, `BotHistory`, `BotRunData`, `BotRunStatus`, `BotSubmitOptions`, `BotToolData`, `BotUsage`, and `BotWatchOptions`. Pure snapshot conversion requires a `snapshot` event with `sessionId` and validates the same bounded canonical entry shape as history.

Exact exported field types and limits are documented in README and emitted TypeScript declarations. This file is published early for parallel UI integration and maintained with the implementation.
