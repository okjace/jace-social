"use client";
// Jace ban appeals, for Jace Official's owner and admins (server: lib/appeals.ts). The inbox (with
// Waiting / Banned / Muted / All), one appeal's thread, replies as Jace Official, Unban and Keep banned.
import { useEffect, useRef, useState } from "react";
import { api, timeLabel } from "@/lib/client";
import { Avatar } from "./ui";

type Status = "banned" | "muted" | "active" | "deleted";
type Msg = { id: string; from_id: string; from_name: string; body: string; created_at: string };
export type AppealRow = {
  user_id: string; username: string; picture: string | null; status: Status;
  ban_reason: string | null; banned_at: string | null; mute_reason: string | null; muted_at: string | null;
  last_message: Msg | null; waiting: boolean; unread: boolean;
};
type Filter = "waiting" | "banned" | "muted" | "all";

const LABEL: Record<Status, string> = { banned: "Banned", muted: "Muted", active: "Active", deleted: "Deleted" };
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "");
export function StatusBadge({ status }: { status: Status }) {
  return <span className={`appeal-badge ${status}`}>{LABEL[status]}</span>;
}
function reasonLine(a: Pick<AppealRow, "status" | "ban_reason" | "banned_at" | "mute_reason" | "muted_at">) {
  if (a.status === "banned") return `${a.ban_reason || "No reason given"}${a.banned_at ? ` · banned ${day(a.banned_at)}` : ""}`;
  if (a.status === "muted") return `${a.mute_reason || "No reason given"}${a.muted_at ? ` · muted ${day(a.muted_at)}` : ""}`;
  return a.status === "active" ? "No longer restricted" : "This Jace account no longer exists";
}

/** Signs in with Jace again for a fresh token (the appeals check uses it). */
async function reconnectJace(onDone: () => void, onError: (m: string) => void) {
  try {
    const r = await api<{ url: string; state: string; poll_key: string }>("/link/jace", { body: {} });
    window.open(r.url, "_blank", "noopener");
    for (let i = 0; i < 150; i++) {
      await new Promise((ok) => setTimeout(ok, 2000));
      const d = await api<{ pending?: boolean }>(`/auth/jace/poll?state=${r.state}&key=${r.poll_key}`);
      if (!d.pending) { onDone(); return; }
    }
    onError("Reconnecting timed out - try again");
  } catch (e) { onError((e as Error).message); }
}

function Reconnect({ onDone, onError }: { onDone: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="card" style={{ display: "grid", gap: 8, margin: 16 }}>
      <b>Reconnect Jace</b>
      <span className="muted small">Your Jace sign-in stopped working, so appeals can&apos;t load. Sign in with Jace again to see them.</span>
      <button className="btn primary small" style={{ justifySelf: "start" }} disabled={busy}
        onClick={() => { setBusy(true); void reconnectJace(() => { setBusy(false); onDone(); }, (m) => { setBusy(false); onError(m); }); }}>
        {busy ? "Finish in the tab that opened…" : "Reconnect Jace"}</button>
    </div>
  );
}

/** The whole Appeals view: the inbox, or one thread. */
export function Appeals({ open, onOpen, refresh, onUnread, onReconnected, onError, back }: {
  open: string | null; onOpen: (userId: string | null) => void; refresh: number;
  onUnread: (n: number) => void; onReconnected: () => void; onError: (m: string) => void; back: () => void;
}) {
  const [list, setList] = useState<AppealRow[] | null>(null);
  const [reconnect, setReconnect] = useState(false);
  const [filter, setFilter] = useState<Filter>("waiting");
  const load = async () => {
    try {
      const r = await api<{ appeals: AppealRow[]; reconnect?: boolean }>("/appeals");
      setReconnect(!!r.reconnect); setList(r.appeals);
      onUnread(r.appeals.filter((a) => a.unread).length);
    } catch (e) { onError((e as Error).message); setList([]); }
  };
  useEffect(() => { void load(); }, [refresh, open]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (reconnect) return <Reconnect onDone={() => { onReconnected(); void load(); }} onError={onError} />;
  const row = list?.find((a) => a.user_id === open);
  if (open) return <AppealThread userId={open} summary={row} refresh={refresh} onBack={() => onOpen(null)} onChanged={load} onError={onError}
    onReconnect={() => setReconnect(true)} />;
  const shown = (list ?? []).filter((a) => filter === "all" || (filter === "waiting" ? a.waiting : a.status === filter));
  return <>
    <div className="main-head">
      <button className="icon-btn mobile-only" onClick={back}>‹</button>
      <span className="title">⚖️ Appeals</span>
      <span className="topic">People who messaged Jace Official about a ban or mute</span>
    </div>
    <div className="appeal-filters">
      {(["waiting", "banned", "muted", "all"] as const).map((f) => (
        <button key={f} className={`tab${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>
          {f === "waiting" ? "Waiting" : f === "banned" ? "Banned" : f === "muted" ? "Muted" : "All"}
          {f === "waiting" && !!list?.filter((a) => a.waiting).length && ` (${list.filter((a) => a.waiting).length})`}</button>
      ))}
    </div>
    <div className="appeal-list">
      {list === null ? <p className="muted" style={{ padding: 16 }}>Loading appeals…</p>
        : shown.length === 0 ? <p className="muted" style={{ padding: 16 }}>{filter === "waiting" ? "Nobody is waiting for a reply." : "No appeals here."}</p>
        : shown.map((a) => (
          <button key={a.user_id} className={`appeal-row${a.unread ? " unread" : ""}`} onClick={() => onOpen(a.user_id)}>
            <Avatar p={{ name: a.username, avatar_url: a.picture }} size={40} />
            <span className="appeal-main">
              <span className="appeal-top"><b>@{a.username}</b> <StatusBadge status={a.status} />
                {a.waiting && <span className="appeal-waiting">Waiting for reply</span>}
                <span className="grow" />
                {a.last_message && <span className="muted small">{timeLabel(a.last_message.created_at)}</span>}</span>
              <span className="muted small">{reasonLine(a)}</span>
              {a.last_message && <span className="appeal-last">{a.last_message.from_id === a.user_id ? "" : "Jace Official: "}{a.last_message.body}</span>}
            </span>
          </button>
        ))}
    </div>
  </>;
}

function AppealThread({ userId, summary, refresh, onBack, onChanged, onError, onReconnect }: {
  userId: string; summary?: AppealRow; refresh: number; onBack: () => void; onChanged: () => void;
  onError: (m: string) => void; onReconnect: () => void;
}) {
  const [appeal, setAppeal] = useState<(Omit<AppealRow, "waiting" | "unread" | "last_message">) | null>(summary ?? null);
  const [messages, setMessages] = useState<Msg[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const replyId = useRef(crypto.randomUUID());             // the same id when retrying: Jace sends it once
  const end = useRef<HTMLDivElement>(null);
  const load = async () => {
    try {
      const r = await api<{ appeal?: AppealRow; messages?: Msg[]; reconnect?: boolean }>(`/appeals/${encodeURIComponent(userId)}`);
      if (r.reconnect) { onReconnect(); return; }
      setAppeal(r.appeal ?? null); setMessages(r.messages ?? []);
    } catch (e) { onError((e as Error).message); }
  };
  useEffect(() => { void load(); }, [userId, refresh]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages]);

  async function send(kind: "reply" | "keep") {
    const body = text.trim() || (kind === "keep" ? "We looked at your appeal, and the ban stays." : "");
    if (!body) return;
    if (kind === "keep" && !confirm(`Keep @${appeal?.username} banned? This sends them your reply as Jace Official:\n\n"${body}"`)) return;
    setBusy(true); setResult("");
    try {
      if (kind === "keep") await api(`/appeals/${encodeURIComponent(userId)}/decision`, { body: { action: "keep", body, reply_id: replyId.current } });
      else await api(`/appeals/${encodeURIComponent(userId)}`, { body: { body, reply_id: replyId.current } });
      replyId.current = crypto.randomUUID(); setText("");
      if (kind === "keep") setResult("Kept banned - your reply was sent.");
      await load(); onChanged();
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }   // a retry reuses the reply id
  }

  async function unban() {
    if (!confirm(`Unban @${appeal?.username} on Jace? They can use Jace (and sign in to Jace Social) again.`)) return;
    setBusy(true); setResult("");
    try {
      const r = await api<{ result: { username: string; banned: boolean; muted: boolean } }>(`/appeals/${encodeURIComponent(userId)}/decision`,
        { body: { action: "unban" } });
      setResult(r.result.banned ? `Jace says @${r.result.username} is still banned.`
        : `Jace says @${r.result.username} is no longer banned${r.result.muted ? " (still muted - lift that on Jace)" : ""}.`);
      await load(); onChanged();
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }

  return <>
    <div className="main-head">
      <button className="icon-btn" title="All appeals" onClick={onBack}>‹</button>
      {appeal && <Avatar p={{ name: appeal.username, avatar_url: appeal.picture }} size={28} />}
      <span className="title">@{appeal?.username ?? "…"}</span>
      {appeal && <StatusBadge status={appeal.status} />}
      {appeal && <span className="topic">{reasonLine(appeal)}</span>}
    </div>
    <div className="appeal-thread">
      {messages === null ? <p className="muted">Loading…</p> : messages.map((m) => {
        const theirs = m.from_id === userId;
        return (
          <div key={m.id} className={`appeal-msg ${theirs ? "them" : "official"}`}>
            <span className="muted small">{theirs ? `@${m.from_name}` : "Jace Official"} · {timeLabel(m.created_at)}</span>
            <div className="appeal-bubble">{m.body}</div>
          </div>
        );
      })}
      <div ref={end} />
    </div>
    <div className="appeal-reply">
      {result && <div className="appeal-result">{result}</div>}
      <label className="small muted">Replying as <b>Jace Official</b> - they see it on Jace&apos;s &quot;You&apos;re banned&quot; page</label>
      <textarea rows={3} maxLength={4000} value={text} placeholder={`Reply to @${appeal?.username ?? ""} as Jace Official…`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send("reply"); }} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn primary small" disabled={busy || !text.trim()} onClick={() => void send("reply")}>Send as Jace Official</button>
        <span className="grow" />
        {appeal?.status === "banned" && <>
          <button className="btn small" disabled={busy} onClick={() => void send("keep")}>Keep banned</button>
          <button className="btn small primary" disabled={busy} onClick={() => void unban()}>Unban</button>
        </>}
        {appeal?.status === "muted" && <span className="muted small">Mutes are lifted on Jace - you can reply here.</span>}
      </div>
    </div>
  </>;
}
