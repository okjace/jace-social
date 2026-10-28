"use client";
// Reporting and moderating (server: lib/reports.ts, lib/moderation.ts, lib/automod.ts):
//   ReportModal      anyone: report a message or a person to Jace Social's staff
//   ModerationPanel  staff, on a profile: mute or ban from all of Jace Social, for a while or for good
//                    (and their Jace account too, if asked); shows what's on them now
//   Reports          staff: the reports, with the message as it was, and what to do about each
import { useEffect, useState } from "react";
import { api, timeLabel } from "@/lib/client";
import { Avatar, Modal } from "./ui";

type Err = (m: string) => void;

const REASONS: [string, string][] = [
  ["spam", "Spam"], ["harassment", "Harassment or bullying"], ["hate", "Hate"], ["sexual", "Sexual content"],
  ["violence", "Violence or threats"], ["scam", "Scam or phishing"], ["other", "Something else"],
];
const REASON_NAME = Object.fromEntries(REASONS);

export type ReportTarget = { scope: "d" | "c"; message_id: number; name: string } | { uuid: string; name: string };

export function ReportModal({ target, onClose, onError }: { target: ReportTarget; onClose: () => void; onError: Err }) {
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const isMessage = "scope" in target;
  async function send() {
    setBusy(true);
    try {
      await api("/reports", { body: { ...(isMessage ? { scope: target.scope, message_id: target.message_id } : { uuid: target.uuid }), reason, details } });
      onError("Thanks - Jace Social's staff will look at it");
      onClose();
    } catch (e) { onError((e as Error).message); setBusy(false); }
  }
  return (
    <Modal onClose={onClose}>
      <div className="modal-body">
        <h2>{isMessage ? `Report ${target.name}'s message` : `Report ${target.name}`}</h2>
        <p className="muted small">Jace Social's staff see this (not {target.name}). {isMessage ? "They see the message as it is now, even if it's changed or deleted later." : ""}</p>
        <div className="report-reasons">
          {REASONS.map(([id, name]) => (
            <label key={id} className={`report-reason${reason === id ? " on" : ""}`}>
              <input type="radio" name="reason" checked={reason === id} onChange={() => setReason(id)} /> {name}
            </label>
          ))}
        </div>
        <textarea rows={3} maxLength={1000} placeholder="Anything else staff should know (optional)" value={details} onChange={(e) => setDetails(e.target.value)} />
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn danger" disabled={!reason || busy} onClick={send}>Send report</button>
      </div>
    </Modal>
  );
}

type ModStatus = {
  jace_linked: boolean; banned: boolean; ban_until: string | null; ban_reason: string | null; ban_from: string | null;
  muted: boolean; mute_until: string | null; mute_reason: string | null; mute_from: string | null;
  automod_blocks_30d: number; reports: number;
};
const DURATIONS: [string, string][] = [["10m", "10 minutes"], ["1h", "1 hour"], ["6h", "6 hours"], ["1d", "1 day"], ["3d", "3 days"], ["1w", "1 week"], ["30d", "30 days"], ["forever", "For good"]];
const FROM: Record<string, string> = { staff: "staff", jace: "their Jace account", automod: "Jace's auto moderation" };
const untilText = (t: string | null) => (t ? `until ${new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "for good");

/** Staff, on someone's profile: what's on them, and mute / ban for a while or for good. */
export function ModerationPanel({ uuid, name, onChanged, onError }: { uuid: string; name: string; onChanged?: () => void; onError: Err }) {
  const [s, setS] = useState<ModStatus | null>(null);
  const [form, setForm] = useState<null | "mute" | "ban">(null);
  const [dur, setDur] = useState("1d");
  const [reason, setReason] = useState("");
  const [jace, setJace] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => api<ModStatus>(`/moderation?uuid=${uuid}`).then(setS).catch((e) => onError(e.message));
  useEffect(() => { void load(); }, [uuid]);   // eslint-disable-line react-hooks/exhaustive-deps
  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      const r = await api<{ jace_error?: string | null }>("/moderation", { body: { uuid, action, ...extra } });
      if (r.jace_error) onError(`Done here, but Jace said: ${r.jace_error}`);
      setForm(null); setReason("");
      await load(); onChanged?.();
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }
  if (!s) return null;
  return (
    <div className="mod-panel">
      <div className="mod-line">
        <b>Moderation</b>
        {s.banned && <span className="chip danger-chip">Banned {untilText(s.ban_until)}{s.ban_from ? ` · by ${FROM[s.ban_from] ?? s.ban_from}` : ""}</span>}
        {s.muted && <span className="chip warn-chip">Muted {untilText(s.mute_until)}{s.mute_from ? ` · by ${FROM[s.mute_from] ?? s.mute_from}` : ""}</span>}
        <span className="muted small">{s.reports} report{s.reports === 1 ? "" : "s"} · auto moderation blocked {s.automod_blocks_30d} in 30 days</span>
      </div>
      {(s.ban_reason || s.mute_reason) && <div className="muted small">{[s.ban_reason, s.mute_reason].filter(Boolean).join(" · ")}</div>}
      {form ? (
        <div className="mod-form">
          <select value={dur} onChange={(e) => setDur(e.target.value)}>{DURATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <input placeholder="Reason (they see it)" maxLength={400} value={reason} onChange={(e) => setReason(e.target.value)} />
          {s.jace_linked && <label className="check small"><input type="checkbox" checked={jace} onChange={(e) => setJace(e.target.checked)} /> Their Jace account too</label>}
          <button className="btn small" onClick={() => setForm(null)}>Cancel</button>
          <button className={`btn small ${form === "ban" ? "danger" : "primary"}`} disabled={busy}
            onClick={() => void act(form, { duration: dur, reason, jace })}>{form === "ban" ? `Ban ${name}` : `Mute ${name}`}</button>
        </div>
      ) : (
        <div className="mod-buttons">
          {s.muted ? <button className="btn small" disabled={busy} onClick={() => void act("unmute", { jace: s.mute_from === "jace" })}>Unmute</button>
            : <button className="btn small" onClick={() => { setForm("mute"); setDur("1d"); }}>🔇 Mute…</button>}
          {s.banned ? <button className="btn small" disabled={busy} onClick={() => void act("unban", { jace: s.ban_from === "jace" })}>Unban</button>
            : <button className="btn small danger" onClick={() => { setForm("ban"); setDur("forever"); }}>⛔ Ban…</button>}
        </div>
      )}
    </div>
  );
}

type ReportRow = {
  id: number; reporter: string | null; target: string | null; scope: "d" | "c" | null; message_id: number | null;
  channel_id: string | null; server_id: string | null; excerpt: string | null; reason: string; details: string | null;
  status: "open" | "resolved" | "dismissed"; resolution: string | null; resolved_by: string | null; created_at: string;
};
type Who = { uuid: string; name: string; display_name: string | null; handle: string | null; avatar_url: string | null };

/** Staff: everyone's reports. */
export function Reports({ onError, onOpenProfile, onCount, refresh, back }: {
  onError: Err; onOpenProfile: (uuid: string) => void; onCount: (n: number) => void; refresh: number; back: () => void;
}) {
  const [all, setAll] = useState(false);
  const [data, setData] = useState<{ reports: ReportRow[]; people: Record<string, Who>; open: number } | null>(null);
  const [moderating, setModerating] = useState<number | null>(null);
  const load = () => api<{ reports: ReportRow[]; people: Record<string, Who>; open: number }>(`/reports?status=${all ? "all" : "open"}`)
    .then((d) => { setData(d); onCount(d.open); }).catch((e) => onError(e.message));
  useEffect(() => { void load(); }, [all, refresh]);   // eslint-disable-line react-hooks/exhaustive-deps
  const who = (id: string | null) => (id && data?.people[id]) || null;
  const nameOf = (id: string | null) => { const w = who(id); return w ? (w.display_name || w.name) : "someone"; };
  async function close(r: ReportRow, status: string, extra: Record<string, unknown> = {}) {
    try { await api(`/reports/${r.id}`, { method: "PATCH", body: { status, ...extra } }); await load(); } catch (e) { onError((e as Error).message); }
  }
  return <>
    <div className="main-head">
      <button className="icon-btn mobile-only" onClick={back}>‹</button>
      <span className="title">🚩 Reports</span><span className="topic">Messages and people reported to Jace Social's staff</span>
    </div>
    <div className="appeal-filters">
      <button className={`tab${!all ? " active" : ""}`} onClick={() => setAll(false)}>Open{data ? ` (${data.open})` : ""}</button>
      <button className={`tab${all ? " active" : ""}`} onClick={() => setAll(true)}>All</button>
    </div>
    <div className="report-list">
      {!data ? <p className="muted">Loading…</p> : data.reports.length === 0 ? <p className="muted">{all ? "No reports yet." : "Nothing to look at - no open reports."}</p>
        : data.reports.map((r) => {
          const t = who(r.target);
          return (
            <div key={r.id} className={`report-card ${r.status}`}>
              <div className="report-top">
                <span className="chip">{REASON_NAME[r.reason] ?? r.reason}</span>
                <span className="muted small">{nameOf(r.reporter)} reported {r.message_id ? `a ${r.scope === "d" ? "direct message" : r.server_id ? "server message" : "group chat message"} from` : ""}</span>
                {t && <button className="report-person" onClick={() => onOpenProfile(t.uuid)}><Avatar p={{ name: t.display_name || t.name, avatar_url: t.avatar_url }} size={20} /> {t.display_name || t.name}{t.handle ? <span className="muted"> @{t.handle}</span> : null}</button>}
                <span className="grow" /><span className="muted small">{timeLabel(r.created_at)}</span>
              </div>
              {r.excerpt && <blockquote className="report-excerpt">{r.excerpt}</blockquote>}
              {r.details && <div className="small">“{r.details}”</div>}
              {r.status !== "open" && <div className="muted small">{r.status === "dismissed" ? "Dismissed" : "Resolved"} by {nameOf(r.resolved_by)}{r.resolution ? ` - ${r.resolution}` : ""}</div>}
              {moderating === r.id && r.target && <ModerationPanel uuid={r.target} name={nameOf(r.target)} onError={onError} />}
              <div className="report-actions">
                {r.status === "open" ? <>
                  {r.target && <button className="btn small" onClick={() => setModerating(moderating === r.id ? null : r.id)}>{moderating === r.id ? "Hide" : "Mute / ban…"}</button>}
                  {r.message_id && <button className="btn small danger" onClick={() => { if (confirm("Delete the message for everyone?")) void close(r, "resolved", { delete_message: true }); }}>Delete message</button>}
                  <span className="grow" />
                  <button className="btn small" onClick={() => void close(r, "dismissed")}>Dismiss</button>
                  <button className="btn small primary" onClick={() => { const note = prompt("What was done (optional)?") ?? ""; void close(r, "resolved", { resolution: note }); }}>Resolved</button>
                </> : <button className="btn small" onClick={() => void close(r, "open")}>Reopen</button>}
              </div>
            </div>
          );
        })}
    </div>
  </>;
}
