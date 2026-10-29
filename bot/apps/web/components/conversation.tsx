"use client";

import { useChat } from "@ai-sdk/react";
import type { BotUIMessage } from "@nothumanwork/bot-ai-sdk";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { fetchJson, isActive, runData, submissionInHistory, type History, type PendingSubmission, type RunState } from "../lib/chat";
import { ChatMessage } from "./message";
import { createChatTransport } from "../lib/transport";
import { loadRunReference, saveRunReference } from "../lib/recovery";

type Connection = "ready" | "loading" | "reconnecting" | "live" | "interrupted";

export function Conversation({ initialSessionId, botName, description, onAccepted, onSessionsChanged, sidebarOpen, onToggleSidebar }: {
  initialSessionId?: string; botName: string; description?: string;
  onAccepted: (id: string) => void; onSessionsChanged: () => void; sidebarOpen: boolean; onToggleSidebar: () => void;
}) {
  const [chatId] = useState(() => crypto.randomUUID());
  const initialSession = useRef(initialSessionId);
  const sessionRef = useRef(initialSessionId);
  const runRef = useRef<RunState | undefined>(undefined);
  const mounted = useRef(false);
  const syncing = useRef(false);
  const stopping = useRef(false);
  const stopNotice = useRef<string | undefined>(undefined);
  const pendingSubmission = useRef<PendingSubmission | undefined>(undefined);
  const requestAbort = useRef<AbortController | undefined>(undefined);
  const reconcileRef = useRef<(resume: boolean) => Promise<void>>(async () => {});
  const [run, setRun] = useState<RunState>();
  const [connection, setConnection] = useState<Connection>(initialSessionId ? "loading" : "ready");
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const [notice, setNotice] = useState<string>();
  const [progress, setProgress] = useState<string>();
  const [draft, setDraft] = useState("");
  const [isStopping, setIsStopping] = useState(false);
  const [needsSubmissionRetry, setNeedsSubmissionRetry] = useState(false);
  const [snapshot, setSnapshot] = useState<BotUIMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const callbacks = useRef({ onAccepted, onSessionsChanged });
  callbacks.current = { onAccepted, onSessionsChanged };

  const transport = useMemo(() => createChatTransport({
    session: () => sessionRef.current,
    run: () => runRef.current
  }), []);

  const { messages, setMessages, sendMessage, resumeStream, stop, status } = useChat<BotUIMessage>({
    id: chatId,
    transport,
    throttle: 50,
    onData: part => {
      if (!mounted.current) return;
      if (part.type === "data-bot-run") {
        const next = runData(part.data);
        if (!next || (sessionRef.current && sessionRef.current !== next.sessionId)) return;
        const firstAcceptance = !sessionRef.current;
        sessionRef.current = next.sessionId;
        runRef.current = next;
        pendingSubmission.current = undefined;
        setNeedsSubmissionRetry(false);
        setRun(next);
        setConnection(isActive(next) ? "live" : "ready");
        if (!isActive(next)) stopNotice.current = undefined;
        setNotice(stopNotice.current);
        if (firstAcceptance) callbacks.current.onAccepted(next.sessionId);
        saveRunReference(next);
      }
      if (part.type === "data-bot-progress") {
        const labels: Record<string, string> = { auto_retry_start: "The bot is retrying…", compaction_start: "The bot is organizing its context…" };
        setProgress(labels[part.data.type]);
      }
    },
    onError: error => {
      if (!mounted.current) return;
      setConnection("interrupted");
      setNotice(`${error.message.slice(0, 350) || "The connection was interrupted."} Accepted work may still be running. Reconnect to check its progress.`);
    },
    onFinish: ({ isAbort, isError, isDisconnect }) => {
      if (!mounted.current || isError || isDisconnect || stopping.current) return;
      if (isAbort && runRef.current?.status !== "cancelled") return;
      setProgress(undefined);
      // Fetch canonical history even after a clean EOF: EOF alone is not run success.
      setTimeout(() => { if (mounted.current) void reconcileRef.current(false); }, 0);
      callbacks.current.onSessionsChanged();
    }
  });
  const busy = status === "submitted" || status === "streaming";

  const reconcile = useCallback(async (resume: boolean) => {
    if (!sessionRef.current || syncing.current || !mounted.current) return;
    syncing.current = true;
    setConnection("reconnecting");
    const controller = new AbortController();
    requestAbort.current = controller;
    try {
      const history = await fetchJson<History>(`/api/sessions/${encodeURIComponent(sessionRef.current)}`, { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      const next = history.run ? runData(history.run) : runRef.current ?? loadRunReference(sessionRef.current);
      runRef.current = next;
      setRun(next);
      const pending = pendingSubmission.current;
      if (pending && !submissionInHistory(pending, history.messages, next) && !isActive(next)) {
        // An admission response may have been lost. Keep its original user-message ID
        // so an explicit retry is idempotent rather than a brand-new submission.
        const optimistic = [...history.messages, pending.message];
        setSnapshot(optimistic);
        setMessages(optimistic);
        setNeedsSubmissionRetry(true);
        setConnection("interrupted");
        setNotice("No new run was found yet. Retry submission safely reuses the original request ID.");
        return;
      }
      if (pending) pendingSubmission.current = undefined;
      setNeedsSubmissionRetry(false);
      setSnapshot(history.messages);
      setMessages(history.messages);
      setNotice(undefined);
      if (resume && isActive(next)) {
        // Replace with canonical history above before complete replay. AI SDK 7's
        // resumeStreamIsReplay resets streamed parts and replaces stable assistant IDs;
        // keeping canonical user messages is essential (stream chunks are assistants).
        setConnection("live");
        await resumeStream();
      } else if (isActive(next)) {
        setConnection("interrupted");
        setNotice(stopNotice.current || "The run is still active. Reconnecting to its saved progress…");
      } else {
        stopNotice.current = undefined;
        setConnection("ready");
      }
    } catch (cause) {
      if (!mounted.current || controller.signal.aborted) return;
      setConnection("interrupted");
      setNotice(cause instanceof Error ? cause.message : "Could not load saved history. Retry to reconnect.");
    } finally { syncing.current = false; }
  }, [setMessages, resumeStream]);
  reconcileRef.current = reconcile;

  useEffect(() => {
    mounted.current = true;
    let active = true;
    queueMicrotask(() => { if (active && initialSession.current) void reconcileRef.current(true); });
    return () => {
      active = false;
      mounted.current = false;
      requestAbort.current?.abort();
      // useChat unmount detaches the reader. Never cancel backend work here.
    };
  }, []);

  useEffect(() => {
    const reconnect = () => {
      if (connectionRef.current === "interrupted" && sessionRef.current && !stopping.current) void reconcileRef.current(true);
    };
    const timer = setInterval(reconnect, 5000);
    window.addEventListener("online", reconnect);
    return () => { clearInterval(timer); window.removeEventListener("online", reconnect); };
  }, []);

  const displayedMessages = messages.length ? messages : snapshot;
  useEffect(() => {
    const node = scrollRef.current;
    if (node && stickToBottom.current) node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
  }, [messages, snapshot, progress]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || busy || isActive(run) || connection !== "ready") return;
    const text = draft.trim();
    setDraft("");
    stopNotice.current = undefined;
    setNotice(undefined);
    setConnection("live");
    stickToBottom.current = true;
    const message: BotUIMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
    pendingSubmission.current = { message, userCountBefore: messages.filter(item => item.role === "user").length, runIdBefore: runRef.current?.runId };
    await sendMessage(message);
  }

  async function explicitStop() {
    const current = runRef.current;
    if (!current || stopping.current) return;
    stopping.current = true;
    setIsStopping(true);
    // Independent operations: local reader failure must not prevent server cancellation.
    const localStop = stop().catch(() => {});
    try {
      await fetchJson(`/api/runs/${encodeURIComponent(current.runId)}/cancel`, { method: "POST" });
      stopNotice.current = "Stop requested. Waiting for the bot to confirm the saved run state…";
    } catch {
      stopNotice.current = "Stop could not be confirmed. The bot may still be running. Reconnect and try Stop again.";
    } finally {
      await localStop;
      stopping.current = false;
      if (mounted.current) setNotice(stopNotice.current);
      if (mounted.current) { setIsStopping(false); setConnection("interrupted"); void reconcileRef.current(false); }
      callbacks.current.onSessionsChanged();
    }
  }

  const blocked = busy || isActive(run) || connection !== "ready" || isStopping;
  const statusLabel = connection === "interrupted" ? "Connection interrupted" : connection === "loading" ? "Loading history" : connection === "reconnecting" ? "Reconnecting" : (busy && !isActive(run) ? "Connecting" : run?.status || "Ready");

  return <>
    <header className="chat-header">
      <button className="icon-button mobile-only" onClick={onToggleSidebar} aria-label="Toggle sessions" aria-expanded={sidebarOpen} aria-controls="sessions-sidebar">☰</button>
      <div className="chat-heading"><h1>{botName}</h1><p>{sessionRef.current ? "Persistent conversation" : "A new conversation"}</p></div>
      <div className={`run-status ${isActive(run) ? "status-active" : ""}`} role="status"><span aria-hidden="true" />{statusLabel}</div>
      {sessionRef.current && <button className="button-subtle sync-button" onClick={() => void reconcile(true)} disabled={busy || syncing.current || isStopping}>Sync history</button>}
    </header>
    {notice && <div className="connection-notice" role="status"><span>{notice}</span>{!busy && <button className="button-subtle" onClick={() => {
      if (sessionRef.current && !needsSubmissionRetry) void reconcile(true);
      else { setNotice(undefined); setNeedsSubmissionRetry(false); setConnection("live"); void sendMessage(); }
    }}>{sessionRef.current && !needsSubmissionRetry ? "Reconnect" : "Retry submission"}</button>}</div>}
    <div className="transcript" ref={scrollRef} onScroll={event => {
      const node = event.currentTarget;
      stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
    }} role="region" aria-label="Conversation transcript" aria-busy={connection === "loading" || connection === "reconnecting"} tabIndex={0}>
      <div className="transcript-inner">
        {!displayedMessages.length && connection === "ready" && <div className="empty-state"><div className="empty-mark" aria-hidden="true">b</div><p className="eyebrow">YOUR BOT, YOUR CONTEXT</p><h2>What are we working on?</h2><p>{description || "Start a conversation. Your bot keeps the history, so you can pick up where you left off."}</p><button className="button-subtle" onClick={() => textareaRef.current?.focus()}>Write a message ↓</button></div>}
        {!displayedMessages.length && (connection === "loading" || connection === "reconnecting") && <p className="loading-history" role="status">Loading saved conversation…</p>}
        {displayedMessages.map(message => <ChatMessage key={message.id} message={message} />)}
        {(busy || isActive(run)) && <div className="working-indicator" role="status"><span aria-hidden="true">●</span>{progress || (busy && !run ? "Connecting to bot…" : "Bot is working…")}</div>}
        {run?.status === "failed" && <p className="run-outcome" role="status">This run failed. Your conversation is saved; you can send a follow-up.</p>}
        {run?.status === "cancelled" && <p className="run-outcome" role="status">Run stopped. Your conversation is saved.</p>}
      </div>
    </div>
    <div className="composer-container">
      <form className="composer" onSubmit={submit} aria-label="Send a message">
        <label className="sr-only" htmlFor={`message-${chatId}`}>Message to {botName}</label>
        <textarea ref={textareaRef} id={`message-${chatId}`} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Message your bot…" rows={3} maxLength={100000} aria-describedby="composer-help" onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} />
        <div className="composer-actions"><span className="composer-key-hint">Enter to send · Shift + Enter for a new line</span>
          {isActive(run) || busy ? <button type="button" className="stop-button" onClick={() => void explicitStop()} disabled={!run || !isActive(run) || isStopping}>{isStopping ? "Stopping…" : !run || !isActive(run) ? "Awaiting run…" : "■ Stop"}</button>
            : <button type="submit" className="send-button" disabled={!draft.trim() || blocked}>Send <span aria-hidden="true">↑</span></button>}
        </div>
      </form>
      <p className="composer-help" id="composer-help">{isActive(run) ? "Closing this page won’t stop the bot. Use Stop to cancel this run." : "Messages and tool activity are saved by your bot. Review important results."}</p>
    </div>
  </>;
}
