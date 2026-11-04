"use client";
// Create a server channel: its name and kind (text, announcement, forum, media, voice, stage), and
// which category it goes in. Forums get their tags in the channel's settings.
import { useState } from "react";
import { api, type Channel } from "@/lib/client";
import { Modal } from "./ui";

const KINDS: [string, string, string][] = [
  ["text", "# Text", "Messages, pictures, links"],
  ["announcement", "📣 Announcement", "Only moderators post; everyone reads"],
  ["forum", "💬 Forum", "Posts with titles and tags, each with its own conversation"],
  ["media", "🖼️ Media", "A forum where every post starts with a picture or video"],
  ["voice", "🔊 Voice", "Talk, video and share your screen (up to 8 people)"],
  ["stage", "🎙️ Stage", "Speakers talk, an audience listens and raises hands (up to 25)"],
];

export function NewChannelModal({ serverId, categories, parent, onClose, onDone, onError }: {
  serverId: string; categories: Channel[]; parent?: string | null; onClose: () => void; onDone: () => void; onError: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("text");
  const [cat, setCat] = useState(parent ?? "");
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    try {
      await api(`/servers/${serverId}/channels`, { body: { name, kind, parent_id: cat || null, private: priv } });
      onDone();
    } catch (e) { onError((e as Error).message); setBusy(false); }
  }
  return (
    <Modal onClose={onClose}>
      <div className="modal-body">
        <h2>Create a channel</h2>
        <div className="channel-kinds">
          {KINDS.map(([k, label, desc]) => (
            <label key={k} className={`channel-kind${kind === k ? " on" : ""}`}>
              <input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} />
              <span><b>{label}</b><span className="muted small">{desc}</span></span>
            </label>
          ))}
        </div>
        <input placeholder={kind === "voice" || kind === "stage" ? "Name" : "new-channel"} maxLength={48} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        {categories.length > 0 && (
          <select value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">No category</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <label className="check small"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Private (only you, and roles you add in its settings)</label>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !name.trim()} onClick={create}>Create</button>
      </div>
    </Modal>
  );
}
