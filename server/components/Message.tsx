"use client";
// One message in a chat: who sent it, the text, files, link previews, reactions, the
// message it replies to, and the hover toolbar.
import { BotTag } from "./JaceBot";
import { useState } from "react";
import { timeLabel, type Attachment, type Embed, type Message, type Person, type ReplyPreview, type Role } from "@/lib/client";
import { EmojiPicker, QUICK_REACTIONS } from "./EmojiPicker";
import { Link, Markdown, jumboEmoji, type MentionInfo } from "./Markdown";
import { Avatar } from "./ui";

export type MessageActions = {
  reply?: () => void; edit?: () => void; remove?: () => void; pin?: () => void; unpin?: () => void;
  react: (emoji: string, on: boolean) => void; copyId?: () => void;
};

const fmtSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** A member's display: server nickname, and the color of their highest colored role. */
export function nameStyle(p: Person | undefined, roles: Role[]) {
  if (!p) return { name: "Someone", color: undefined as string | undefined };
  const mine = roles.filter((r) => p.roles?.includes(r.id) && r.color).sort((a, b) => b.position - a.position);
  return { name: p.nickname || p.name, color: mine[0]?.color ?? undefined };
}

function Files({ files, onImage }: { files: Attachment[]; onImage: (url: string) => void }) {
  const images = files.filter((f) => f.type.startsWith("image/"));
  const others = files.filter((f) => !f.type.startsWith("image/"));
  return (
    <div className="attachments">
      {images.length > 0 && (
        <div className={`image-grid n${Math.min(images.length, 4)}`}>
          {images.map((f) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={f.url} src={f.url} alt={f.name} loading="lazy" onClick={() => onImage(f.url)}
              style={f.width && f.height && images.length === 1 ? { aspectRatio: `${f.width} / ${f.height}` } : undefined} />
          ))}
        </div>
      )}
      {others.map((f) => f.type.startsWith("video/") ? <video key={f.url} src={f.url} controls preload="metadata" className="att-video" />
        : f.type.startsWith("audio/") ? <div key={f.url} className="att-file"><span>🎵 {f.name}</span><audio src={f.url} controls preload="none" /></div>
        : (
          <a key={f.url} className="att-file" href={f.url} target="_blank" rel="noopener noreferrer" download={f.name}>
            <span className="att-icon">📄</span>
            <span className="att-name"><b>{f.name}</b><span className="muted small">{fmtSize(f.size)}</span></span>
            <span className="muted">⬇</span>
          </a>
        ))}
    </div>
  );
}

function Embeds({ embeds, onImage }: { embeds: Embed[]; onImage: (url: string) => void }) {
  return (
    <>
      {embeds.map((e, i) => e.type === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={i} className="embed-image-only" src={e.image} alt="" loading="lazy" onClick={() => onImage(e.image!)} />
      ) : (
        <div key={i} className="embed" style={{ borderLeftColor: e.color ?? "var(--line2)" }}>
          {e.site && <div className="embed-site">{e.site}</div>}
          {e.title && <div className="embed-title"><Link href={e.url}>{e.title}</Link></div>}
          {e.description && <div className="embed-desc">{e.description}</div>}
          {e.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img className={e.type === "video" ? "embed-video" : "embed-image"} src={e.image} alt="" loading="lazy"
              onClick={() => e.type === "video" ? undefined : onImage(e.image!)} />
          )}
        </div>
      ))}
    </>
  );
}

export function MessageRow({ m, first, sender, mine, mentions, roles, reply, replySender, used, actions,
  showEmbeds, editing, onEditSave, onEditCancel, onImage, onOpenProfile, highlight }: {
  m: Message; first: boolean; sender: Person | undefined; mine: boolean; mentions: MentionInfo; roles: Role[];
  reply?: ReplyPreview | null; replySender?: Person; used?: Person; actions: MessageActions; showEmbeds: boolean;
  editing: boolean; onEditSave: (text: string) => void; onEditCancel: () => void; onImage: (url: string) => void;
  onOpenProfile: (uuid: string) => void; highlight?: boolean;
}) {
  const [picker, setPicker] = useState(false);
  const [draft, setDraft] = useState(m.body);
  const system = m.kind === "system";
  const ns = nameStyle(sender, roles);
  const pinged = !mine && !system && (m.mention_everyone || (mentions.me && m.mentions?.includes(mentions.me)));
  const command = m.components?.find((c) => c.type === "command");
  const showHead = first || !!reply || !!command;
  return (
    <div id={`m${m.id}`} className={`msg${showHead ? " first" : ""}${system ? " system" : ""}${pinged ? " pinged" : ""}${highlight ? " flash" : ""}`}>
      {reply !== undefined && !system && (
        <div className="reply-line" onClick={() => document.getElementById(`m${m.reply_to}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>
          {reply ? <><Avatar p={replySender ?? { name: "?" }} size={16} />
            <b style={{ color: nameStyle(replySender, roles).color }}>{nameStyle(replySender, roles).name}</b>
            <span className="muted">{reply.body || (reply.attachments ? "📎 a file" : "")}</span></>
            : <span className="muted">The original message was deleted</span>}
        </div>
      )}
      {command && <div className="reply-line command-line"><span className="muted">{used?.name ?? "Someone"} used</span> <b>/{command.name}</b></div>}
      <div className="av">
        {showHead && !system && <span onClick={() => m.sender && onOpenProfile(m.sender)} style={{ cursor: "pointer" }}><Avatar p={sender ?? { name: "?" }} size={40} /></span>}
        {system && <span className="muted" style={{ paddingLeft: 12 }}>→</span>}
        {!showHead && !system && <span className="hover-time">{new Date(m.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>}
      </div>
      <div style={{ minWidth: 0 }}>
        {showHead && !system && (
          <div className="meta">
            <b style={{ color: ns.color }} onClick={() => m.sender && onOpenProfile(m.sender)}>{ns.name}</b>
            <BotTag p={sender} />
            <span className="time">{timeLabel(m.created_at)}</span>
            {m.pinned_at && <span className="muted small" title="Pinned">📌</span>}
          </div>
        )}
        {editing ? (
          <div style={{ display: "grid", gap: 6 }}>
            <textarea rows={2} value={draft} autoFocus onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onEditSave(draft); }
                if (e.key === "Escape") onEditCancel();
              }} />
            <div className="small muted">Enter to save · Esc to <button className="icon-btn small" onClick={onEditCancel}>cancel</button></div>
          </div>
        ) : (
          m.body && <div className={`body${jumboEmoji(m.body) ? " jumbo" : ""}`}>
            <Markdown text={m.body} mentions={mentions} />{m.edited_at && <span className="edited">(edited)</span>}
          </div>
        )}
        {!!m.attachments?.length && <Files files={m.attachments} onImage={onImage} />}
        {showEmbeds && !!m.embeds?.length && <Embeds embeds={m.embeds} onImage={onImage} />}
        {!!m.reactions?.length && (
          <div className="reactions">
            {m.reactions.map((r) => (
              <button key={r.emoji} className={`reaction${r.me ? " me" : ""}`} onClick={() => actions.react(r.emoji, !r.me)}>
                <span>{r.emoji}</span> {r.count}
              </button>
            ))}
            <button className="reaction add" title="Add a reaction" onClick={() => setPicker(true)}>＋</button>
          </div>
        )}
      </div>
      {!system && !editing && (
        <div className="tools">
          {QUICK_REACTIONS.slice(0, 3).map((e) => <button key={e} className="icon-btn" title={`React ${e}`} onClick={() => actions.react(e, true)}>{e}</button>)}
          <button className="icon-btn" title="Add a reaction" onClick={() => setPicker(true)}>😀</button>
          {actions.reply && <button className="icon-btn" title="Reply" onClick={actions.reply}>↩</button>}
          {actions.edit && <button className="icon-btn" title="Edit" onClick={() => { setDraft(m.body); actions.edit!(); }}>✎</button>}
          {(actions.pin || actions.unpin) && <button className="icon-btn" title={m.pinned_at ? "Unpin" : "Pin"} onClick={m.pinned_at ? actions.unpin : actions.pin}>📌</button>}
          <button className="icon-btn" title="Copy text" onClick={() => navigator.clipboard?.writeText(m.body)}>⧉</button>
          {actions.copyId && <button className="icon-btn" title="Copy message ID" onClick={actions.copyId}>#</button>}
          {actions.remove && <button className="icon-btn danger" title="Delete" onClick={actions.remove}>🗑</button>}
        </div>
      )}
      {picker && <EmojiPicker style={{ right: 16, top: 24 }} onClose={() => setPicker(false)} onPick={(e) => { setPicker(false); actions.react(e, true); }} />}
    </div>
  );
}
