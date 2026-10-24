"use client";
// Settings -> Sounds: your ringtone and calling sound - a built-in one, one you uploaded, or one from
// the community library - plus uploading and sharing your own (lib/sounds.ts, app/api/v1/sounds).
import { useEffect, useRef, useState } from "react";
import { api, type Me, type Settings } from "@/lib/client";
import { BUILTIN, DEFAULT_SOUND, previewSound, type SoundKind } from "@/lib/sounds";

type Sound = { id: string; owner: string; name: string; kind: SoundKind; url: string; public: boolean; uses: number; by?: string };
const KINDS: [SoundKind, string, string][] = [
  ["ringtone", "Ringtone", "When someone calls you"],
  ["calling", "Calling sound", "While you're calling someone"],
];
const settingKey = (k: SoundKind) => (k === "ringtone" ? "ringtone" : "calling_sound") as "ringtone" | "calling_sound";

export function SoundSettings({ me, s, set, onError }: {
  me: Me; s: Settings; set: (p: Settings) => Promise<void>; onError: (m: string) => void;
}) {
  const [mine, setMine] = useState<Sound[]>([]);
  const [community, setCommunity] = useState<Sound[] | null>(null);
  const [libKind, setLibKind] = useState<SoundKind>("ringtone");
  const [q, setQ] = useState("");
  const playing = useRef<{ stop: () => void } | null>(null);
  const loadMine = () => api<{ sounds: Sound[] }>("/sounds?mine=1").then((r) => setMine(r.sounds)).catch((e) => onError(e.message));
  const loadCommunity = () => api<{ sounds: Sound[] }>(`/sounds?kind=${libKind}&q=${encodeURIComponent(q.trim())}`)
    .then((r) => setCommunity(r.sounds)).catch(() => setCommunity([]));
  useEffect(() => { void loadMine(); return () => playing.current?.stop(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(() => void loadCommunity(), 250); return () => clearTimeout(t); }, [libKind, q]);   // eslint-disable-line react-hooks/exhaustive-deps

  const preview = (choice: string, kind: SoundKind) => { playing.current?.stop(); playing.current = previewSound(choice, kind); };
  const choose = (kind: SoundKind, choice: string) => void set({ [settingKey(kind)]: choice } as Settings);
  const current = (kind: SoundKind) => s[settingKey(kind)] || DEFAULT_SOUND[kind];

  async function upload(kind: SoundKind, file: File) {
    const name = (prompt("Name this sound:", file.name.replace(/\.[^.]+$/, "").slice(0, 40)) ?? "").trim();
    if (!name) return;
    const share = confirm("Share it in the community library, so anyone can use it? (You can change this later.)");
    try {
      const r = await api<{ sound: Sound }>(`/sounds?name=${encodeURIComponent(name)}&kind=${kind}&public=${share ? 1 : 0}`, { raw: file });
      await loadMine();
      choose(kind, r.sound.url);
      if (share) void loadCommunity();
    } catch (e) { onError((e as Error).message); }
  }

  const row = (kind: SoundKind, choice: string, label: React.ReactNode, extra?: React.ReactNode) => (
    <div key={choice} className={`sound-row${current(kind) === choice ? " on" : ""}`}>
      <label className="sound-pick"><input type="radio" name={kind} checked={current(kind) === choice} onChange={() => choose(kind, choice)} /> {label}</label>
      {choice !== "builtin:none" && <button className="icon-btn" title="Listen" onClick={() => preview(choice, kind)}>▶</button>}
      {extra}
    </div>
  );

  return <>
    <h2>Sounds</h2>
    {KINDS.map(([kind, title, desc]) => {
      const cur = current(kind);
      const fromLibrary = /^https?:/.test(cur) && !mine.some((m) => m.url === cur);
      return (
        <div key={kind} className="card" style={{ display: "grid", gap: 6 }}>
          <b>{title}</b><span className="muted small">{desc}</span>
          <div className="sound-list">
            {BUILTIN.map((b) => row(kind, `builtin:${b.id}`, b.name))}
            {mine.filter((m) => m.kind === kind).map((m) => row(kind, m.url, <>{m.name} <span className="muted small">(yours)</span></>, <>
              <label className="check small" title="In the community library"><input type="checkbox" checked={m.public}
                onChange={async (e) => { try { await api(`/sounds/${m.id}`, { method: "PATCH", body: { public: e.target.checked } }); await loadMine(); void loadCommunity(); } catch (err) { onError((err as Error).message); } }} /> Shared</label>
              <button className="icon-btn" title="Delete" onClick={async () => {
                if (!confirm(`Delete "${m.name}"?`)) return;
                try { await api(`/sounds/${m.id}`, { method: "DELETE" }); if (current(kind) === m.url) choose(kind, DEFAULT_SOUND[kind]); await loadMine(); void loadCommunity(); }
                catch (err) { onError((err as Error).message); }
              }}>🗑</button>
            </>))}
            {fromLibrary && row(kind, cur, <>A sound from the community library</>)}
            {row(kind, "builtin:none", "Silent")}
          </div>
          <label className="btn small" style={{ justifySelf: "start", margin: 0 }}>⬆ Upload a {kind === "ringtone" ? "ringtone" : "calling sound"}
            <input type="file" hidden accept="audio/mpeg,audio/ogg,audio/wav,audio/x-wav,audio/webm,audio/mp4,audio/aac,audio/x-m4a,.mp3,.ogg,.wav,.m4a,.aac,.webm"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(kind, f); }} /></label>
          <span className="muted small">MP3, OGG, WAV or M4A, up to 1 MB. It loops while ringing, so a short clip works best.</span>
        </div>
      );
    })}

    <h2 style={{ marginTop: 8 }}>Community sounds</h2>
    <p className="muted small" style={{ margin: 0 }}>Ringtones and calling sounds people shared. Tap ▶ to listen, then Use.</p>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {KINDS.map(([k, title]) => <button key={k} className={`tab${libKind === k ? " active" : ""}`} onClick={() => setLibKind(k)}>{title}s</button>)}
      <input value={q} placeholder="Search sounds" maxLength={40} style={{ flex: 1, minWidth: 140 }} onChange={(e) => setQ(e.target.value)} />
    </div>
    <div className="sound-list">
      {community === null ? <p className="muted">Loading…</p> : community.length === 0 ? <p className="muted small">No shared sounds here yet - upload one above and share it!</p>
        : community.map((c) => (
          <div key={c.id} className={`sound-row${current(libKind) === c.url ? " on" : ""}`}>
            <span className="sound-pick"><b>{c.name}</b> <span className="muted small">by {c.by} · used {c.uses}×</span></span>
            <button className="icon-btn" title="Listen" onClick={() => preview(c.url, libKind)}>▶</button>
            <button className="btn small primary" disabled={current(libKind) === c.url} onClick={async () => {
              try { const r = await api<{ url: string }>(`/sounds/${c.id}`, { body: { action: "use" } }); choose(libKind, r.url); void loadCommunity(); }
              catch (e) { onError((e as Error).message); }
            }}>{current(libKind) === c.url ? "In use" : "Use"}</button>
            {me.jace_staff && c.owner !== me.uuid && <button className="icon-btn" title="Remove from the library (moderation)" onClick={async () => {
              if (!confirm(`Remove "${c.name}" for everyone?`)) return;
              try { await api(`/sounds/${c.id}`, { method: "DELETE" }); void loadCommunity(); } catch (e) { onError((e as Error).message); }
            }}>🗑</button>}
          </div>
        ))}
    </div>
  </>;
}
