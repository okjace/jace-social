"use client";
// Settings -> My bots: make bots, get their token, switch to them, build them with blocks
// (the Scratch-style editor below) or write them in JavaScript (run on Jace Social's server),
// and see everything a bot did (its activity log).
import { useEffect, useRef, useState } from "react";
import { api, type Person } from "@/lib/client";
import { rememberAccount, switchAccount } from "@/lib/accounts";
import { compile, darkTheme, defineBlocks, STARTER, TOOLBOX } from "@/lib/botblocks";
import { Avatar, Modal } from "./ui";

export type Bot = Person & { bot_public: boolean; bot_enabled: boolean; has_program: boolean; has_code?: boolean };
type Err = (m: string) => void;

export function MyBots({ onError }: { onError: Err }) {
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [name, setName] = useState("");
  const [token, setToken] = useState<{ bot: string; token: string } | null>(null);
  const [editing, setEditing] = useState<Bot | null>(null);
  const [coding, setCoding] = useState<Bot | null>(null);
  const [activity, setActivity] = useState<Bot | null>(null);
  const load = () => api<{ bots: Bot[] }>("/bots").then((d) => setBots(d.bots)).catch((e) => onError(e.message));
  useEffect(() => { void load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  async function create() {
    try {
      const r = await api<{ bot: Bot; token: string }>("/bots", { body: { name } });
      setName(""); setToken({ bot: r.bot.uuid, token: r.token }); await load();
    } catch (e) { onError((e as Error).message); }
  }
  async function patch(b: Bot, body: Record<string, unknown>) {
    try { await api(`/bots/${b.uuid}`, { method: "PATCH", body }); await load(); } catch (e) { onError((e as Error).message); }
  }

  if (editing) return <BotEditor bot={editing} onClose={() => { setEditing(null); void load(); }} onError={onError} />;
  if (coding) return <CodeEditor bot={coding} onClose={() => { setCoding(null); void load(); }} onError={onError} />;
  return <>
    <h2>My bots</h2>
    <p className="muted small" style={{ margin: 0 }}>
      Bots are accounts you own. Build one with blocks (no code), write its code here and Jace Social runs it for you,
      or program it anywhere with its token and the Jace Social API.
      You can also switch to a bot and chat as it.</p>
    <form style={{ display: "flex", gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (name.trim()) void create(); }}>
      <input placeholder="New bot's name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
      <button className="btn primary" disabled={!name.trim()}>Create bot</button>
    </form>
    {token && (
      <div className="card" style={{ borderLeft: "4px solid var(--yellow)" }}>
        <b>Bot token</b>
        <p className="muted small" style={{ margin: "4px 0" }}>Copy it now - it's only shown once. Anyone with it can act as your bot, so keep it secret.</p>
        <div style={{ display: "flex", gap: 8 }}>
          <input readOnly value={token.token} onFocus={(e) => e.target.select()} style={{ fontFamily: "ui-monospace, monospace" }} />
          <button className="btn" onClick={() => navigator.clipboard?.writeText(token.token)}>Copy</button>
          <button className="btn" onClick={() => setToken(null)}>Done</button>
        </div>
      </div>
    )}
    {bots === null ? <p className="muted">Loading…</p> : bots.length === 0 ? <p className="muted">No bots yet.</p> : bots.map((b) => (
      <div key={b.uuid} className="card bot-card">
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <label title="Change picture" style={{ cursor: "pointer" }}>
            <Avatar p={b} size={48} />
            <input type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) { try { await api(`/bots/${b.uuid}/avatar`, { raw: f }); await load(); } catch (err) { onError((err as Error).message); } }
            }} />
          </label>
          <div className="grow">
            <b>{b.name}</b> <span className="bot-tag">BOT</span>
            <div className="muted small">{b.has_code ? "Runs its code on Jace Social" : b.has_program ? "Made with blocks" : "Uses the API (or nothing yet)"} · {b.bot_public ? "Anyone can add it" : "Only you can add it"}</div>
          </div>
        </div>
        <textarea rows={2} defaultValue={b.bio ?? ""} maxLength={300} placeholder="What does it do?" onBlur={(e) => { if (e.target.value !== (b.bio ?? "")) void patch(b, { bio: e.target.value }); }} />
        <div className="bot-buttons">
          <button className={`btn small${b.has_code ? "" : " primary"}`} onClick={() => setEditing(b)}>🧩 Edit blocks</button>
          <button className={`btn small${b.has_code ? " primary" : ""}`} onClick={() => setCoding(b)}>💻 {b.has_code ? "Edit code" : "Write code"}</button>
          <button className="btn small" onClick={() => setActivity(b)}>📜 Activity</button>
          <button className="btn small" onClick={async () => {
            try {
              const s = await api<{ token: string; uuid: string; name: string; avatar_url: string | null }>(`/bots/${b.uuid}/session`, { body: {} });
              rememberAccount({ uuid: s.uuid, name: s.name, avatar_url: s.avatar_url, is_bot: true }, s.token);
              if (confirm(`Switch to ${b.name} now? You can switch back from Settings → Bot.`)) { const problem = await switchAccount(s.uuid); if (problem) onError(problem); }
            } catch (e) { onError((e as Error).message); }
          }}>Switch to this bot</button>
          <button className="btn small" onClick={async () => {
            if (!confirm("Make a new token? The old one stops working right away.")) return;
            try { const r = await api<{ token: string }>(`/bots/${b.uuid}/token`, { body: {} }); setToken({ bot: b.uuid, token: r.token }); } catch (e) { onError((e as Error).message); }
          }}>New token</button>
          <label className="check small"><input type="checkbox" checked={b.bot_public} onChange={(e) => void patch(b, { bot_public: e.target.checked })} /> Public</label>
          <label className="check small"><input type="checkbox" checked={b.bot_enabled} onChange={(e) => void patch(b, { bot_enabled: e.target.checked })} /> On</label>
          <button className="btn small danger" onClick={async () => {
            if (!confirm(`Delete ${b.name}? It leaves every server.`)) return;
            try { await api(`/bots/${b.uuid}`, { method: "DELETE" }); await load(); } catch (e) { onError((e as Error).message); }
          }}>Delete</button>
        </div>
      </div>
    ))}
    {activity && <BotActivity bot={activity} onClose={() => setActivity(null)} />}
    <details className="card">
      <summary><b>Programming a bot with the API (run it yourself)</b></summary>
      <div className="small" style={{ display: "grid", gap: 6, marginTop: 8 }}>
        <span>Send requests to <code className="inline-code">{typeof location !== "undefined" ? location.origin : ""}/api/v1</code> with the header
          <code className="inline-code">Authorization: Bearer &lt;bot token&gt;</code>. The bot uses the same API as the app: read and send messages in
          <code className="inline-code">/channels/&#123;id&#125;/messages</code>, react with <code className="inline-code">/reactions</code>, and so on.</span>
        <span>Live events (new messages, and <code className="inline-code">command</code> when someone uses one of the bot's slash commands)
          arrive on the bot's private Realtime channel: <code className="inline-code">GET /me</code> gives its name and key.</span>
      </div>
    </details>
  </>;
}

/** The block editor (Blockly with the Scratch-like "zelos" look). Also its own page, /bot-blocks,
 *  which the native phone apps open in a web view (Blockly has no native version). */
export function BotEditor({ bot, onClose, onError }: { bot: Bot; onClose: () => void; onError: Err }) {
  const div = useRef<HTMLDivElement>(null);
  const ws = useRef<import("blockly/core").WorkspaceSvg | null>(null);
  const [status, setStatus] = useState("Loading the editor…");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let disposed = false;
    (async () => {
      const Blockly = await import("blockly/core");
      await import("blockly/blocks");                         // text and number blocks
      const en = await import("blockly/msg/en");
      Blockly.setLocale(en as unknown as Record<string, string>);
      defineBlocks(Blockly);
      if (disposed || !div.current) return;
      const w = Blockly.inject(div.current, {
        toolbox: TOOLBOX, renderer: "zelos", theme: darkTheme(Blockly), trashcan: true, sounds: false,
        zoom: { controls: true, wheel: true, startScale: 0.8, maxScale: 2, minScale: 0.4 },
        grid: { spacing: 24, length: 2, colour: "#2a2f38", snap: true }, move: { scrollbars: true, drag: true, wheel: false },
      });
      ws.current = w;
      try {
        const d = await api<{ program: { blocks?: unknown } | null }>(`/bots/${bot.uuid}`);
        Blockly.serialization.workspaces.load((d.program?.blocks ?? STARTER) as object, w);
      } catch (e) {
        onError((e as Error).message);
        Blockly.serialization.workspaces.load(STARTER, w);
      }
      w.addChangeListener((ev) => { if (!ev.isUiEvent) setDirty(true); });
      setDirty(false);
      setStatus("");
    })().catch((e) => setStatus(`The editor couldn't load: ${e.message}`));
    return () => { disposed = true; ws.current?.dispose(); ws.current = null; };
  }, [bot.uuid]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    const w = ws.current;
    if (!w) return;
    const Blockly = await import("blockly/core");
    const { program, error } = compile(w);
    if (error) { setStatus(`⚠ ${error}`); return; }
    try {
      await api(`/bots/${bot.uuid}/program`, { method: "PUT", body: { program, blocks: Blockly.serialization.workspaces.save(w) } });
      setDirty(false);
      const n = program!.handlers.length;
      setStatus(`Saved ✓ ${n} "when" block${n === 1 ? "" : "s"}. Add ${bot.name} to a server to try it.`);
    } catch (e) { setStatus(`⚠ ${(e as Error).message}`); }
  }

  return (
    <div className="bot-editor">
      <div className="bot-editor-bar">
        <button className="btn small" onClick={() => { if (!dirty || confirm("Leave without saving?")) onClose(); }}>← Back</button>
        <Avatar p={bot} size={28} /><b>{bot.name}</b>
        <span className="grow muted small">{status}</span>
        <button className="btn primary small" onClick={save}>{dirty ? "Save" : "Saved"}</button>
      </div>
      <div className="bot-editor-help muted small">
        Drag a yellow <b>when</b> block out, then snap actions under it. Only blocks under a <b>when</b> block run.
        Bots run on the Jace Social server: up to 5 messages and a few seconds per event.
      </div>
      <div ref={div} className="blockly-area" />
    </div>
  );
}

/** Write a bot in JavaScript; Jace Social runs it (in a sandbox) when something happens. */
function CodeEditor({ bot, onClose, onError }: { bot: Bot; onClose: () => void; onError: Err }) {
  const [code, setCode] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [status, setStatus] = useState("");
  const [tryText, setTryText] = useState("hi bot");
  const [result, setResult] = useState<{ actions: { t: string; text?: string; channel?: string; emoji?: string; role?: string }[];
    logs: string[]; storage: Record<string, unknown>; commands: { name: string }[]; error?: string } | null>(null);
  useEffect(() => {
    api<{ code: string | null }>(`/bots/${bot.uuid}`).then((d) => { setCode(d.code ?? STARTER_CODE); setSaved(d.code ?? ""); })
      .catch((e) => { onError(e.message); setCode(STARTER_CODE); });
  }, [bot.uuid]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (code === null) return <p className="muted">Loading…</p>;
  const dirty = code !== saved;
  async function save() {
    try {
      const r = await api<{ commands: { name: string }[] }>(`/bots/${bot.uuid}/code`, { method: "PUT", body: { code } });
      setSaved(code!);
      setStatus(`Saved ✓${r.commands.length ? ` Commands: ${r.commands.map((c) => "/" + c.name).join(", ")}.` : ""} Add ${bot.name} to a server or group to try it.`);
    } catch (e) { setStatus(`⚠ ${(e as Error).message}`); }
  }
  async function tryIt() {
    const cmd = tryText.trim().startsWith("/") ? tryText.trim().slice(1).split(/\s+/) : null;
    try {
      const r = await api<{ result: NonNullable<typeof result> }>(`/bots/${bot.uuid}/code`, { body: {
        code, text: cmd ? cmd.slice(1).join(" ") : tryText, command: cmd ? { name: cmd[0], args: { text: cmd.slice(1).join(" ") } } : undefined } });
      setResult(r.result);
    } catch (e) { setStatus(`⚠ ${(e as Error).message}`); }
  }
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="bot-editor-bar">
        <button className="btn small" onClick={() => { if (!dirty || confirm("Leave without saving?")) onClose(); }}>← Back</button>
        <Avatar p={bot} size={28} /><b>{bot.name}</b>
        <span className="grow muted small">{status}</span>
        {saved && <button className="btn small danger" onClick={async () => {
          if (!confirm("Remove this code? The bot stops running it.")) return;
          try { await api(`/bots/${bot.uuid}/code`, { method: "PUT", body: { code: null } }); setSaved(""); setStatus("Code removed"); } catch (e) { onError((e as Error).message); }
        }}>Remove code</button>}
        <button className="btn primary small" disabled={!dirty} onClick={save}>{dirty ? "Save" : "Saved"}</button>
      </div>
      <textarea className="code-editor" spellCheck={false} value={code} rows={22}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Tab") {           // tab indents instead of leaving the box
            e.preventDefault();
            const t = e.currentTarget, at = t.selectionStart;
            setCode(code.slice(0, at) + "  " + code.slice(t.selectionEnd));
            requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = at + 2; });
          } else if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); void save(); }
        }} />
      <div className="card" style={{ display: "grid", gap: 6 }}>
        <b>Try it</b>
        <div className="muted small">Runs the code above for a pretend message (or a /command) without saving or sending anything.</div>
        <form style={{ display: "flex", gap: 8 }} onSubmit={(e) => { e.preventDefault(); void tryIt(); }}>
          <input value={tryText} onChange={(e) => setTryText(e.target.value)} placeholder="A message, or /command" />
          <button className="btn">Run</button>
        </form>
        {result && (
          <div className="small" style={{ display: "grid", gap: 4 }}>
            {result.error && <div className="error">⚠ {result.error}</div>}
            {result.actions.length === 0 && !result.error && <div className="muted">It wouldn't do anything.</div>}
            {result.actions.map((a, i) => <div key={i}>{describeAction(a)}</div>)}
            {Object.entries(result.storage).map(([k, v]) => <div key={k}>💾 {v === null ? `Forget "${k}"` : `Save "${k}" = ${JSON.stringify(v)}`}</div>)}
            {result.logs.map((l, i) => <div key={i} className="muted">› {l}</div>)}
          </div>
        )}
      </div>
      <details className="card">
        <summary><b>What your code can use</b></summary>
        <pre className="update-notes" style={{ marginTop: 8 }}>{CODE_HELP}</pre>
      </details>
    </div>
  );
}

function describeAction(a: { t: string; text?: string; channel?: string; emoji?: string; role?: string }) {
  switch (a.t) {
    case "reply": return `💬 Reply: ${a.text}`;
    case "send": return `💬 Send in #${a.channel}: ${a.text}`;
    case "react": return `😀 React with ${a.emoji}`;
    case "give_role": return `🏷️ Give the role ${a.role}`;
    case "take_role": return `🏷️ Take the role ${a.role}`;
    case "delete_message": return "🗑️ Delete the message";
    default: return a.t;
  }
}

const STARTER_CODE = `// This runs on Jace Social's server whenever something happens where your bot is.
// It can reply, send messages, react, give roles and remember things (storage).

bot.on("message", (msg) => {
  if (msg.text.toLowerCase() === "hi bot") msg.reply("Hi " + msg.author.name + "! 👋");
});

bot.command("count", "Count up by one", (cmd) => {
  const n = (storage.get("count") || 0) + 1;
  storage.set("count", n);
  cmd.reply("The count is now " + n);
});

bot.on("join", (member) => {
  member.reply("Welcome, " + member.author.name + "!");
});
`;

const CODE_HELP = `bot.on("message", (msg) => { ... })     someone wrote in a chat the bot is in
bot.on("join", (member) => { ... })      someone joined the server (runs in its welcome channel)
bot.command("name", "What it does", [{ name: "option", description: "...", required: true }], (cmd, args) => { ... })
                                          a slash command; args.option is what they typed

msg / cmd / member have:
  .text  .author.id  .author.name  .channel.id  .channel.name  .server (null in a group chat)
  .reply(text)  .react("👍")  .delete()  .giveRole("Role name")  .takeRole("Role name")
bot.send("channel-name", text)            send in another channel of the server
storage.get(key)  storage.set(key, value)  storage.delete(key)  storage.keys()
                                          remembered per server (up to 100 values, 32 KB)
console.log(...)                          shows in the bot's Activity

Limits per event: 300 ms of work, 5 messages, 32 MB of memory. No internet access, files or timers.
Everything the bot does is in its Activity, which you (and the admins of servers it's in) can see.`;

const KIND_ICONS: Record<string, string> = {
  event: "📥", message: "💬", react: "😀", role: "🏷️", delete: "🗑️", storage: "💾", log: "›", error: "⚠️", command: "⌨️",
};

/** Everything a bot did, newest first. Owner: all of it; a server's admins: what it did there. */
export function BotActivity({ bot, server, onClose }: { bot: { uuid: string; name: string }; server?: string; onClose: () => void }) {
  type Entry = { id: number; at: string; server_id: string | null; channel_id: string | null; kind: string; detail: string };
  const [entries, setEntries] = useState<Entry[]>([]);
  const [names, setNames] = useState<{ channels: Record<string, string>; servers: Record<string, string> }>({ channels: {}, servers: {} });
  const [more, setMore] = useState(true);
  const [error, setError] = useState("");
  async function load(before?: number) {
    try {
      const q = new URLSearchParams();
      if (server) q.set("server", server);
      if (before) q.set("before", String(before));
      const r = await api<{ entries: Entry[]; channels: Record<string, string>; servers: Record<string, string> }>(`/bots/${bot.uuid}/activity?${q}`);
      setEntries((e) => before ? [...e, ...r.entries] : r.entries);
      setNames((n) => ({ channels: { ...n.channels, ...r.channels }, servers: { ...n.servers, ...r.servers } }));
      setMore(r.entries.length === 100);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, [bot.uuid, server]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal onClose={onClose}>
      <div className="modal-body">
        <h2 style={{ margin: 0 }}>📜 What {bot.name} did</h2>
        <div className="muted small">{server ? "In this server, " : ""}newest first. Kept for 14 days.</div>
        {error && <div className="error">{error}</div>}
        {!error && entries.length === 0 && <div className="muted">Nothing yet.</div>}
        <div className="bot-activity">
          {entries.map((e) => (
            <div key={e.id} className={`bot-activity-row ${e.kind}`}>
              <span title={e.kind}>{KIND_ICONS[e.kind] ?? "•"}</span>
              <div>
                <div>{e.detail}</div>
                <div className="muted small">{new Date(e.at).toLocaleString()}
                  {e.server_id && !server && names.servers[e.server_id] ? ` · ${names.servers[e.server_id]}` : ""}
                  {e.channel_id && names.channels[e.channel_id] ? ` · #${names.channels[e.channel_id]}` : ""}</div>
              </div>
            </div>
          ))}
        </div>
        {more && entries.length > 0 && <button className="btn small" onClick={() => void load(entries[entries.length - 1].id)}>Show older</button>}
      </div>
    </Modal>
  );
}
