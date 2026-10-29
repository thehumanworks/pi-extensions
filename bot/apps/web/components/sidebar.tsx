import type { BotSession } from "@nothumanwork/bot-ai-sdk";
import { sessionTitle } from "../lib/chat";

export function Sidebar({ sessions, selected, loading, error, open, onClose, onSelect, onNew, onRefresh }: {
  sessions: BotSession[]; selected?: string; loading: boolean; error?: string; open: boolean;
  onClose: () => void; onSelect: (id: string) => void; onNew: () => void; onRefresh: () => void;
}) {
  return <aside id="sessions-sidebar" className={`sidebar ${open ? "sidebar-open" : ""}`} aria-label="Sessions">
    <div className="brand"><span className="brand-mark" aria-hidden="true">b</span><span>bot<span className="brand-subtitle">Workspace</span></span><button className="icon-button mobile-only sidebar-close" onClick={onClose} aria-label="Close sessions">×</button></div>
    <button className="new-session" onClick={onNew}><span aria-hidden="true">+</span> New session</button>
    <div className="sidebar-label"><h2>Conversations</h2><button className="icon-button" onClick={onRefresh} disabled={loading} aria-label="Refresh sessions">↻</button></div>
    {loading && <p className="sidebar-note" role="status">Loading sessions…</p>}
    {error && <p className="sidebar-error" role="alert">{error}</p>}
    <nav aria-label="Conversation history" className="session-list">
      {!loading && !error && !sessions.length && <p className="sidebar-note">No conversations yet.<br />Start a session to begin.</p>}
      {sessions.map(session => <button className="session-item" key={session.sessionId} aria-current={selected === session.sessionId ? "page" : undefined} onClick={() => onSelect(session.sessionId)}>
        <span className="session-title">{sessionTitle(session)}</span><span className="session-date">{formatDate(session.updatedAt)}</span>
      </button>)}
    </nav>
    <div className="sidebar-footer"><span className="privacy-dot" aria-hidden="true" />Server-mediated connection<span>History lives with your bot.</span></div>
  </aside>;
}
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Saved conversation" : new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date);
}
