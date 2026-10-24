"use client";
// One conversation: a direct message, a group chat or a server channel.
import { createClient } from "@supabase/supabase-js";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, type Attachment, type Command, type Me, type Message, type Person, type ReplyPreview, type Role, type Settings } from "@/lib/client";
import { has, P } from "@/lib/permbits";
import { EmojiPicker } from "./EmojiPicker";
import { MessageRow, nameStyle } from "./Message";
import { Avatar, Modal } from "./ui";

export type ChatTarget =
  | { kind: "dm"; uuid: string; name: string }
  | { kind: "channel"; id: string; name: string; isServer: boolean; slowmode?: number; announcement?: boolean };

type Upload = { id: string; file: File; progress: "uploading" | "done" | "error"; att?: Attachment; preview?: string };

const DM_PERMS = P.VIEW | P.SEND | P.ATTACH | P.REACT;

/** A picture, video or sound: shown in the chat unless sent without a preview. */
const previewable = (f: Attachment) => /^(image|video|audio)\//.test(f.type);

export function Chat({ target, me, people, roles = [], perms, reloadKey, onOpenProfile, onError, placeholder, settings, typing = [], showPins, onClosePins }: {
  target: ChatTarget; me: Me; people: Record<string, Person>; roles?: Role[]; perms?: number; reloadKey: number;
  onOpenProfile: (uuid: string) => void; onError: (msg: string) => void; placeholder: string; settings: Settings;
  typing?: string[]; showPins?: boolean; onClosePins?: () => void;
}) {
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [senders, setSenders] = useState<Record<string, Person>>({});
  const [replies, setReplies] = useState<Record<number, ReplyPreview>>({});
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  // "Show previews?" before sending a link or a picture/video/sound
  const [ask, setAsk] = useState<null | { body: string; files: Attachment[]; reply?: number; hasLink: boolean; hasMedia: boolean;
    links: boolean; media: boolean; remember: boolean }>(null);
  const prefs = useRef<Settings>({});                 // "don't ask again" this session, before settings reload
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [emoji, setEmoji] = useState(false);
  const [commands, setCommands] = useState<Command[]>([]);
  const [command, setCommand] = useState<{ cmd: Command; args: Record<string, string> } | null>(null);
  const [suggest, setSuggest] = useState(0);
  const [drag, setDrag] = useState(false);
  const [pins, setPins] = useState<Message[] | null>(null);
  const picked = useRef<Record<string, string>>({});          // "@Name" -> "<@id>" chosen from suggestions
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const lastTyping = useRef(0);
  const key = target.kind === "dm" ? `dm:${target.uuid}` : `ch:${target.id}`;
  const can = perms ?? DM_PERMS;
  const isChannel = target.kind === "channel";
  const scope = isChannel ? "c" : "d";

  async function load(before?: number) {
    try {
      if (target.kind === "dm") {
        const d = await api<{ messages: Message[]; replies?: Record<number, ReplyPreview> }>(`/messages?with=${target.uuid}${before ? `&before=${before}` : ""}`);
        setMsgs((old) => (before ? [...d.messages, ...old] : d.messages));
        setReplies((r) => ({ ...r, ...(d.replies ?? {}) }));
        setMore(d.messages.length === 50);
        if (!before) await api("/messages/read", { body: { with: target.uuid } }).catch(() => {});
      } else {
        const d = await api<{ messages: Message[]; people: Record<string, Person>; replies?: Record<number, ReplyPreview> }>(
          `/channels/${target.id}/messages${before ? `?before=${before}` : ""}`);
        setMsgs((old) => (before ? [...d.messages, ...old] : d.messages));
        setSenders((s) => ({ ...s, ...d.people }));
        setReplies((r) => ({ ...r, ...(d.replies ?? {}) }));
        setMore(d.messages.length === 50);
        if (!before) await api(`/channels/${target.id}/read`, { body: {} }).catch(() => {});
      }
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setMsgs([]); setLoading(true); setReplyTo(null); setEditing(null); setUploads([]); setCommand(null); setText("");
    stick.current = true; void load();
    commandsAt.current = 0;
    setCommands([]);
    loadCommands();
  }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps

  // the slash commands of the bots here: when the chat opens, and again when you type "/"
  // (a bot may have been added since), at most every 5 seconds
  const commandsAt = useRef(0);
  function loadCommands() {
    if (target.kind !== "channel" || Date.now() - commandsAt.current < 5000) return;
    commandsAt.current = Date.now();
    const id = target.id;
    api<{ commands: Command[] }>(`/channels/${id}/commands`)
      .then((d) => { if (target.kind === "channel" && target.id === id) setCommands(d.commands); })
      .catch(() => {});
  }
  useEffect(() => { if (text === "/") loadCommands(); }, [text]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (reloadKey) void load(); }, [reloadKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [msgs]);
  useEffect(() => {
    if (!showPins || target.kind !== "channel") { setPins(null); return; }
    api<{ messages: Message[]; people: Record<string, Person> }>(`/channels/${target.id}/pins`)
      .then((d) => { setPins(d.messages); setSenders((s) => ({ ...s, ...d.people })); }).catch((e) => onError(e.message));
  }, [showPins, key, reloadKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const who = (uuid: string | null | undefined): Person | undefined =>
    uuid ? (uuid === me.uuid ? { ...me, ...(people[me.uuid] ?? {}) } : people[uuid] ?? senders[uuid]) : undefined;
  const mentionInfo = useMemo(() => ({ people: { ...senders, ...people }, roles, me: me.uuid, onPerson: onOpenProfile }),
    [senders, people, roles, me.uuid, onOpenProfile]);

  // ------------------------------------------------------------------ uploads
  async function addFiles(files: FileList | File[]) {
    if (!has(can, P.ATTACH)) return onError("You can't attach files here");
    const list = [...files].slice(0, 10 - uploads.length);
    for (const file of list) {
      if (file.size > 500 * 1024 * 1024) { onError(`${file.name} is bigger than 500 MB`); continue; }   // (the server says the real limit)
      const id = Math.random().toString(36).slice(2);
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      setUploads((u) => [...u, { id, file, progress: "uploading", preview }]);
      try {
        const type = file.type || "application/octet-stream";
        // the server picks the storage service (lib/storage.ts): Supabase, or a signed URL on R2 / B2
        const s = await api<{ provider: string; url: string; upload_url: string; path?: string; token?: string; headers?: Record<string, string> }>(
          "/uploads", { body: { name: file.name, type, size: file.size } });
        if (s.provider === "supabase") {
          const sb = createClient(me.realtime.url, me.realtime.key, { auth: { persistSession: false } });
          const { error } = await sb.storage.from("attachments").uploadToSignedUrl(s.path!, s.token!, file, { contentType: type });
          if (error) throw new Error(error.message);
        } else {
          const r = await fetch(s.upload_url, { method: "PUT", headers: s.headers ?? { "Content-Type": type }, body: file });
          if (!r.ok) throw new Error(`storage answered ${r.status}`);
        }
        let dims: { width?: number; height?: number } = {};
        if (preview) dims = await new Promise((ok) => { const img = new Image(); img.onload = () => ok({ width: img.naturalWidth, height: img.naturalHeight }); img.onerror = () => ok({}); img.src = preview; });
        const att: Attachment = { url: s.url, name: file.name, type: file.type || "application/octet-stream", size: file.size, ...dims };
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: "done", att } : x)));
      } catch (e) {
        onError(`Couldn't upload ${file.name}: ${(e as Error).message}`);
        setUploads((u) => u.filter((x) => x.id !== id));
      }
    }
  }

  // ------------------------------------------------------------------ sending
  function withMentionIds(body: string) {
    let out = body;
    for (const [label, token] of Object.entries(picked.current)) out = out.split(label).join(token);
    return out;
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (command) return runCommand();
    const body = withMentionIds(text.trim());
    const files = uploads.filter((u) => u.progress === "done").map((u) => u.att!);
    if (uploads.some((u) => u.progress === "uploading")) return onError("Wait for the files to finish uploading");
    if (!body && !files.length) return;
    if (body.startsWith("/") && commands.length) {
      const name = body.slice(1).split(/\s+/)[0];
      const cmd = commands.find((c) => c.name === name);
      if (cmd) { setText(""); return runCommand(cmd, body.slice(name.length + 2)); }
    }
    const reply = replyTo?.id;
    // a link or a picture/video/sound in it: ask whether to show previews (Settings -> Links & privacy)
    const s = { ...(settings ?? me.settings ?? {}), ...prefs.current };
    const hasLink = /https?:\/\/\S+\.\S+/i.test(body);
    const hasMedia = files.some(previewable);
    if (s.preview_ask !== false && (hasLink || hasMedia)) {
      setAsk({ body, files, reply, hasLink, hasMedia, links: s.preview_links !== false, media: s.preview_files !== false, remember: false });
      return;
    }
    await deliver(body, files, reply, { links: s.preview_links !== false, media: s.preview_files !== false });
  }

  /** Send it, with or without previews for its links and files. */
  async function deliver(body: string, files: Attachment[], reply: number | undefined, show: { links: boolean; media: boolean }) {
    setText(""); setReplyTo(null); setUploads([]); picked.current = {};
    stick.current = true;
    try {
      const attachments = show.media ? files : files.map((f) => (previewable(f) ? { ...f, no_preview: true } : f));
      const payload = { body, reply_to: reply, attachments, ...(show.links ? {} : { no_embed: true }) };
      if (target.kind === "dm") await api("/messages", { body: { to: target.uuid, ...payload } });
      else await api(`/channels/${target.id}/messages`, { body: payload });
      await load();
    } catch (err) {
      setText(body);
      onError((err as Error).message);
    }
  }

  async function runCommand(c?: Command, rest?: string) {
    const cmd = c ?? command!.cmd;
    const args = c ? (cmd.options[0] ? { [cmd.options[0].name]: rest ?? "" } : {}) : command!.args;
    const missing = cmd.options.find((o) => o.required && !String(args[o.name] ?? "").trim());
    if (missing) return onError(`Fill in ${missing.name}`);
    setCommand(null);
    try {
      await api(`/channels/${(target as { id: string }).id}/commands`, { body: { bot: cmd.bot, name: cmd.name, args } });
      stick.current = true;
      await load();
    } catch (err) { onError((err as Error).message); }
  }

  function typed(v: string) {
    setText(v);
    setSuggest(0);
    if (v && Date.now() - lastTyping.current > 6000) {
      lastTyping.current = Date.now();
      void (target.kind === "dm" ? api("/messages/typing", { body: { to: target.uuid } }) : api(`/channels/${target.id}/typing`, { body: {} })).catch(() => {});
    }
  }

  // ------------------------------------------------------------------ suggestions (@ and /)
  const caret = input.current?.selectionStart ?? text.length;
  const atWord = text.slice(0, caret).match(/(^|\s)@([\p{L}\p{N}_.-]{0,32})$/u);
  const slash = !command && isChannel && /^\/[a-z0-9_-]*$/.test(text) ? text.slice(1) : null;
  const memberList = Object.values({ ...senders, ...people }).filter((p) => p.uuid !== me.uuid);
  const suggestions: { label: string; sub?: string; insert: () => void; avatar?: Person }[] = [];
  if (atWord) {
    const q = atWord[2].toLowerCase();
    const start = caret - atWord[2].length - 1;
    const put = (label: string, token?: string) => {
      const v = text.slice(0, start) + label + " " + text.slice(caret);
      if (token) picked.current[label] = token;
      setText(v);
      setTimeout(() => input.current?.focus(), 0);
    };
    for (const p of memberList.filter((p) => (p.nickname || p.name).toLowerCase().includes(q)).slice(0, 8)) {
      const label = `@${(p.nickname || p.name).replace(/\s/g, "_")}`;
      suggestions.push({ label, sub: p.is_bot ? "bot" : p.minecraft_name ?? undefined, avatar: p, insert: () => put(label, `<@${p.uuid}>`) });
    }
    if (isChannel) {
      for (const r of roles.filter((r) => !r.is_default && (r.mentionable || has(can, P.MENTION_EVERYONE)) && r.name.toLowerCase().includes(q)).slice(0, 5)) {
        const label = `@${r.name.replace(/\s/g, "_")}`;
        suggestions.push({ label, sub: "role", insert: () => put(label, `<@&${r.id}>`) });
      }
      if (has(can, P.MENTION_EVERYONE)) for (const w of ["everyone", "here"]) if (w.startsWith(q)) suggestions.push({ label: `@${w}`, sub: w === "everyone" ? "everyone in this channel" : "everyone online", insert: () => put(`@${w}`) });
    }
  } else if (slash !== null) {
    for (const c of commands.filter((c) => c.name.startsWith(slash)).slice(0, 12)) {
      suggestions.push({ label: `/${c.name}`, sub: `${c.description} · ${c.bot_name}`, insert: () => { setText(""); setCommand({ cmd: c, args: {} }); } });
    }
    if (!commands.length && slash === "") {
      suggestions.push({ label: "No commands here yet", sub: "Add a bot like Jace: Server settings → Bots", insert: () => {} });
    }
  }
  const sel = Math.min(suggest, Math.max(0, suggestions.length - 1));

  const canSend = has(can, P.SEND) && !(target.kind === "channel" && target.announcement && !has(can, P.MANAGE_MESSAGES));
  const sendOnEnter = settings.send_on_enter !== false;

  return (
    <div className="chat" onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files); }}>
      {drag && <div className="drop-overlay">Drop files to send them</div>}
      <div className="messages" ref={box}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {more && (
          <div style={{ textAlign: "center", padding: 8 }}>
            <button className="btn small" onClick={() => { stick.current = false; void load(msgs[0]?.id); }}>Load older messages</button>
          </div>
        )}
        {!loading && !msgs.length && (
          <div className="empty"><div><h3 style={{ margin: 0 }}>This is the start of {target.kind === "dm" ? `your chat with ${target.name}` : target.isServer ? `#${target.name}` : target.name}</h3>
            <p>Say hi!</p></div></div>
        )}
        {msgs.map((m, i) => {
          const prev = msgs[i - 1];
          const first = !prev || prev.sender !== m.sender || prev.kind === "system" || m.kind === "system"
            || new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() > 7 * 60_000;
          const mine = m.sender === me.uuid;
          const reply = m.reply_to ? replies[m.reply_to] ?? null : undefined;
          const cmd = m.components?.find((c) => c.type === "command");
          return (
            <MessageRow key={m.id} m={m} first={first} mine={mine} sender={who(m.sender)} roles={roles} mentions={mentionInfo}
              reply={reply} replySender={reply ? who(reply.sender) : undefined} used={cmd?.user ? who(cmd.user) : undefined}
              showEmbeds={settings.show_embeds !== false} editing={editing === m.id}
              onOpenProfile={onOpenProfile} onImage={setLightbox}
              onEditCancel={() => setEditing(null)}
              onEditSave={async (body, previews) => {
                try {
                  await api(target.kind === "dm" ? `/messages/direct/${m.id}` : `/messages/${m.id}`, { method: "PATCH", body: { body, ...previews } });
                  setEditing(null); await load();
                } catch (e) { onError((e as Error).message); }
              }}
              actions={{
                reply: canSend ? () => { setReplyTo(m); input.current?.focus(); } : undefined,
                edit: mine && m.kind !== "system" ? () => setEditing(m.id) : undefined,
                remove: mine || (isChannel && has(can, P.MANAGE_MESSAGES)) ? async () => {
                  if (!confirm("Delete this message?")) return;
                  try { await api(target.kind === "dm" ? `/messages/direct/${m.id}` : `/messages/${m.id}`, { method: "DELETE" }); await load(); } catch (e) { onError((e as Error).message); }
                } : undefined,
                pin: isChannel && (has(can, P.MANAGE_MESSAGES) || !(target as { isServer: boolean }).isServer) ? async () => {
                  try { await api(`/messages/${m.id}/pin`, { method: "PUT" }); await load(); } catch (e) { onError((e as Error).message); }
                } : undefined,
                unpin: isChannel && (has(can, P.MANAGE_MESSAGES) || !(target as { isServer: boolean }).isServer) ? async () => {
                  try { await api(`/messages/${m.id}/pin`, { method: "DELETE" }); await load(); } catch (e) { onError((e as Error).message); }
                } : undefined,
                react: async (emoji, on) => {
                  if (!has(can, P.REACT)) return onError("You can't add reactions here");
                  // show it right away, then sync
                  setMsgs((list) => list.map((x) => {
                    if (x.id !== m.id) return x;
                    const rs = [...(x.reactions ?? [])];
                    const r = rs.find((y) => y.emoji === emoji);
                    if (on && !r?.me) { if (r) { r.count++; r.me = true; } else rs.push({ emoji, count: 1, me: true }); }
                    if (!on && r?.me) { r.count--; r.me = false; }
                    return { ...x, reactions: rs.filter((y) => y.count > 0) };
                  }));
                  try { await api("/reactions", { method: on ? "POST" : "DELETE", body: { scope, message_id: m.id, emoji } }); } catch (e) { onError((e as Error).message); void load(); }
                },
                copyId: settings.developer ? () => navigator.clipboard?.writeText(String(m.id)) : undefined,
              }} />
          );
        })}
      </div>

      <div className="composer">
        <div className="typing-line">{typing.length > 0 && <><span className="typing-dots"><i /><i /><i /></span>
          <b>{typing.slice(0, 3).join(", ")}</b>{typing.length > 3 ? " and others" : ""} {typing.length === 1 ? "is" : "are"} typing…</>}</div>
        {suggestions.length > 0 && (
          <div className="suggest" role="listbox">
            {suggestions.map((s, i) => (
              <button key={s.label + i} type="button" className={i === sel ? "active" : ""} onMouseDown={(e) => { e.preventDefault(); s.insert(); }}>
                {s.avatar && <Avatar p={s.avatar} size={22} />}<b>{s.label}</b>{s.sub && <span className="muted small">{s.sub}</span>}
              </button>
            ))}
          </div>
        )}
        {replyTo && (
          <div className="reply-bar">Replying to <b style={{ color: nameStyle(who(replyTo.sender), roles).color }}>{nameStyle(who(replyTo.sender), roles).name}</b>
            <button className="icon-btn" onClick={() => setReplyTo(null)} aria-label="Cancel reply">✕</button></div>
        )}
        {uploads.length > 0 && (
          <div className="upload-strip">
            {uploads.map((u) => (
              <div key={u.id} className={`upload ${u.progress}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {u.preview ? <img src={u.preview} alt="" /> : <span className="att-icon">📄</span>}
                <span className="small">{u.file.name}</span>
                {u.progress === "uploading" && <span className="muted small">Uploading…</span>}
                <button className="icon-btn" onClick={() => setUploads((l) => l.filter((x) => x.id !== u.id))} aria-label="Remove">✕</button>
              </div>
            ))}
          </div>
        )}
        {command ? (
          <form onSubmit={send} className="command-form">
            <span className="command-name">/{command.cmd.name}</span>
            {command.cmd.options.map((o, i) => (
              <input key={o.name} autoFocus={i === 0} placeholder={`${o.name}${o.required ? "" : " (optional)"}`} title={o.description}
                value={command.args[o.name] ?? ""} onChange={(e) => setCommand({ ...command, args: { ...command.args, [o.name]: e.target.value } })} />
            ))}
            <button type="button" className="icon-btn" onClick={() => setCommand(null)}>✕</button>
            <button className="btn primary small">Send</button>
          </form>
        ) : (
          <form onSubmit={send}>
            {has(can, P.ATTACH) && canSend && (
              <label className="icon-btn attach" title="Attach files">＋
                <input type="file" multiple hidden onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }} />
              </label>
            )}
            <textarea ref={input} rows={1} value={text} maxLength={2000} disabled={!canSend}
              placeholder={canSend ? placeholder : "You can't send messages here"}
              onChange={(e) => typed(e.target.value)}
              onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); void addFiles(e.clipboardData.files); } }}
              onKeyDown={(e) => {
                if (suggestions.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setSuggest((s) => (s + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length); return; }
                if (suggestions.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) { e.preventDefault(); suggestions[sel].insert(); return; }
                if (e.key === "Enter" && !e.shiftKey && sendOnEnter) { e.preventDefault(); void send(); }
                if (e.key === "ArrowUp" && !text) {
                  const last = [...msgs].reverse().find((m) => m.sender === me.uuid && m.kind !== "system");
                  if (last) { e.preventDefault(); setEditing(last.id); }
                }
              }} />
            <span style={{ position: "relative" }}>
              <button type="button" className="icon-btn" title="Emoji" onClick={() => setEmoji(!emoji)}>😀</button>
              {emoji && <EmojiPicker style={{ right: 0, bottom: 36 }} onClose={() => setEmoji(false)}
                onPick={(e) => { setText((t) => t + e); setEmoji(false); input.current?.focus(); }} />}
            </span>
            <button className="btn primary small" disabled={!canSend || (!text.trim() && !uploads.some((u) => u.progress === "done"))}>Send</button>
          </form>
        )}
      </div>

      {pins && (
        <div className="pins-panel">
          <div className="side-head"><span className="grow">📌 Pinned messages</span><button className="icon-btn" onClick={onClosePins}>✕</button></div>
          <div className="side-scroll">
            {pins.length === 0 && <p className="muted small">Nothing pinned yet. Hover a message and click 📌 to pin it.</p>}
            {pins.map((m) => (
              <div key={m.id} className="card pin-card" onClick={() => document.getElementById(`m${m.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>
                <div className="small"><b style={{ color: nameStyle(who(m.sender), roles).color }}>{nameStyle(who(m.sender), roles).name}</b></div>
                <div className="small" style={{ whiteSpace: "pre-wrap" }}>{m.body.slice(0, 300) || "📎 a file"}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {lightbox && (
        <Modal onClose={() => setLightbox(null)} wide>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="" style={{ width: "100%", display: "block", borderRadius: 16 }} />
          <div className="modal-foot"><a className="btn small" href={lightbox} target="_blank" rel="noopener noreferrer">Open original</a>
            <button className="btn small" onClick={() => setLightbox(null)}>Close</button></div>
        </Modal>
      )}
      {ask && (
        <Modal onClose={() => setAsk(null)}>
          <div className="modal-body">
            <h2>Show previews?</h2>
            {ask.hasLink && <label className="check preview-choice"><input type="checkbox" checked={ask.links}
              onChange={(e) => setAsk({ ...ask, links: e.target.checked })} />
              <span><b>Link preview</b><span className="muted small">The site&apos;s title, description and picture under your message</span></span></label>}
            {ask.hasMedia && <label className="check preview-choice"><input type="checkbox" checked={ask.media}
              onChange={(e) => setAsk({ ...ask, media: e.target.checked })} />
              <span><b>File preview</b><span className="muted small">Pictures and videos show in the chat (and sounds get a player) - off: just a file to download</span></span></label>}
            <label className="check small"><input type="checkbox" checked={ask.remember} onChange={(e) => setAsk({ ...ask, remember: e.target.checked })} />
              Don&apos;t ask again (use these from now on - change it in Settings → Links &amp; privacy)</label>
          </div>
          <div className="modal-foot">
            <button className="btn" onClick={() => setAsk(null)}>Cancel</button>
            <button className="btn primary" autoFocus onClick={() => {
              const a = ask;
              setAsk(null);
              if (a.remember) {
                const patch: Settings = { preview_ask: false, ...(a.hasLink ? { preview_links: a.links } : {}), ...(a.hasMedia ? { preview_files: a.media } : {}) };
                prefs.current = { ...prefs.current, ...patch };
                void api("/me", { method: "PATCH", body: { settings: patch } }).catch(() => {});
              }
              void deliver(a.body, a.files, a.reply, { links: a.links, media: a.media });
            }}>Send</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
