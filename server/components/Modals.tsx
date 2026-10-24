"use client";
import { MobileVersion } from "./MobileUpdate";
import { has, P } from "@/lib/permbits";
import { useEffect, useState } from "react";
import { MinecraftDevice } from "./MinecraftDevice";
import { BotActivity, MyBots } from "./Bots";
import { forgetAccount, rememberAccount, savedAccounts, switchAccount } from "@/lib/accounts";
import { AddAccountModal } from "./AddAccount";
import { VoiceSettings } from "./VoiceSettings";
import { SoundSettings } from "./SoundSettings";
import { DeleteAccountCard } from "./DeleteAccount";
import { ACCENTS, applySettings, cssDisabled, THEME_NAMES } from "@/lib/theme";
import {
  api, desktopReady, getToken, inDesktop, since, statusLabel, type JaceMessages, type Me, type Person, type Settings, type Status, type DesktopBridge, type ServerDetail,
} from "@/lib/client";
import { ActivityCard, Avatar, Modal, PersonRow } from "./ui";
import { Link } from "./Markdown";
import { BotTag, JACE_BOT } from "./JaceBot";
import { MemberActions } from "./ServerSettings";

type Err = (m: string) => void;

// ---------------------------------------------------------------------------------
// Someone's profile
// ---------------------------------------------------------------------------------
type FullProfile = Person & { is_friend: boolean; is_you: boolean; mutual_servers: { id: string; name: string; icon_url: string | null }[] };

export function ProfileModal({ uuid, onClose, onMessage, onChanged, onError, detail, me }: {
  uuid: string; onClose: () => void; onMessage: (p: Person) => void; onChanged: () => void; onError: Err;
  detail?: ServerDetail | null; me?: Me;     // opened from a server: show their roles and what you can do
}) {
  const [p, setP] = useState<FullProfile | null>(null);
  const [activity, setActivity] = useState(false);
  useEffect(() => { api<FullProfile>(`/users/${uuid}`).then(setP).catch((e) => { onError(e.message); onClose(); }); }, [uuid]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p) return null;
  const accent = p.accent_color ?? "#2a4a37";
  const member = detail?.members.find((m) => m.uuid === uuid);
  const roles = detail ? detail.roles.filter((r) => member?.roles?.includes(r.id)).sort((a, b) => b.position - a.position) : [];
  async function addFriend() {
    try { await api("/friends", { body: { uuid } }); onChanged(); onClose(); } catch (e) { onError((e as Error).message); }
  }
  async function removeFriend() {
    if (!confirm(`Remove ${p!.name} from your friends?`)) return;
    try { await api(`/friends?uuid=${uuid}`, { method: "DELETE" }); onChanged(); onClose(); } catch (e) { onError((e as Error).message); }
  }
  return (
    <Modal onClose={onClose}>
      <div className="profile-banner" style={{ background: p.banner_url ? `center / cover url(${p.banner_url})` : accent }} />
      <div className="profile-head"><Avatar p={p} size={92} status={p.status} /></div>
      <div className="modal-body">
        <div>
          <h2>{member?.nickname || p.name}<BotTag p={p} style={{ marginLeft: 8, verticalAlign: "middle" }} />
            {p.banned && <span className="chip" style={{ marginLeft: 8, color: "var(--red)" }}>Banned</span>}</h2>
          {member?.nickname && <div className="muted small">{p.name}</div>}
          <div className="muted small">
            {[p.handle ? `@${p.handle}` : p.jace_name && `@${p.jace_name}`, p.minecraft_name && `⛏ ${p.minecraft_name}`, p.pronouns].filter(Boolean).join(" · ")}
          </div>
          <div className="small" style={{ marginTop: 6 }}>
            {statusLabel[p.status]}{p.custom_status && <> · {p.status_emoji} {p.custom_status}</>}
            {!p.online && p.last_seen && <span className="muted"> · last seen {since(p.last_seen)} ago</span>}
          </div>
        </div>
        <ActivityCard a={p.activity} />
        {p.bio && <div className="card"><div className="kind muted small" style={{ fontWeight: 800 }}>ABOUT ME</div><div style={{ whiteSpace: "pre-wrap" }}>{p.bio}</div></div>}
        {p.links.length > 0 && (
          <div className="chips">{p.links.map((l) => <Link key={l.url} href={l.url}><span className="chip">🔗 {l.label}</span></Link>)}</div>
        )}
        {detail && member && <>
          {roles.length > 0 && <div className="chips">{roles.map((r) => <span key={r.id} className="chip"><span className="role-dot" style={{ background: r.color ?? "var(--gray)" }} /> {r.name}</span>)}</div>}
          {me && <MemberActions detail={detail} member={member} me={me} run={async (fn) => { try { await fn(); onChanged(); return true; } catch (e) { onError((e as Error).message); return false; } }} />}
        </>}
        {p.mutual_servers.length > 0 && (
          <div className="small muted">Servers you share: {p.mutual_servers.map((s) => s.name).join(", ")}</div>
        )}
      </div>
      {p.is_bot && (p.bot_owner === me?.uuid || (detail && member && has(detail.perms, P.MANAGE_SERVER))) && (
        <div className="modal-foot">
          <button className="btn" onClick={() => setActivity(true)}>📜 See everything it does</button>
        </div>
      )}
      {activity && <BotActivity bot={{ uuid: p.uuid, name: p.name }} server={p.bot_owner === me?.uuid ? undefined : detail?.server.id} onClose={() => setActivity(false)} />}
      {me?.jace_staff && !p.is_you && !p.is_bot && <BanButtons p={p} onChanged={async () => {
        setP(await api<FullProfile>(`/users/${uuid}`)); onChanged();
      }} onError={onError} />}
      {!p.is_you && !p.is_bot && (
        <div className="modal-foot">
          {p.is_friend ? <>
            <button className="btn danger" onClick={removeFriend}>Remove friend</button>
            <button className="btn primary" onClick={() => { onMessage(p); onClose(); }}>Message</button>
          </> : <button className="btn primary" onClick={addFriend}>Add friend</button>}
        </div>
      )}
    </Modal>
  );
}

/** For the people running the official Jace bot: ban someone from all of Jace Social (and Jace). */
function BanButtons({ p, onChanged, onError }: { p: FullProfile; onChanged: () => Promise<void>; onError: Err }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<{ jace_error?: string | null }>) => {
    setBusy(true);
    try { const r = await fn(); if (r.jace_error) onError(`Done here, but Jace said: ${r.jace_error}`); await onChanged(); }
    catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="modal-foot" style={{ justifyContent: "flex-start" }}>
      <span className="muted small grow">Jace bot moderation</span>
      {p.banned
        ? <button className="btn small" disabled={busy} onClick={() => void run(() =>
            api(`/jace-bot/ban?uuid=${p.uuid}&jace=${p.jace_name && confirm("Also unban their Jace account?") ? "1" : "0"}`, { method: "DELETE" }))}>Unban</button>
        : <button className="btn small danger" disabled={busy} onClick={() => {
            const reason = prompt(`Ban ${p.name} from all of Jace Social? They're signed out everywhere and can't sign in again.\nReason (optional):`);
            if (reason === null) return;
            const jace = !!p.jace_name && confirm(`Also ban their Jace account (@${p.jace_name})?`);
            void run(() => api("/jace-bot/ban", { body: { uuid: p.uuid, reason, jace } }));
          }}>⛔ Ban from Jace Social</button>}
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Your settings: profile, status, linked accounts
// ---------------------------------------------------------------------------------
export type SettingsTab = "bot" | "profile" | "status" | "appearance" | "voice" | "sounds" | "notifications" | "links" | "accounts" | "bots" | "advanced";
const TAB_NAMES: [SettingsTab, string][] = [["bot", "Bot"], ["profile", "My profile"], ["status", "Status"], ["appearance", "Appearance"], ["voice", "Voice & video"], ["sounds", "Sounds"],
  ["notifications", "Notifications"], ["links", "Links & privacy"], ["accounts", "Accounts"], ["bots", "My bots"], ["advanced", "Advanced"]];

export function SettingsModal({ me, onClose, onSaved, onSignOut, onError, initialTab, onWelcome }: {
  me: Me; onClose: () => void; onSaved: (m: Me) => void; onSignOut: () => void; onError: Err; initialTab?: SettingsTab;
  onWelcome?: () => void;     // show the first-time walkthrough again
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? (me.is_bot ? "bot" : "profile"));
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({
    display_name: me.display_name ?? "", handle: me.handle ?? "", pronouns: me.pronouns ?? "", bio: me.bio ?? "",
    accent_color: me.accent_color ?? "#3ddc84", links: me.links.length ? me.links : [{ label: "", url: "" }],
  });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [linking, setLinking] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const { handle, ...rest } = f;
      const body: Record<string, unknown> = { ...rest, links: f.links.filter((l) => l.url.trim()) };
      if (handle.trim().replace(/^@/, "").toLowerCase() !== (me.handle ?? "")) body.handle = handle;
      const m = await api<Me>("/me", { method: "PATCH", body });
      onSaved(m); setNote("Saved!");
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }

  async function avatar(file: File | null) {
    if (!file) return;
    try {
      const r = await api<{ avatar_url: string }>("/me/avatar", { raw: file });
      onSaved({ ...me, avatar_url: r.avatar_url });
    } catch (e) { onError((e as Error).message); }
  }

  async function linkJace() {
    setNote("Finish in the browser tab that opened…");
    try {
      const r = await api<{ url: string; state: string; poll_key: string }>("/link/jace", { body: {} });
      window.open(r.url, "_blank", "noopener");
      for (let i = 0; i < 150; i++) {                       // up to 5 minutes
        await new Promise((ok) => setTimeout(ok, 2000));
        const d = await api<{ pending?: boolean; jace_name?: string }>(`/auth/jace/poll?state=${r.state}&key=${r.poll_key}`);
        if (!d.pending) { onSaved(await api<Me>("/me")); setNote(`Linked @${d.jace_name}`); return; }
      }
      setNote("Linking timed out - try again");
    } catch (e) { setNote(""); onError((e as Error).message); }
  }

  async function linkMinecraft() {
    const d = await desktopReady();
    if (!d) return;
    setNote("Sign in with Microsoft in the window that opened…");
    const r = await d.linkMinecraft(getToken() ?? "");
    if (r.error) { setNote(""); onError(r.error); return; }
    onSaved(await api<Me>("/me")); setNote("Minecraft linked!");
  }

  async function unlinkJace() {
    if (!confirm("Unlink your Jace account? You'll sign in with Minecraft only.")) return;
    try { await api("/link/jace", { method: "DELETE" }); onSaved(await api<Me>("/me")); } catch (e) { onError((e as Error).message); }
  }

  return (
    <Modal onClose={onClose} wide>
      <div className="settings">
        <nav>
          {TAB_NAMES.filter(([t]) => (me.is_bot ? t !== "bots" : t !== "bot")).map(([t, label]) => (
            <button key={t} className={`side-item${tab === t ? " active" : ""}`} onClick={() => { setTab(t); setNote(""); }}>{label}</button>
          ))}
          {onWelcome && !me.is_bot && <button className="side-item" onClick={onWelcome}>👋 Welcome tour</button>}
          <button className="side-item" style={{ color: "var(--red)" }} onClick={onSignOut}>Sign out</button>
          <DesktopVersion />
          <MobileVersion />
        </nav>
        <div className="modal-body">
          {tab === "profile" && <>
            <h2>My profile</h2>
            <div className="server-banner-edit" style={{ height: 90, background: me.banner_url ? `center / cover url(${me.banner_url})` : f.accent_color }}>
              <label className="btn small">Change banner<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try { await api("/me/banner", { raw: file }); onSaved(await api<Me>("/me")); } catch (err) { onError((err as Error).message); }
              }} /></label>
              {me.banner_url && <button className="btn small" onClick={async () => { await api("/me/banner", { method: "DELETE" }); onSaved(await api<Me>("/me")); }}>Remove</button>}
            </div>
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              <Avatar p={me} size={72} />
              <div style={{ display: "grid", gap: 6 }}>
                <label className="btn small" style={{ textTransform: "none", color: "var(--text)", fontSize: 13 }}>
                  Change picture<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden
                    onChange={(e) => avatar(e.target.files?.[0] ?? null)} /></label>
                {me.avatar_url && !me.avatar_url.includes("mc-heads.net") && (
                  <button className="btn small" onClick={async () => { await api("/me/avatar", { method: "DELETE" }); onSaved(await api<Me>("/me")); }}>Remove picture</button>
                )}
              </div>
              <span className="muted small grow">Animated GIF and WebP pictures and banners work too (up to 4 MB).</span>
            </div>
            <label>Display name<input value={f.display_name} maxLength={32} placeholder={me.minecraft_name ?? me.jace_name ?? ""}
              onChange={(e) => setF({ ...f, display_name: e.target.value })} /></label>
            <label>Handle
              <div className="vanity">
                <span className="muted">@</span>
                <input value={f.handle} maxLength={21} placeholder="yourname" disabled={!!me.handle_change_at}
                  onChange={(e) => setF({ ...f, handle: e.target.value.toLowerCase().replace(/[^a-z0-9_.@]/g, "") })} />
              </div>
            </label>
            <p className="muted small" style={{ margin: 0 }}>
              {me.handle_change_at
                ? `Your unique name. You can change it again on ${new Date(me.handle_change_at).toLocaleDateString()}.`
                : "Your unique name: people can add you as a friend with it. 3-20 letters, numbers, _ and . - you can change it once a week."}
            </p>
            <label>Pronouns<input value={f.pronouns} maxLength={24} onChange={(e) => setF({ ...f, pronouns: e.target.value })} /></label>
            <label>About me<textarea rows={4} value={f.bio} maxLength={300} onChange={(e) => setF({ ...f, bio: e.target.value })} /></label>
            <label>Profile color<input type="color" value={f.accent_color} style={{ height: 40, padding: 4 }}
              onChange={(e) => setF({ ...f, accent_color: e.target.value })} /></label>
            <label>Links (up to 5)</label>
            {f.links.map((l, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 2fr auto", gap: 6 }}>
                <input placeholder="Name" value={l.label} maxLength={32}
                  onChange={(e) => setF({ ...f, links: f.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                <input placeholder="https://…" value={l.url} maxLength={300}
                  onChange={(e) => setF({ ...f, links: f.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
                <button className="icon-btn" aria-label="Remove link" onClick={() => setF({ ...f, links: f.links.filter((_, j) => j !== i) })}>✕</button>
              </div>
            ))}
            {f.links.length < 5 && <button className="btn small" style={{ justifySelf: "start" }}
              onClick={() => setF({ ...f, links: [...f.links, { label: "", url: "" }] })}>+ Add link</button>}
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button className="btn primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save profile"}</button>
              <span className="muted small">{note}</span>
            </div>
          </>}
          {tab === "status" && <StatusEditor me={me} onSaved={onSaved} onError={onError} />}
          {tab === "appearance" && <AppearanceTab me={me} onSaved={onSaved} onError={onError} />}
          {tab === "voice" && <VoiceSettings />}
          {tab === "sounds" && <SoundsTab me={me} onSaved={onSaved} onError={onError} />}
          {tab === "notifications" && <NotificationsTab me={me} onSaved={onSaved} onError={onError} />}
          {tab === "links" && <LinksTab me={me} onSaved={onSaved} onError={onError} />}
          {tab === "bot" && me.is_bot && <>
            <h2>Bot</h2>
            <p>You&apos;re signed in as the bot <b>{me.name}</b>. What you send, it sends.</p>
            <BackToMyAccount me={me} onAdd={() => setAdding(true)} onError={onError} />
            {adding && <AddAccountModal me={me} onClose={() => setAdding(false)} />}
            <h2 style={{ marginTop: 8 }}>Switch accounts</h2>
            <AccountSwitcher me={me} onError={onError} noBack />
          </>}
          {tab === "bots" && <MyBots onError={onError} />}
          {tab === "advanced" && <AdvancedTab me={me} onSaved={onSaved} onError={onError} />}
          {tab === "accounts" && <>
            <h2>Switch accounts</h2>
            <AccountSwitcher me={me} onError={onError} />
            {!me.is_bot && <>
            <h2 style={{ marginTop: 8 }}>Linked accounts</h2>
            <p className="muted">Link both to sign in either way. Your friends, chats and servers stay with you.</p>
            <div className="card" style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1 }}><b>Jace</b><div className="muted small">{me.jace_linked ? `@${me.jace_name}` : "Not linked"}</div></div>
              {me.jace_linked
                ? me.minecraft_linked && <button className="btn small" onClick={unlinkJace}>Unlink</button>
                : <button className="btn primary small" onClick={linkJace}>Link Jace</button>}
            </div>
            {me.jace_linked && <JaceMessagesCard me={me} onConnect={linkJace} onError={onError} />}
            <div className="card" style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1 }}><b>Minecraft</b><div className="muted small">{me.minecraft_linked ? me.minecraft_name : "Not linked"}</div></div>
              {!me.minecraft_linked && !linking &&
                <button className="btn primary small" onClick={() => inDesktop() ? linkMinecraft() : setLinking(true)}>Link Minecraft</button>}
            </div>
            {linking && <div className="card"><MinecraftDevice mode="link" onCancel={() => setLinking(false)}
              onDone={async () => { setLinking(false); onSaved(await api<Me>("/me")); setNote("Minecraft linked!"); }} /></div>}
            {note && <div className="muted small">{note}</div>}
            <DeleteAccountCard me={me} />
            </>}
          </>}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------
// Settings that follow you (Appearance, Notifications, Links, Advanced)
// ---------------------------------------------------------------------------------
type SettingsProps = { me: Me; onSaved: (m: Me) => void; onError: Err };

function useSettings({ me, onSaved, onError }: SettingsProps) {
  const s = me.settings ?? {};
  const set = async (patch: Settings) => {
    const next = { ...s, ...patch };
    applySettings(next);
    onSaved({ ...me, settings: next });                     // show it right away
    try { onSaved(await api<Me>("/me", { method: "PATCH", body: { settings: patch } })); } catch (e) { onError((e as Error).message); }
  };
  return { s, set };
}

function Toggle({ label, desc, checked, onChange }: { label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="perm-row">
      <div className="grow"><b>{label}</b>{desc && <div className="muted small">{desc}</div>}</div>
      <input type="checkbox" className="toggle" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}

function AppearanceTab(props: SettingsProps) {
  const { s, set } = useSettings(props);
  return <>
    <h2>Appearance</h2>
    <label>Theme</label>
    <div className="theme-grid">
      {THEME_NAMES.map(([id, label, bg]) => (
        <button key={id} className={`theme-card${(s.theme ?? "dark") === id ? " on" : ""}`} onClick={() => void set({ theme: id })}>
          <span className="theme-swatch" style={{ background: bg }} />{label}</button>
      ))}
    </div>
    <label>Accent color</label>
    <div className="swatches">
      {ACCENTS.map((c) => <button key={c} className={`swatch${(s.accent ?? "#3ddc84") === c ? " on" : ""}`} style={{ background: c }} onClick={() => void set({ accent: c })} />)}
      <input type="color" value={s.accent ?? "#3ddc84"} onChange={(e) => void set({ accent: e.target.value })} style={{ width: 40, padding: 2 }} title="Pick any color" />
      <HexInput value={s.accent ?? "#3ddc84"} onChange={(v) => void set({ accent: v })} />
    </div>
    <BackgroundPicker s={s} set={set} onError={props.onError} />
    <CustomCss s={s} set={set} />
    <label>Text size: {Math.round((s.font_scale ?? 1) * 100)}%
      <input type="range" min={0.8} max={1.4} step={0.05} value={s.font_scale ?? 1} onChange={(e) => void set({ font_scale: Number(e.target.value) })} />
    </label>
    <Toggle label="Compact messages" desc="Fit more messages on screen" checked={!!s.compact} onChange={(v) => void set({ compact: v })} />
    <Toggle label="Show pictures next to messages" checked={s.show_avatars !== false} onChange={(v) => void set({ show_avatars: v })} />
    <Toggle label="Show link previews" checked={s.show_embeds !== false} onChange={(v) => void set({ show_embeds: v })} />
    <Toggle label="Less motion" desc="Turn off animations" checked={!!s.reduce_motion} onChange={(v) => void set({ reduce_motion: v })} />
    <Toggle label="24-hour clock" checked={s.time_format === "24h"} onChange={(v) => void set({ time_format: v ? "24h" : "12h" })} />
    <Toggle label="Enter sends the message" desc="Off: Enter makes a new line, and you click Send" checked={s.send_on_enter !== false} onChange={(v) => void set({ send_on_enter: v })} />
  </>;
}

/** A #rrggbb box: saves when it's a whole color. */
function HexInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const ok = /^#?[0-9a-fA-F]{6}$/.test(text.trim());
  return <input value={text} maxLength={7} spellCheck={false} aria-label="Accent color (hex)" placeholder="#3ddc84"
    style={{ width: 96, fontFamily: "ui-monospace, monospace", borderColor: ok ? undefined : "var(--red)" }}
    onChange={(e) => {
      setText(e.target.value);
      const v = e.target.value.trim();
      if (/^#?[0-9a-fA-F]{6}$/.test(v)) onChange((v.startsWith("#") ? v : `#${v}`).toLowerCase());
    }} />;
}

function BackgroundPicker({ s, set, onError }: { s: Settings; set: (p: Settings) => Promise<void>; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  return <>
    <label>Background</label>
    <div className="bg-preview" style={s.background ? { backgroundImage: `url("${s.background}")` } : undefined}>
      {!s.background && <span className="muted small" style={{ marginRight: "auto" }}>No background picture</span>}
      <label className="btn small" style={{ margin: 0 }}>{busy ? "Uploading…" : s.background ? "Change" : "Choose a picture"}
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden disabled={busy} onChange={async (e) => {
          const file = e.target.files?.[0]; e.target.value = "";
          if (!file) return;
          setBusy(true);
          try { await set({ background: (await api<{ url: string }>("/me/background", { raw: file })).url }); }
          catch (err) { onError((err as Error).message); } finally { setBusy(false); }
        }} /></label>
      {s.background && <button className="btn small" onClick={() => void set({ background: null })}>Remove</button>}
    </div>
    {s.background && <label>Panels: {Math.round((s.background_opacity ?? 0.8) * 100)}% solid
      <input type="range" min={0.2} max={1} step={0.05} value={s.background_opacity ?? 0.8}
        onChange={(e) => void set({ background_opacity: Number(e.target.value) })} />
    </label>}
  </>;
}

function CustomCss({ s, set }: { s: Settings; set: (p: Settings) => Promise<void> }) {
  const [css, setCss] = useState(s.custom_css ?? "");
  const changed = css !== (s.custom_css ?? "");
  return <>
    <label>Custom CSS
      <textarea className="css-editor" value={css} maxLength={20000} spellCheck={false} placeholder={".main { border-radius: 16px; }\n:root { --panel: #1a1b2e; }"}
        onChange={(e) => setCss(e.target.value)} />
    </label>
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <button className="btn primary small" disabled={!changed} onClick={() => void set({ custom_css: css })}>Save CSS</button>
      {(s.custom_css ?? "") && <button className="btn small" onClick={() => { setCss(""); void set({ custom_css: "" }); }}>Turn off</button>}
      <span className="muted small grow">Only changes how Jace Social looks for you. Don&apos;t paste CSS from people you don&apos;t trust.
        {cssDisabled() ? " Custom CSS is off for this visit (?nocss)." : " If it hides something, open the app with ?nocss at the end of the address."}</span>
    </div>
  </>;
}

function SoundsTab(props: SettingsProps) {
  const { s, set } = useSettings(props);
  return <SoundSettings me={props.me} s={s} set={set} onError={props.onError} />;
}

function NotificationsTab(props: SettingsProps) {
  const { s, set } = useSettings(props);
  return <>
    <h2>Notifications</h2>
    <label>Notify me about
      <select value={s.notify ?? "all"} onChange={(e) => void set({ notify: e.target.value as Settings["notify"] })}>
        <option value="all">All messages</option><option value="mentions">Only direct messages, @mentions and replies</option><option value="none">Nothing</option>
      </select>
    </label>
    <Toggle label="Pop-up notifications" desc="When Jace Social isn't the window you're using" checked={s.desktop_notifications !== false} onChange={(v) => void set({ desktop_notifications: v })} />
    <Toggle label="Sounds" desc="For messages and calls" checked={s.sounds !== false} onChange={(v) => void set({ sounds: v })} />
    <p className="muted small" style={{ margin: 0 }}>Do Not Disturb (in your status) turns notifications off. Right-click a server or chat in the sidebar to mute just that one.</p>
  </>;
}

function LinksTab(props: SettingsProps) {
  const { s, set } = useSettings(props);
  const [domain, setDomain] = useState("");
  const trusted = s.trusted_domains ?? [];
  return <>
    <h2>Links & privacy</h2>
    <Toggle label="Warn me before opening links" desc="Shows where a link really goes before you leave Jace Social" checked={s.link_warning !== false} onChange={(v) => void set({ link_warning: v })} />
    <label>Trusted sites (no warning)</label>
    {trusted.length === 0 && <p className="muted small" style={{ margin: 0 }}>None yet. You can trust a site from the warning, too.</p>}
    <div className="chips">{trusted.map((d) => <span key={d} className="chip">{d} <button className="icon-btn small" onClick={() => void set({ trusted_domains: trusted.filter((x) => x !== d) })}>✕</button></span>)}</div>
    <form style={{ display: "flex", gap: 8 }} onSubmit={(e) => { e.preventDefault(); const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]; if (d) { void set({ trusted_domains: [...new Set([...trusted, d])] }); setDomain(""); } }}>
      <input placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
      <button className="btn" disabled={!domain.trim()}>Trust</button>
    </form>
    <p className="muted small" style={{ margin: 0 }}>Link previews are fetched by the Jace Social server, so websites you see previews of don't get your IP address.</p>
  </>;
}

function AdvancedTab(props: SettingsProps) {
  const { s, set } = useSettings(props);
  return <>
    <h2>Advanced</h2>
    <Toggle label="Developer mode" desc="Show buttons to copy ids of messages, people, channels and servers (useful for bots)" checked={!!s.developer} onChange={(v) => void set({ developer: v })} />
    {s.developer && <div className="card small">Your id: <code className="inline-code">{props.me.uuid}</code>
      <button className="icon-btn small" onClick={() => navigator.clipboard?.writeText(props.me.uuid)}>⧉</button></div>}
  </>;
}

/** Settings -> Accounts: syncing your direct messages and group chats with your Jace messages. */
export function JaceMessagesCard({ me, onConnect, onError }: { me: Me; onConnect: () => Promise<void>; onError: Err }) {
  const [info, setInfo] = useState<JaceMessages | null>(me.jace_messages ?? null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => { api<JaceMessages>("/jace/messages").then(setInfo).catch(() => {}); }, [me.jace_messages?.state]);
  if (!info || !info.available) return null;
  const run = async (fn: () => Promise<JaceMessages & { imported?: number | boolean }>, done?: (r: JaceMessages & { imported?: number | boolean }) => string) => {
    setBusy(true); setNote("");
    try { const r = await fn(); setInfo(r); if (done) setNote(done(r)); } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  const connected = info.state === "ok";
  return (
    <div className="card" style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1 }}><b>Jace messages</b>
          <div className="muted small">{
            info.state === "banned" ? "Your Jace account is banned, so your messages don't sync with Jace."
            : info.state === "none" || (!info.sync_enabled && !info.imported) ? "Bring your Jace conversations here, and keep them in sync."
            : info.state === "disconnected" ? "Not connected - reconnect to keep your messages in sync."
            : !info.sync_enabled ? "Syncing is off."
            : info.last_sync_at ? `Last synced ${new Date(info.last_sync_at).toLocaleString()}` : "Bringing your Jace messages in…"}</div>
        </div>
        {(info.state === "none" || info.state === "disconnected") &&
          <button className="btn primary small" onClick={() => void (async () => {
            const was = info.state;
            await onConnect();                                // signs in with Jace again for a token
            const now = await api<JaceMessages>("/jace/messages").catch(() => null);
            // "Connect" means "sync my messages": switch it on (Reconnect keeps what it was)
            if (was === "none" && now?.state === "ok" && !now.sync_enabled)
              await run(() => api("/jace/messages", { method: "PATCH", body: { sync: true } }));
            else if (now) setInfo(now);
          })()}>{info.state === "none" ? "Connect" : "Reconnect Jace"}</button>}
      </div>
      {connected && <>
        <label className="check"><input type="checkbox" checked={info.sync_enabled} disabled={busy}
          onChange={(e) => void run(() => api("/jace/messages", { method: "PATCH", body: { sync: e.target.checked } }))} />
          Sync messages with Jace</label>
        <p className="muted small" style={{ margin: 0 }}>Messages between you and other Jace people (and in group chats that came from Jace) are also saved to your Jace account. Text only.</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn small" disabled={busy || !info.sync_enabled}
            onClick={() => void run(() => api("/jace/messages/sync", { method: "POST" }), (r) => `Synced${typeof r.imported === "number" && r.imported ? ` - ${r.imported} new` : ""}`)}>
            {busy ? "Syncing…" : "Sync now"}</button>
          <button className="btn small danger" disabled={busy}
            onClick={() => { if (confirm("Disconnect your Jace messages? Jace Social stops syncing with Jace and deletes its access to your Jace messages. Messages already here stay.")) void run(() => api("/jace/messages", { method: "DELETE" })); }}>
            Disconnect Jace messages</button>
        </div>
      </>}
      {info.last_error && info.state === "ok" && <div className="muted small">Last problem: {info.last_error}</div>}
      {note && <div className="muted small">{note}</div>}
    </div>
  );
}

type MyBot = { uuid: string; name: string; avatar_url: string | null; official?: boolean };

/** Switch to one of your bots: always a fresh session for it (an old saved one may have stopped
 *  working - a new bot token ends them), kept on this device, then switch. */
async function switchToBot(b: MyBot, onError: Err) {
  try {
    const s = await api<{ token: string; uuid: string; name: string; avatar_url: string | null }>(`/bots/${b.uuid}/session`, { body: {} });
    rememberAccount({ uuid: s.uuid, name: s.name, avatar_url: s.avatar_url, is_bot: true }, s.token);
    const problem = await switchAccount(s.uuid);
    if (problem) onError(problem);
  } catch (e) { onError((e as Error).message); }
}

/** Signed in as a bot: back to the account that owns it (saved on this device), or sign in to it. */
export function BackToMyAccount({ me, onAdd, onError = (m) => alert(m) }: { me: Me; onAdd: () => void; onError?: Err }) {
  const owner = savedAccounts().find((a) => a.uuid === me.bot_owner) ?? savedAccounts().find((a) => !a.is_bot);
  return owner
    ? <button className="btn primary" onClick={async () => {
        const problem = await switchAccount(owner.uuid);
        if (problem) { onError(problem); onAdd(); }                // expired: sign in to it again
      }}>← Back to your account ({owner.name})</button>
    : <button className="btn primary" onClick={onAdd}>← Sign in to your account</button>;
}

/** Accounts on this device and your bots: switch with one click, add another, or remove one. */
export function AccountSwitcher({ me, compact, onError = () => {}, noBack }: { me: Me; compact?: boolean; onError?: Err; noBack?: boolean }) {
  const [list, setList] = useState(savedAccounts());
  const [adding, setAdding] = useState(false);
  const [bots, setBots] = useState<MyBot[]>([]);
  useEffect(() => {
    if (me.is_bot) return;
    api<{ bots: MyBot[] }>("/bots").then((r) => {
      const mine = r.bots ?? [];
      // the people running the official Jace bot (its owner, Jace's admins) can switch to it too
      setBots(me.jace_staff && !mine.some((b) => b.uuid === JACE_BOT)
        ? [...mine, { uuid: JACE_BOT, name: "Jace", avatar_url: "/jace-bot.png", official: true }] : mine);
    }).catch(() => {});
  }, [me.is_bot, me.jace_staff]);
  const unsavedBots = bots.filter((b) => !list.some((a) => a.uuid === b.uuid));
  return (
    <div className="account-list">
      {me.is_bot && !noBack && <BackToMyAccount me={me} onAdd={() => setAdding(true)} onError={onError} />}
      {list.map((a) => (
        <div key={a.uuid} className={`account-row${a.uuid === me.uuid ? " current" : ""}`}>
          <Avatar p={{ name: a.name, avatar_url: a.avatar_url }} size={compact ? 28 : 36} />
          <div className="grow"><b>{a.name}</b><BotTag p={a} style={{ marginLeft: 6 }} />
            {a.uuid === me.uuid && <div className="muted small">Signed in</div>}</div>
          {a.uuid !== me.uuid && <button className="btn small primary" onClick={async () => {
            const bot = bots.find((b) => b.uuid === a.uuid);
            if (bot) { await switchToBot(bot, onError); return; }  // your bot: a fresh sign-in for it
            const problem = await switchAccount(a.uuid);
            if (problem) { onError(problem); setList(savedAccounts()); }
          }}>Switch</button>}
          {a.uuid !== me.uuid && <button className="icon-btn" title="Remove from this device" onClick={() => { forgetAccount(a.uuid); setList(savedAccounts()); }}>✕</button>}
        </div>
      ))}
      {unsavedBots.map((b) => (
        <div key={b.uuid} className="account-row">
          <Avatar p={b} size={compact ? 28 : 36} />
          <div className="grow"><b>{b.name}</b><BotTag p={{ is_bot: true, official: b.official, uuid: b.uuid }} style={{ marginLeft: 6 }} />
            <div className="muted small">Your bot</div></div>
          <button className="btn small primary" onClick={() => void switchToBot(b, onError)}>Switch</button>
        </div>
      ))}
      <button className="btn small" style={{ justifySelf: "start" }} onClick={() => setAdding(true)}>＋ Add an account</button>
      {adding && <AddAccountModal me={me} onClose={() => setAdding(false)} />}
    </div>
  );
}

/** The desktop app's version: one-click updates, and deleting the app. */
function DesktopVersion() {
  const [d, setD] = useState<DesktopBridge | null>(null);
  const [state, setState] = useState<{ busy?: boolean; text?: string; latest?: string }>({});
  const [auto, setAuto] = useState<boolean | null>(null);
  useEffect(() => {
    void desktopReady().then((b) => {
      if (!b?.checkForUpdate) return;
      setD(b);
      void b.getAutoUpdateCheck?.().then(setAuto);
    });
  }, []);
  if (!d) return null;
  async function check() {
    setState({ busy: true });
    const r = await d!.checkForUpdate!();
    setState(r.error ? { text: r.error } : r.newer ? { latest: r.latest } : { text: "You're up to date" });
  }
  return (
    <div className="muted small" style={{ padding: "12px 8px 0", display: "grid", gap: 6 }}>
      <span>Desktop app {d.version}</span>
      {state.latest && d.applyUpdate
        ? <button className="btn primary small" onClick={() => d.applyUpdate!()}>Update to {state.latest}</button>
        : <button className="btn small" disabled={state.busy} onClick={check}>{state.busy ? "Checking…" : "Check for updates"}</button>}
      {state.text && <span>{state.text}</span>}
      {auto !== null && (
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); d.setAutoUpdateCheck?.(e.target.checked); }} />
          Check for updates on startup
        </label>
      )}
      {d.getDesktopSettings && <DesktopOptions d={d} />}
      {d.quit && <button className="btn small" style={{ justifySelf: "start" }} onClick={() => d.quit!()}
        title="Closing the window keeps Jace Social running so messages still reach you">Quit Jace Social (Ctrl+Q)</button>}
      {d.installed && d.deleteApp &&
        <button className="btn danger small" onClick={() => d.deleteApp!()}>Delete Jace Social…</button>}
    </div>
  );
}

/** Desktop app: open on sign-in, and the shortcut for the game overlay. */
function DesktopOptions({ d }: { d: DesktopBridge }) {
  const [s, setS] = useState<{ startup: boolean | null; overlayShortcut: string; overlayError: string | null; shortcutsUnsupported: string | null;
    overlayBoundAs?: string | null; overlayManagedByDesktop?: boolean } | null>(null);
  const [recording, setRecording] = useState(false);
  const [msg, setMsg] = useState("");
  const load = () => void d.getDesktopSettings!().then(setS);
  useEffect(load, [d]);       // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === "Escape") { setRecording(false); return; }
      if (["Control", "Shift", "Alt", "Meta", "AltGraph", "OS"].includes(e.key)) return;     // wait for the real key
      const mods = [e.ctrlKey && "Ctrl", e.shiftKey && "Shift", e.altKey && "Alt", e.metaKey && "Meta"].filter(Boolean);
      const key = e.code.startsWith("Key") ? e.code.slice(3) : e.code.startsWith("Digit") ? e.code.slice(5)
        : /^F\d+$/.test(e.code) ? e.code : e.code === "Space" ? "Space" : e.code === "Backquote" ? "`" : e.code === "Tab" ? "Tab" : e.key;
      setRecording(false);
      if (!mods.length) { setMsg("Hold Ctrl, Shift, Alt or Meta too - like Ctrl+Shift+J"); return; }
      void save([...mods, key].join("+"));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);     // eslint-disable-line react-hooks/exhaustive-deps
  async function save(combo: string) {
    const r = await d.setOverlayShortcut!(combo);
    setMsg(r.error ?? (combo ? `${r.note ? r.note + ". Then press" : "Press"} ${combo} in a game to open Jace Social on top of it` : "Overlay shortcut turned off"));
    load();
  }
  if (!s) return null;
  return (
    <div style={{ display: "grid", gap: 6, paddingTop: 6 }}>
      <label style={{ display: "flex", gap: 6, alignItems: "center", opacity: s.startup === null ? 0.6 : 1 }}
        title={s.startup === null ? "Install Jace Social first (open the download and finish setup)" : undefined}>
        <input type="checkbox" checked={!!s.startup} disabled={s.startup === null}
          onChange={async (e) => { const r = await d.setStartup!(e.target.checked); if (r.error) setMsg(r.error); load(); }} />
        Open Jace Social when I sign in to my computer
      </label>
      <span>Game overlay shortcut</span>
      {s.shortcutsUnsupported ? <span>{s.shortcutsUnsupported}</span> : s.overlayManagedByDesktop ? (
        // Wayland: the desktop asks to allow the shortcut, and its settings choose the keys
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {s.overlayShortcut ? <>
            <span>Press <b>{s.overlayBoundAs || "your shortcut"}</b> to open Jace Social on top of a game.</span>
            {d.configureOverlayShortcut && <button className="btn small" onClick={async () => {
              const r = await d.configureOverlayShortcut!();
              setMsg(r.error ?? "Pick the keys in your desktop's window, then come back");
              setTimeout(load, 4000);
            }}>Change keys…</button>}
            <button className="btn small" onClick={() => void save("")}>Turn off</button>
          </> : <button className="btn small" onClick={() => void save("Ctrl+Shift+J")}>Turn on the overlay shortcut</button>}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <button className={`btn small${recording ? " primary" : ""}`} onClick={() => { setMsg(""); setRecording(!recording); }}>
            {recording ? "Press the keys… (Esc to cancel)" : s.overlayShortcut || "Set shortcut"}</button>
          {s.overlayShortcut && !recording && <button className="btn small" onClick={() => void save("")}>Turn off</button>}
        </div>
      )}
      {(msg || s.overlayError) && <span>{msg || s.overlayError}</span>}
    </div>
  );
}

export function StatusEditor({ me, onSaved, onError }: { me: Me; onSaved: (m: Me) => void; onError: Err }) {
  const [custom, setCustom] = useState(me.custom_status ?? "");
  const [emoji, setEmoji] = useState(me.status_emoji ?? "");
  async function set(body: Record<string, unknown>) {
    try { onSaved(await api<Me>("/me", { method: "PATCH", body })); } catch (e) { onError((e as Error).message); }
  }
  return <>
    <h2>Status</h2>
    <div style={{ display: "grid", gap: 4 }}>
      {(["online", "idle", "dnd", "invisible"] as Status[]).map((s) => (
        <button key={s} className={`side-item${me.status === s ? " active" : ""}`} onClick={() => set({ status: s })}>
          <span className="avatar" style={{ width: 14, height: 14 }}><span className={`dot ${s}`} style={{ inset: 0, width: 14, height: 14, border: 0 }} /></span>
          <span className="name">{statusLabel[s]}<span className="sub">{s === "dnd" ? "No notification pop-ups" : s === "invisible" ? "You'll look offline, but can still use everything" : s === "idle" ? "Show that you're away" : "Show that you're around"}</span></span>
        </button>
      ))}
    </div>
    <label>Custom status</label>
    <div style={{ display: "grid", gridTemplateColumns: "64px 1fr auto auto", gap: 6 }}>
      <input placeholder="😀" value={emoji} maxLength={16} onChange={(e) => setEmoji(e.target.value)} />
      <input placeholder="What's up?" value={custom} maxLength={80} onChange={(e) => setCustom(e.target.value)} />
      <button className="btn primary small" onClick={() => set({ custom_status: custom, status_emoji: emoji })}>Set</button>
      <button className="btn small" onClick={() => { setCustom(""); setEmoji(""); void set({ custom_status: null, status_emoji: null }); }}>Clear</button>
    </div>
  </>;
}

// ---------------------------------------------------------------------------------
// New group chat
// ---------------------------------------------------------------------------------
export function NewGroupModal({ friends, onClose, onCreated, onError }: {
  friends: Person[]; onClose: () => void; onCreated: (id: string) => void; onError: Err;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  async function create() {
    try {
      const r = await api<{ group: { id: string } }>("/groups", { body: { name, members: picked } });
      onCreated(r.group.id); onClose();
    } catch (e) { onError((e as Error).message); }
  }
  return (
    <Modal onClose={onClose}>
      <div className="modal-body">
        <h2>New group chat</h2>
        <p className="muted small" style={{ margin: 0 }}>Pick up to 9 friends.</p>
        <input placeholder="Group name (optional)" value={name} maxLength={48} onChange={(e) => setName(e.target.value)} />
        <div style={{ maxHeight: 320, overflowY: "auto" }}>
          {friends.length === 0 && <p className="muted">Add some friends first.</p>}
          {friends.map((p) => (
            <PersonRow key={p.uuid} p={p} onClick={() => setPicked((x) => x.includes(p.uuid) ? x.filter((u) => u !== p.uuid) : x.length < 9 ? [...x, p.uuid] : x)}>
              <input type="checkbox" style={{ width: 18 }} checked={picked.includes(p.uuid)} readOnly />
            </PersonRow>
          ))}
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!picked.length} onClick={create}>Create group</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------
// Create or join a server
// ---------------------------------------------------------------------------------
export function AddServerModal({ onClose, onDone, onError, initialCode }: {
  onClose: () => void; onDone: (id: string) => void; onError: Err; initialCode?: string;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState(initialCode ?? "");
  async function create() {
    try { const r = await api<{ server: { id: string } }>("/servers", { body: { name } }); onDone(r.server.id); onClose(); }
    catch (e) { onError((e as Error).message); }
  }
  async function join() {
    const c = code.trim().replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() ?? "";
    try { const r = await api<{ server: { id: string } }>(`/invites/${encodeURIComponent(c)}`, { body: {} }); onDone(r.server.id); onClose(); }
    catch (e) { onError((e as Error).message); }
  }
  return (
    <Modal onClose={onClose}>
      <div className="modal-body">
        <h2>Create a server</h2>
        <p className="muted small" style={{ margin: 0 }}>A place for you and your friends, with text channels.</p>
        <div style={{ display: "flex", gap: 8 }}>
          <input placeholder="Server name" value={name} maxLength={48} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) void create(); }} />
          <button className="btn primary" disabled={!name.trim()} onClick={create}>Create</button>
        </div>
        <h2 style={{ marginTop: 10 }}>Join a server</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <input placeholder="Invite code or link" value={code} onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && code.trim()) void join(); }} />
          <button className="btn primary" disabled={!code.trim()} onClick={join}>Join</button>
        </div>
      </div>
    </Modal>
  );
}

