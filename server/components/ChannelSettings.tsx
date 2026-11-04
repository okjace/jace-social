"use client";
// Channel settings: name, topic, slowmode, category, user limit (voice) and permissions
// for roles or members (allow / deny / inherit).
import { useState } from "react";
import { api, type Channel, type ForumTag, type Override, type ServerDetail } from "@/lib/client";
import { ALL, has, P } from "@/lib/permbits";
import { PermissionList } from "./ServerSettings";
import { Modal } from "./ui";

const SLOWMODE: [number, string][] = [[0, "Off"], [5, "5 seconds"], [10, "10 seconds"], [30, "30 seconds"], [60, "1 minute"],
  [300, "5 minutes"], [900, "15 minutes"], [3600, "1 hour"], [21600, "6 hours"]];

export function ChannelSettings({ detail, channel, onClose, onChanged, onError }: {
  detail: ServerDetail; channel: Channel; onClose: () => void; onChanged: () => void; onError: (m: string) => void;
}) {
  const [tab, setTab] = useState<"general" | "permissions">("general");
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [slowmode, setSlowmode] = useState(channel.slowmode ?? 0);
  const [limit, setLimit] = useState(channel.user_limit ?? 0);
  const [parent, setParent] = useState(channel.parent_id ?? "");
  const [tags, setTags] = useState<ForumTag[]>(channel.available_tags ?? []);      // forums and media channels
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); onChanged(); return true; } catch (e) { onError((e as Error).message); return false; } };
  const categories = detail.channels.filter((c) => c.kind === "category");
  const kind = channel.kind ?? "text";
  const canRoles = has(detail.perms, P.MANAGE_ROLES);

  const overrides = detail.overrides.filter((o) => o.channel_id === channel.id);
  const everyone = detail.roles.find((r) => r.is_default)!;
  const targets: { type: "role" | "member"; id: string; label: string; color?: string | null }[] = [
    ...overrides.map((o) => o.target_type === "role"
      ? { type: "role" as const, id: o.target_id, label: detail.roles.find((r) => r.id === o.target_id)?.name ?? "deleted role", color: detail.roles.find((r) => r.id === o.target_id)?.color }
      : { type: "member" as const, id: o.target_id, label: detail.members.find((m) => m.uuid === o.target_id)?.name ?? "someone" }),
  ];
  if (!targets.some((t) => t.type === "role" && t.id === everyone.id)) targets.unshift({ type: "role", id: everyone.id, label: "@everyone" });
  const [sel, setSel] = useState(0);
  const target = targets[Math.min(sel, targets.length - 1)];
  const current: Override = overrides.find((o) => o.target_type === target.type && o.target_id === target.id)
    ?? { channel_id: channel.id, target_type: target.type, target_id: target.id, allow: 0, deny: 0 };
  const [draft, setDraft] = useState<{ allow: number; deny: number } | null>(null);
  const shown = draft ?? current;
  const isPrivate = !!overrides.find((o) => o.target_type === "role" && o.target_id === everyone.id && (o.deny & P.VIEW));

  return (
    <Modal onClose={onClose} wide>
      <div className="settings">
        <nav>
          <div className="side-label" style={{ paddingTop: 4 }}>{kind === "category" ? channel.name : `${({ voice: "🔊", stage: "🎙️", forum: "💬", media: "🖼️", announcement: "📣" } as Record<string, string>)[kind] ?? "#"} ${channel.name}`}</div>
          <button className={`side-item${tab === "general" ? " active" : ""}`} onClick={() => setTab("general")}>General</button>
          {canRoles && <button className={`side-item${tab === "permissions" ? " active" : ""}`} onClick={() => setTab("permissions")}>Permissions</button>}
          <button className="side-item" style={{ color: "var(--red)" }} onClick={async () => {
            if (!confirm(kind === "category" ? `Delete the ${channel.name} category? Its channels stay.` : `Delete ${channel.name} and all its messages?`)) return;
            if (await run(() => api(`/channels/${channel.id}`, { method: "DELETE" }))) onClose();
          }}>Delete {kind === "category" ? "category" : "channel"}</button>
        </nav>
        <div className="modal-body">
          {tab === "general" ? <>
            <h2>{kind === "category" ? "Category" : "Channel"} settings</h2>
            <label>Name<input value={name} maxLength={48} onChange={(e) => setName(e.target.value)} /></label>
            {kind !== "category" && kind !== "voice" && <label>Topic<textarea rows={2} value={topic} maxLength={200} onChange={(e) => setTopic(e.target.value)} /></label>}
            {(kind === "forum" || kind === "media") && (
              <div className="forum-tags-edit">
                <span>Tags people can put on posts (up to 20)</span>
                {tags.map((t, i) => (
                  <div key={t.id} className="forum-tag-row">
                    <input className="tag-emoji" placeholder="🙂" maxLength={4} value={t.emoji ?? ""} onChange={(e) => setTags(tags.map((x, j) => (j === i ? { ...x, emoji: e.target.value } : x)))} />
                    <input placeholder="Tag name" maxLength={24} value={t.name} onChange={(e) => setTags(tags.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                    <button className="icon-btn" title="Remove tag" onClick={() => setTags(tags.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}
                {tags.length < 20 && <button className="btn small" onClick={() => setTags([...tags, { id: `n${Date.now().toString(36)}`.slice(0, 12), name: "", emoji: null }])}>＋ Add a tag</button>}
              </div>
            )}
            {kind !== "category" && kind !== "voice" && kind !== "stage" && kind !== "forum" && kind !== "media" && (
              <label>Slowmode (time between someone's messages)
                <select value={slowmode} onChange={(e) => setSlowmode(Number(e.target.value))}>{SLOWMODE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </label>
            )}
            {kind === "voice" && (
              <label>User limit: {limit === 0 ? "none" : limit}
                <input type="range" min={0} max={8} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
              </label>
            )}
            {kind !== "category" && (
              <label>Category
                <select value={parent} onChange={(e) => setParent(e.target.value)}>
                  <option value="">No category</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
            <button className="btn primary" style={{ justifySelf: "start" }} onClick={() => void run(() => api(`/channels/${channel.id}`, { method: "PATCH",
              body: { name, topic, slowmode, user_limit: limit, parent_id: kind === "category" ? undefined : parent || null,
                ...((kind === "forum" || kind === "media") ? { available_tags: tags.filter((t) => t.name.trim()) } : {}) } }))}>Save</button>
          </> : <>
            <h2>Permissions</h2>
            <label className="check">
              <input type="checkbox" checked={isPrivate} onChange={(e) => {
                const o = overrides.find((x) => x.target_type === "role" && x.target_id === everyone.id) ?? { allow: 0, deny: 0 };
                const deny = e.target.checked ? o.deny | P.VIEW : o.deny & ~P.VIEW;
                void run(() => api(`/channels/${channel.id}/overrides`, { method: "PUT", body: { target_type: "role", target_id: everyone.id, allow: o.allow & ~P.VIEW, deny } }));
              }} />
              Private: only the roles and members below can see it
            </label>
            <div className="override-targets">
              {targets.map((t, i) => (
                <button key={`${t.type}${t.id}`} className={`chip${i === sel ? " on" : ""}`} onClick={() => { setSel(i); setDraft(null); }}>
                  {t.type === "role" ? <span className="role-dot" style={{ background: t.color ?? "var(--gray)" }} /> : "👤"} {t.label}</button>
              ))}
              <select className="btn small" value="" onChange={(e) => {
                const [type, id] = e.target.value.split(":");
                if (!id) return;
                void run(() => api(`/channels/${channel.id}/overrides`, { method: "PUT", body: { target_type: type, target_id: id, allow: 0, deny: 0 } }))
                  .then(() => setSel(targets.length));
              }}>
                <option value="">＋ Add role or member</option>
                <optgroup label="Roles">{detail.roles.filter((r) => !r.is_default && !targets.some((t) => t.id === r.id)).map((r) => <option key={r.id} value={`role:${r.id}`}>{r.name}</option>)}</optgroup>
                <optgroup label="Members">{detail.members.filter((m) => !targets.some((t) => t.id === m.uuid)).map((m) => <option key={m.uuid} value={`member:${m.uuid}`}>{m.nickname || m.name}</option>)}</optgroup>
              </select>
            </div>
            <PermissionList value={0} onChange={() => {}} editable={detail.owner ? ALL : detail.perms}
              allowedBits={kind === "voice" || kind === "stage" ? P.VIEW | P.CONNECT | P.SPEAK | P.STREAM | P.MANAGE_CHANNELS | P.MANAGE_ROLES : kind === "category" ? undefined : ALL & ~(P.CONNECT | P.SPEAK | P.STREAM)}
              tri={{ allow: shown.allow, deny: shown.deny, set: (allow, deny) => setDraft({ allow, deny }) }} />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn primary" disabled={!draft} onClick={async () => {
                if (await run(() => api(`/channels/${channel.id}/overrides`, { method: "PUT", body: { target_type: target.type, target_id: target.id, ...draft } }))) setDraft(null);
              }}>Save</button>
              {!(target.type === "role" && target.id === everyone.id) && overrides.some((o) => o.target_id === target.id) && (
                <button className="btn danger" onClick={() => void run(() => api(`/channels/${channel.id}/overrides?target_type=${target.type}&target_id=${target.id}`, { method: "DELETE" })).then(() => setSel(0))}>Remove</button>
              )}
            </div>
          </>}
        </div>
      </div>
      <div className="modal-foot"><button className="btn" onClick={onClose}>Done</button></div>
    </Modal>
  );
}
