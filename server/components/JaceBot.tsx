"use client";
// The official Jace bot in the app (server/lib/jaceBot.ts): its OFFICIAL tag, the Announcements
// and Docs tabs of its chat (which the people running it can edit), "Talk to a person", and the
// inbox the people signed in as the bot answer from.
import { useEffect, useState } from "react";
import { api, timeLabel, type Me, type Person } from "@/lib/client";
import { Markdown } from "./Markdown";
import { Avatar } from "./ui";

export const JACE_BOT = "00000000000000000000000000000ace";

/** BOT, or OFFICIAL for the Jace bot. */
export function BotTag({ p, style }: { p?: { is_bot?: boolean; official?: boolean; uuid?: string } | null; style?: React.CSSProperties }) {
  if (!p?.is_bot && !p?.official) return null;
  const official = p.official || p.uuid === JACE_BOT;
  return <span className={`bot-tag${official ? " official-tag" : ""}`} style={style} title={official ? "The official Jace Social bot" : "A bot"}>
    {official ? "✓ OFFICIAL" : "BOT"}</span>;
}

type Announcement = { id: number; body: string; created_at: string; sent_to: number };
type Doc = { id: string; slug: string; title: string; body: string; position: number; updated_at: string };
const mentions = { people: {}, roles: [] };

export type JaceTab = "chat" | "announcements" | "docs" | "broadcast";

export function JaceTabs({ tab, setTab, me, onError }: {
  tab: JaceTab; setTab: (t: JaceTab) => void; me: Me; onError: (m: string) => void;
}) {
  const [mode, setMode] = useState<"ai" | "human">("ai");
  const [busy, setBusy] = useState(false);
  const isBot = me.uuid === JACE_BOT;
  useEffect(() => { if (!isBot) api<{ mode: "ai" | "human" }>("/jace-bot/thread").then((r) => setMode(r.mode)).catch(() => {}); }, [isBot]);
  return (
    <div className="jace-tabs">
      {(["chat", "announcements", "docs", ...(me.jace_staff ? ["broadcast" as const] : [])] as const).map((t) => (
        <button key={t} className={`tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
          {t === "chat" ? "💬 Chat" : t === "announcements" ? "📢 Announcements" : t === "docs" ? "📖 Docs" : "📣 Broadcast"}</button>
      ))}
      <span className="spacer" />
      {!isBot && tab === "chat" && (
        <button className="btn small" disabled={busy} onClick={async () => {
          setBusy(true);
          try { setMode((await api<{ mode: "ai" | "human" }>("/jace-bot/thread", { body: { human: mode === "ai" } })).mode); }
          catch (e) { onError((e as Error).message); } finally { setBusy(false); }
        }}>{mode === "ai" ? "🙋 Talk to a person" : "🤖 Back to the AI"}</button>
      )}
    </div>
  );
}

/** Broadcast (the people running the Jace bot): a normal message from the Jace bot to everyone. */
export function Broadcast({ onError }: { onError: (m: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  return (
    <div className="jace-pane">
      <div className="card" style={{ display: "grid", gap: 8 }}>
        <b>Send to everyone</b>
        <span className="muted small">A message from the Jace bot in everyone&apos;s chat with it. Unlike an announcement, it isn&apos;t listed in Announcements.</span>
        <textarea rows={5} maxLength={4000} value={text} placeholder="Write to everyone on Jace Social…" onChange={(e) => setText(e.target.value)} />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="btn primary small" disabled={busy || !text.trim()} onClick={async () => {
            if (!confirm("Send this to everyone on Jace Social as a message from the Jace bot?")) return;
            setBusy(true); setNote("");
            try { await api("/jace-bot/broadcast", { body: { body: text } }); setText(""); setNote("Sending to everyone…"); }
            catch (e) { onError((e as Error).message); } finally { setBusy(false); }
          }}>📣 Send to everyone</button>
          {note && <span className="muted small">{note}</span>}
        </div>
      </div>
    </div>
  );
}

export function Announcements({ me, onError }: { me: Me; onError: (m: string) => void }) {
  const [list, setList] = useState<Announcement[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const staff = !!me.jace_staff;
  const load = () => api<{ announcements: Announcement[] }>("/jace-bot/announcements").then((r) => setList(r.announcements)).catch((e) => onError(e.message));
  useEffect(() => { void load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="jace-pane">
      {staff && (
        <div className="card" style={{ display: "grid", gap: 8 }}>
          <b>New announcement</b>
          <textarea rows={3} maxLength={4000} value={text} placeholder="What's new?" onChange={(e) => setText(e.target.value)} />
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn primary small" disabled={busy || !text.trim()} onClick={async () => {
              if (!confirm("Post this? It also goes to everyone on Jace Social as a message from the Jace bot.")) return;
              setBusy(true);
              try { await api("/jace-bot/announcements", { body: { body: text } }); setText(""); await load(); }
              catch (e) { onError((e as Error).message); } finally { setBusy(false); }
            }}>Post to everyone</button>
            <span className="muted small">Shows here and is sent to everyone as a message.</span>
          </div>
        </div>
      )}
      {list === null ? <p className="muted">Loading…</p> : list.length === 0 ? <p className="muted">No announcements yet.</p> : list.map((a) => (
        <div key={a.id} className="card">
          <div className="muted small" style={{ display: "flex", gap: 8 }}>
            <span className="grow">{timeLabel(a.created_at)}{staff && a.sent_to ? ` · sent to ${a.sent_to}` : ""}</span>
            {staff && <button className="icon-btn small" title="Remove from this list" onClick={async () => {
              if (!confirm("Remove it from Announcements? Messages already sent stay.")) return;
              try { await api(`/jace-bot/announcements?id=${a.id}`, { method: "DELETE" }); await load(); } catch (e) { onError((e as Error).message); }
            }}>🗑</button>}
          </div>
          <Markdown text={a.body} mentions={mentions} />
        </div>
      ))}
    </div>
  );
}

export function Docs({ me, onError }: { me: Me; onError: (m: string) => void }) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ id?: string; title: string; body: string; position: number } | null>(null);
  const staff = !!me.jace_staff;
  const load = () => api<{ docs: Doc[] }>("/jace-bot/docs").then((r) => setDocs(r.docs)).catch((e) => onError(e.message));
  useEffect(() => { void load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  if (edit) return (
    <div className="jace-pane">
      <div className="card" style={{ display: "grid", gap: 8 }}>
        <b>{edit.id ? "Edit doc" : "New doc"}</b>
        <input value={edit.title} maxLength={120} placeholder="Title" onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
        <textarea rows={14} maxLength={20000} value={edit.body} placeholder="Write it in Markdown (**bold**, lists, links)…"
          onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
        <label className="small">Order <input type="number" value={edit.position} style={{ width: 80 }}
          onChange={(e) => setEdit({ ...edit, position: Number(e.target.value) })} /></label>
        <p className="muted small" style={{ margin: 0 }}>The Jace AI answers questions from these Docs.</p>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn primary small" disabled={!edit.title.trim()} onClick={async () => {
            try {
              if (edit.id) await api("/jace-bot/docs", { method: "PATCH", body: edit });
              else await api("/jace-bot/docs", { body: edit });
              setEdit(null); await load();
            } catch (e) { onError((e as Error).message); }
          }}>Save</button>
          <button className="btn small" onClick={() => setEdit(null)}>Cancel</button>
          {edit.id && <button className="btn small danger" onClick={async () => {
            if (!confirm(`Delete "${edit.title}"?`)) return;
            try { await api(`/jace-bot/docs?id=${edit.id}`, { method: "DELETE" }); setEdit(null); setOpen(null); await load(); }
            catch (e) { onError((e as Error).message); }
          }}>Delete</button>}
        </div>
      </div>
    </div>
  );
  const doc = docs?.find((d) => d.id === open);
  return (
    <div className="jace-pane">
      {doc ? <>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn small" onClick={() => setOpen(null)}>← All docs</button>
          {staff && <button className="btn small" onClick={() => setEdit({ id: doc.id, title: doc.title, body: doc.body, position: doc.position })}>✎ Edit</button>}
        </div>
        <h2 style={{ margin: "4px 0" }}>{doc.title}</h2>
        <div className="card"><Markdown text={doc.body} mentions={mentions} /></div>
      </> : <>
        {staff && <button className="btn primary small" style={{ justifySelf: "start" }}
          onClick={() => setEdit({ title: "", body: "", position: (docs?.length ?? 0) + 1 })}>＋ New doc</button>}
        {docs === null ? <p className="muted">Loading…</p> : docs.length === 0 ? <p className="muted">No docs yet.</p> : docs.map((d) => (
          <button key={d.id} className="card doc-link" onClick={() => setOpen(d.id)}>
            <b>{d.title}</b>
            <span className="muted small">{d.body.replace(/[*`#_>~]/g, "").slice(0, 120)}…</span>
          </button>
        ))}
        <p className="muted small" style={{ margin: 0 }}>Can't find it? Ask in the Chat tab.</p>
      </>}
    </div>
  );
}

export type InboxEntry = { uuid: string; name: string; handle: string | null; avatar_url: string | null; wants_person: boolean;
  unread: number; last: string; last_at: string; banned: boolean };

/** Signed in as the Jace bot: everyone who wrote to it, people who asked for a person first. */
export function JaceInbox({ entries, active, onOpen }: { entries: InboxEntry[]; active: string | null; onOpen: (e: InboxEntry) => void }) {
  return <>
    <div className="side-label">Jace inbox</div>
    {entries.length === 0 && <p className="muted small" style={{ margin: "0 8px" }}>Nobody has written yet</p>}
    {entries.map((e) => (
      <button key={e.uuid} className={`side-item${active === e.uuid ? " active" : ""}${e.unread ? " unread" : ""}`} onClick={() => onOpen(e)}>
        <Avatar p={e} size={32} />
        <span className="name">{e.wants_person && "🙋 "}{e.name}{e.banned && " (banned)"}
          <span className="sub">{e.wants_person ? "Wants a person" : e.last.slice(0, 60)}</span></span>
        {e.unread > 0 && <span className="badge">{e.unread}</span>}
      </button>
    ))}
  </>;
}

/** As a person to show in a chat with someone from the inbox. */
export const inboxPerson = (e: InboxEntry): Person => ({
  uuid: e.uuid, name: e.name, avatar_url: e.avatar_url, online: false, status: "offline", uses_jace: false, activity: null,
  last_seen: null, custom_status: null, status_emoji: null, minecraft_name: null, jace_name: null, bio: null, pronouns: null,
  accent_color: null, links: [], handle: e.handle,
});
