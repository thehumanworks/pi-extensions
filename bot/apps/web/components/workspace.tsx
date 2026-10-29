"use client";

import { useCallback, useEffect, useState } from "react";
import type { BotInfoSummary, BotSession } from "@nothumanwork/bot-ai-sdk";
import { fetchJson, validId } from "../lib/chat";
import { Sidebar } from "./sidebar";
import { Conversation } from "./conversation";

const STORAGE_KEY = "bot-ui:selected-session";

export function Workspace() {
  const [ready, setReady] = useState(false);
  const [selection, setSelection] = useState<{ id?: string; key: number }>({ key: 0 });
  const [sessions, setSessions] = useState<BotSession[]>([]);
  const [info, setInfo] = useState<BotInfoSummary>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const refreshSessions = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const data = await fetchJson<{ sessions: BotSession[] }>("/api/sessions", { signal });
      if (signal?.aborted) return;
      setSessions([...data.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setError(undefined);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Could not load sessions.");
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);

  const remember = useCallback((id: string | undefined, push: boolean) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("session", id); else url.searchParams.delete("session");
    url.searchParams.delete("run"); // Never carry a different session\'s run reference.
    if (push) window.history.pushState(null, "", url); else window.history.replaceState(null, "", url);
    try { if (id) localStorage.setItem(STORAGE_KEY, id); else localStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be disabled. URL is sufficient. */ }
  }, []);

  const select = useCallback((id?: string) => {
    if (id !== undefined && !validId(id)) return;
    setSelection(previous => ({ id, key: previous.key + 1 }));
    remember(id, true);
    setSidebarOpen(false);
    requestAnimationFrame(() => document.getElementById("chat-main")?.focus());
  }, [remember]);

  useEffect(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* Private browsing. */ }
    const query = new URL(window.location.href).searchParams;
    const id = query.has("session") ? query.get("session") : stored;
    setSelection({ id: validId(id) ? id : undefined, key: 1 });
    setReady(true);
    const onPopState = () => {
      const id = new URL(window.location.href).searchParams.get("session");
      setSelection(previous => ({ id: validId(id) ? id : undefined, key: previous.key + 1 }));
      setSidebarOpen(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshSessions(controller.signal);
    void fetchJson<BotInfoSummary>("/api/info", { signal: controller.signal }).then(setInfo).catch(() => { /* The sidebar provides a visible service error. */ });
    return () => controller.abort();
  }, [refreshSessions]);

  const accepted = useCallback((id: string) => {
    // Never change the Conversation key when a new session is accepted midstream.
    setSelection(previous => ({ ...previous, id }));
    remember(id, false);
    void refreshSessions();
  }, [remember, refreshSessions]);

  return <div className="workspace">
    <a className="skip-link" href="#chat-main">Skip to conversation</a>
    <Sidebar sessions={sessions} selected={selection.id} loading={loading} error={error} open={sidebarOpen} onClose={() => setSidebarOpen(false)} onSelect={select} onNew={() => select()} onRefresh={() => void refreshSessions()} />
    <main id="chat-main" className="main-panel" tabIndex={-1}>
      {ready ? <Conversation key={selection.key} initialSessionId={selection.id} botName={info?.name || "Bot"} description={info?.description} onAccepted={accepted} onSessionsChanged={() => void refreshSessions()} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(open => !open)} />
        : <div className="initial-loading" role="status">Opening workspace…</div>}
    </main>
  </div>;
}
