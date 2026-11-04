"use client";
// A forum or media channel (server: lib/forums.ts): its posts - pinned first, then the most recently
// active (or newest) - with tags to filter by and a search; "New post" (a title, tags and the first
// message; a media channel's needs a picture or video); and one post open, with its conversation
// (the normal chat), and its title, tags, lock, pin, delete and report.
import { useEffect, useState } from "react";
import { api, timeLabel, uploadAttachment, type Attachment, type ForumTag, type Me, type Person, type Role, type Settings } from "@/lib/client";
import { Chat } from "./Chat";
import { ReportModal } from "./Moderation";
import { Avatar, Modal } from "./ui";

type Post = {
  id: string; title: string; tags: string[]; author: Person | null; preview: string | null; image: string | null;
  locked: boolean; pinned: boolean; messages: number; created_at: string; last_activity: string; new: boolean;
};
type ForumData = {
  forum: { id: string; name: string; kind: "forum" | "media"; topic: string | null; available_tags: ForumTag[]; server_id: string };
  can_post: boolean; can_moderate: boolean; posts: Post[];
};

export function Forum({ forumId, me, people, roles, settings, reloadKey, onOpenProfile, onError, back }: {
  forumId: string; me: Me; people: Record<string, Person>; roles: Role[]; settings: Settings; reloadKey: number;
  onOpenProfile: (uuid: string) => void; onError: (m: string) => void; back: () => void;
}) {
  const [data, setData] = useState<ForumData | null>(null);
  const [sort, setSort] = useState<"active" | "new">("active");
  const [tag, setTag] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const load = () => api<ForumData>(`/channels/${forumId}/posts?sort=${sort}${tag ? `&tag=${tag}` : ""}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`)
    .then(setData).catch((e) => onError(e.message));
  useEffect(() => { setOpen(null); }, [forumId]);
  useEffect(() => { const t = setTimeout(() => void load(), q ? 250 : 0); return () => clearTimeout(t); }, [forumId, sort, tag, q, reloadKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <div className="empty">Loading…</div>;
  const tags = data.forum.available_tags;
  const tagName = (id: string) => { const t = tags.find((x) => x.id === id); return t ? `${t.emoji ? `${t.emoji} ` : ""}${t.name}` : null; };
  const post = open ? data.posts.find((p) => p.id === open) : null;
  if (open && post) return <PostView post={post} data={data} me={me} people={people} roles={roles} settings={settings} reloadKey={reloadKey}
    tagName={tagName} onOpenProfile={onOpenProfile} onError={onError} back={() => { setOpen(null); void load(); }} reload={load} />;
  return <>
    <div className="main-head">
      <button className="icon-btn mobile-only" onClick={back}>←</button>
      <span className="hash">{data.forum.kind === "media" ? "🖼️" : "💬"}</span><span className="title">{data.forum.name}</span>
      {data.forum.topic ? <span className="topic">{data.forum.topic}</span> : <span className="spacer" />}
    </div>
    <div className="forum">
      <div className="forum-bar">
        {data.can_post && <button className="btn primary" onClick={() => setComposing(true)}>＋ New post</button>}
        <input className="grow" placeholder="Search posts" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={sort} onChange={(e) => setSort(e.target.value as "active" | "new")}>
          <option value="active">Recently active</option><option value="new">Newest</option>
        </select>
      </div>
      {tags.length > 0 && (
        <div className="chips">
          {tags.map((t) => <button key={t.id} className={`chip tag-chip${tag === t.id ? " on" : ""}`} onClick={() => setTag(tag === t.id ? null : t.id)}>{t.emoji} {t.name}</button>)}
        </div>
      )}
      <div className={`forum-posts${data.forum.kind === "media" ? " media" : ""}`}>
        {data.posts.length === 0 && <p className="muted">{tag || q ? "No posts match." : data.can_post ? "No posts yet - start the first one." : "No posts yet."}</p>}
        {data.posts.map((p) => (
          <button key={p.id} className={`forum-post${p.new ? " new" : ""}`} onClick={() => setOpen(p.id)}>
            {p.image && <img className="forum-thumb" src={p.image} alt="" loading="lazy" />}
            <span className="forum-post-main">
              <span className="forum-title">{p.pinned && "📌 "}{p.locked && "🔒 "}{p.title}</span>
              {p.tags.length > 0 && <span className="chips">{p.tags.map((t) => tagName(t) && <span key={t} className="chip small">{tagName(t)}</span>)}</span>}
              {p.preview && <span className="forum-preview">{p.preview}</span>}
              <span className="muted small forum-meta">
                {p.author && <><Avatar p={p.author} size={16} /> {p.author.name} · </>}
                💬 {Math.max(0, p.messages - 1)} · {timeLabel(p.last_activity)}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
    {composing && <NewPost data={data} me={me} onClose={() => setComposing(false)} onError={onError}
      onDone={(id) => { setComposing(false); void load().then(() => setOpen(id)); }} />}
  </>;
}

function NewPost({ data, me, onClose, onDone, onError }: { data: ForumData; me: Me; onClose: () => void; onDone: (id: string) => void; onError: (m: string) => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const media = data.forum.kind === "media";
  async function attach(list: FileList | null) {
    for (const f of [...(list ?? [])].slice(0, 4)) {
      setBusy(true);
      try { const a = await uploadAttachment(me.realtime, f); setFiles((x) => [...x, a]); } catch (e) { onError(`Couldn't upload ${f.name}: ${(e as Error).message}`); }
      finally { setBusy(false); }
    }
  }
  async function post() {
    setBusy(true);
    try {
      const r = await api<{ post: { id: string } }>(`/channels/${data.forum.id}/posts`, { body: { title, body, tags, attachments: files } });
      onDone(r.post.id);
    } catch (e) { onError((e as Error).message); setBusy(false); }
  }
  const visual = files.some((f) => /^(image|video)\//.test(f.type));
  return (
    <Modal onClose={onClose} wide>
      <div className="modal-body">
        <h2>New post in {data.forum.name}</h2>
        <input placeholder="Title" maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        {data.forum.available_tags.length > 0 && (
          <div className="chips">
            {data.forum.available_tags.map((t) => (
              <button key={t.id} className={`chip tag-chip${tags.includes(t.id) ? " on" : ""}`}
                onClick={() => setTags(tags.includes(t.id) ? tags.filter((x) => x !== t.id) : tags.length < 5 ? [...tags, t.id] : tags)}>{t.emoji} {t.name}</button>
            ))}
          </div>
        )}
        <textarea rows={6} maxLength={2000} placeholder={media ? "Say something about it (optional)" : "What's it about?"} value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="chips">
          {files.map((f) => <span key={f.url} className="chip">📎 {f.name} <button className="icon-btn small" onClick={() => setFiles(files.filter((x) => x !== f))}>✕</button></span>)}
          <label className="btn small">{media ? "Add a picture or video" : "Attach files"}<input type="file" hidden multiple accept={media ? "image/*,video/*" : undefined} onChange={(e) => void attach(e.target.files)} /></label>
        </div>
        {media && !visual && <p className="muted small">Posts here start with a picture or video.</p>}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !title.trim() || (media ? !visual : !body.trim() && !files.length)} onClick={post}>Post</button>
      </div>
    </Modal>
  );
}

function PostView({ post, data, me, people, roles, settings, reloadKey, tagName, onOpenProfile, onError, back, reload }: {
  post: Post; data: ForumData; me: Me; people: Record<string, Person>; roles: Role[]; settings: Settings; reloadKey: number;
  tagName: (id: string) => string | null; onOpenProfile: (uuid: string) => void; onError: (m: string) => void; back: () => void; reload: () => void;
}) {
  const [reporting, setReporting] = useState(false);
  const mine = post.author?.uuid === me.uuid;
  const change = async (b: Record<string, unknown>) => {
    try { await api(`/channels/${post.id}`, { method: "PATCH", body: b }); reload(); } catch (e) { onError((e as Error).message); }
  };
  return <>
    <div className="main-head">
      <button className="icon-btn" title="Back to the forum" onClick={back}>←</button>
      <span className="title">{post.pinned && "📌 "}{post.locked && "🔒 "}{post.title}</span>
      <span className="topic">{post.tags.map(tagName).filter(Boolean).join(" · ")}</span>
      {(mine || data.can_moderate) && <button className="icon-btn" title="Rename" onClick={() => { const t = prompt("Title", post.title); if (t?.trim()) void change({ title: t }); }}>✎</button>}
      {data.can_moderate && <>
        <button className="icon-btn" title={post.pinned ? "Unpin" : "Pin to the top"} onClick={() => void change({ pinned: !post.pinned })}>📌</button>
        <button className="icon-btn" title={post.locked ? "Unlock" : "Lock (no new replies)"} onClick={() => void change({ locked: !post.locked })}>{post.locked ? "🔓" : "🔒"}</button>
      </>}
      {(mine || data.can_moderate) && <button className="icon-btn danger" title="Delete post" onClick={async () => {
        if (!confirm(`Delete "${post.title}" and its replies?`)) return;
        try { await api(`/channels/${post.id}`, { method: "DELETE" }); back(); } catch (e) { onError((e as Error).message); }
      }}>🗑</button>}
      {!mine && <button className="icon-btn" title="Report this post" onClick={() => setReporting(true)}>🚩</button>}
    </div>
    <Chat target={{ kind: "channel", id: post.id, name: post.title, isServer: true }} me={me} people={people} roles={roles}
      reloadKey={reloadKey} onOpenProfile={onOpenProfile} onError={onError} settings={settings}
      placeholder={post.locked && !data.can_moderate ? "This post is locked" : `Reply to "${post.title}"`} />
    {reporting && <ReportModal target={{ kind: "post", channel_id: post.id, name: post.title }} onClose={() => setReporting(false)} onError={onError} />}
  </>;
}
