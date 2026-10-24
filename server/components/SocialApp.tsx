"use client";
// The Jace Social app: friends, direct messages, group chats, servers, voice and bots.
// The desktop app shows this same page (with a small bridge for Microsoft sign-in,
// notifications and updates).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api, connectLive, desktop, desktopReady, getToken, inDesktop, joinAddress, setToken, statusLabel, type Channel, type Group,
  type Me, type Person, type ServerDetail, type ServerItem, type Settings,
} from "@/lib/client";
import { rememberAccount } from "@/lib/accounts";
import { Calls } from "@/lib/calls";
import { has, P } from "@/lib/permbits";
import { applySettings } from "@/lib/theme";
import { Voice } from "@/lib/voice";
import { CallPanel, useCall } from "./CallPanel";
import { ChannelSettings } from "./ChannelSettings";
import { Chat } from "./Chat";
import { LinkGuard } from "./Markdown";
import { nameStyle } from "./Message";
import { MinecraftDevice } from "./MinecraftDevice";
import { hasAgreed, LegalDialog } from "./Legal";
import { isDeletingAccount, RecoveryNotice } from "./DeleteAccount";
import { Appeals, type AppealRow } from "./Appeals";
import { AddFriendForm } from "./AddFriend";
import { unlockSounds } from "@/lib/sounds";
import { MobileUpdate } from "./MobileUpdate";
import { NewVersion } from "./NewVersion";
import { Announcements, BotTag, Broadcast, Docs, JACE_BOT, JaceInbox, JaceTabs, inboxPerson, type InboxEntry, type JaceTab } from "./JaceBot";
import { AccountSwitcher, AddServerModal, NewGroupModal, ProfileModal, SettingsModal, StatusEditor, type SettingsTab } from "./Modals";
import { ServerOnboarding, Welcome } from "./Onboarding";
import { inviteLink, ServerSettings } from "./ServerSettings";
import { ActivityCard, Avatar, PersonRow } from "./ui";
import { useVoice, VoiceBar, VoiceRoom, VoiceUsers } from "./Voice";

type FriendsData = { friends: Person[]; incoming: Person[]; outgoing: Person[]; jace?: Person | null };
type View =
  | { kind: "home" }
  | { kind: "dm"; uuid: string }
  | { kind: "group"; id: string }
  | { kind: "server"; id: string; channel?: string }
  | { kind: "appeals"; user: string | null }
  | { kind: "broadcast" };
type ModalState =
  | { kind: "settings"; tab?: SettingsTab } | { kind: "group" } | { kind: "server" } | { kind: "serverSettings"; tab?: "invites" }
  | { kind: "channel"; channel: Channel } | { kind: "status" } | { kind: "welcome" } | { kind: "serverWelcome" } | null;

export default function SocialApp({ inviteCode }: { inviteCode?: string }) {
  const [token, setTok] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");

  // Sign-in result from Jace comes back in the #fragment (never sent to servers or logs).
  useEffect(() => {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("token")) { setToken(h.get("token")); history.replaceState(null, "", location.pathname + location.search); }
    if (h.get("error")) setError(h.get("error")!);
    setTok(getToken());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!token) return;
    api<Me>("/me").then((m) => {
      setMe(m);
      rememberAccount({ uuid: m.uuid, name: m.name, avatar_url: m.avatar_url, is_bot: m.is_bot });   // for the account switcher
    }).catch((e) => {
      if (e.status === 401) { if (!isDeletingAccount()) { setToken(null); setTok(null); } } else setError(e.message);
    });
  }, [token]);

  useEffect(() => { if (me) applySettings(me.settings ?? {}); }, [me?.settings]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Saving your profile answers with your profile only (no appeals / jace_staff / jace_messages):
  // merge it into what we have instead of losing those.
  const mergeMe = useCallback((m: Me) => setMe((prev) => (prev && prev.uuid === m.uuid ? { ...prev, ...m } : m)), []);

  if (!ready) return null;
  if (!token) return <SignIn error={error} inviteCode={inviteCode} />;
  if (!me) return <div className="center"><div className="muted">{error || "Loading Jace Social…"}</div></div>;
  return (
    <LinkGuard warn={me.settings?.link_warning !== false} trusted={me.settings?.trusted_domains ?? []}
      onTrust={(d) => {
        const trusted = [...new Set([...(me.settings?.trusted_domains ?? []), d])];
        setMe({ ...me, settings: { ...me.settings, trusted_domains: trusted } });
        void api<Me>("/me", { method: "PATCH", body: { settings: { trusted_domains: trusted } } }).then(mergeMe).catch(() => {});
      }}>
      <Main me={me} setMe={mergeMe} inviteCode={inviteCode}
        signOut={async () => { await api("/auth/signout", { body: {} }).catch(() => {}); setToken(null); setTok(null); setMe(null); }} />
    </LinkGuard>
  );
}

function SignIn({ error, inviteCode }: { error: string; inviteCode?: string }) {
  const back = inviteCode ? `/invite/${inviteCode}` : "/app";
  const [app, setApp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [device, setDevice] = useState(false);
  const [legal, setLegal] = useState<null | (() => void)>(null);   // the Terms popup, then this sign-in
  useEffect(() => { setApp(inDesktop()); }, []);
  const jaceUrl = `/api/v1/auth/jace?return_to=${encodeURIComponent(back)}`;
  /** Shows the Terms and Privacy popup the first time on this device, then signs in. */
  const agreeThen = (go: () => void) => (hasAgreed() ? go() : setLegal(() => go));
  async function minecraft() {
    setBusy(true); setProblem("");
    const d = await desktopReady();
    const r = d ? await d.signInMinecraft() : { error: "The desktop app isn't ready yet - try again" };
    setBusy(false);
    if (r.token) { setToken(r.token); location.reload(); } else setProblem(r.error ?? "Sign-in failed");
  }
  if (device) {
    return (
      <div className="center"><div className="signin">
        <MinecraftDevice<{ token: string }> mode="signin" onCancel={() => setDevice(false)}
          onDone={(r) => { setToken(r.token); location.href = back; }} />
      </div></div>
    );
  }
  return (
    <div className="center">
      <div className="signin">
        <h1>Jace Social</h1>
        <p className="muted">Friends, chat and servers - with Minecraft built in.</p>
        {(error || problem) && <p className="error">{problem || error}</p>}
        <a className="btn primary" style={{ display: "block", padding: 12, textDecoration: "none", margin: "20px 0 10px" }}
          href={jaceUrl} onClick={(e) => { if (!hasAgreed()) { e.preventDefault(); agreeThen(() => { location.href = jaceUrl; }); } }}>Sign in with Jace</a>
        {app
          ? <button className="btn" style={{ display: "block", width: "100%", padding: 12 }} disabled={busy} onClick={() => agreeThen(() => void minecraft())}>
              {busy ? "Signing in…" : "⛏ Sign in with Minecraft"}</button>
          : <button className="btn" style={{ display: "block", width: "100%", padding: 12 }} onClick={() => agreeThen(() => setDevice(true))}>
              ⛏ Sign in with Minecraft</button>}
        <p className="muted small" style={{ marginBottom: 0 }}>By signing in you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</p>
        <RecoveryNotice />
        {legal && <LegalDialog onClose={() => setLegal(null)} onAgree={() => { const go = legal; setLegal(null); go(); }} />}
      </div>
    </div>
  );
}


/** A soft "ding" for messages and mentions (Settings -> Notifications -> Sounds). */
function ding(high = false) {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = high ? 1046 : 784;
    g.gain.setValueAtTime(0.06, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.35);
    setTimeout(() => void ctx.close(), 600);
  } catch { /* no audio */ }
}

const COLLAPSED = "jace_social_collapsed";

function Main({ me, setMe, signOut, inviteCode }: {
  me: Me; setMe: (m: Me) => void; signOut: () => void; inviteCode?: string;
}) {
  const [view, setView] = useState<View>({ kind: "home" });
  const [friends, setFriends] = useState<FriendsData>({ friends: [], incoming: [], outgoing: [] });
  const [groups, setGroups] = useState<Group[]>([]);
  const [jaceTab, setJaceTab] = useState<JaceTab>("chat");
  const [jaceInbox, setJaceInbox] = useState<InboxEntry[]>([]);
  const [appealsUnread, setAppealsUnread] = useState(0);
  const [appealsRefresh, setAppealsRefresh] = useState(0);
  const appealsOn = !!me.appeals && me.appeals !== "none";
  const [servers, setServers] = useState<ServerItem[]>([]);
  const [detail, setDetail] = useState<ServerDetail | null>(null);
  const [reload, setReload] = useState(0);              // bump to reload the open chat
  const [profile, setProfile] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(inviteCode ? { kind: "server" } : !me.onboarded && !me.is_bot ? { kind: "welcome" } : null);
  const [toast, setToast] = useState("");
  const [mobileMain, setMobileMain] = useState(false);
  const [typing, setTyping] = useState<Record<string, Record<string, { name: string; until: number }>>>({});
  const [pins, setPins] = useState(false);
  const [showMembers, setShowMembers] = useState(true);
  const [menu, setMenu] = useState<"account" | "server" | null>(null);
  const [collapsed, setCollapsed] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(COLLAPSED) ?? "[]"); } catch { return []; } });
  const [groupCall, setGroupCall] = useState<Record<string, number>>({});
  const viewRef = useRef(view);
  viewRef.current = view;
  const settings: Settings = me.settings ?? {};
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const err = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(""), 5000); }, []);
  const meRef = useRef(me);
  meRef.current = me;
  /** Pop-up + sound, following your settings (Do Not Disturb, mentions only, muted chats). */
  const notifyUser = useCallback((title: string, body: string, opts: { important?: boolean; muteKey?: string[]; onClick?: () => void } = {}) => {
    const s = settingsRef.current;
    if (meRef.current.status === "dnd" || s.notify === "none") return;
    if (s.notify === "mentions" && !opts.important) return;
    if (opts.muteKey?.some((k) => s.muted?.includes(k)) && !opts.important) return;
    if (document.hasFocus()) return;
    if (s.sounds !== false) ding(opts.important);
    if (s.desktop_notifications === false) return;
    const d = desktop();
    if (d) d.notify(title, body);
    else if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification(title, { body });
      if (opts.onClick) n.onclick = () => { window.focus(); opts.onClick!(); n.close(); };
    }
  }, []);
  const [calls] = useState(() => new Calls(err, (name) => notifyUser(`${name} is calling`, "Open Jace Social to answer", { important: true })));
  const call = useCall(calls);
  // calls ring even when a live event was missed (phones in the background), with your own sounds,
  // and phones are allowed to play them (unlocked on your first tap)
  useEffect(() => { unlockSounds(); calls.watch(); return () => calls.unwatch(); }, [calls]);
  useEffect(() => { calls.setSounds({ ringtone: settings.ringtone, calling: settings.calling_sound }); }, [calls, settings.ringtone, settings.calling_sound]);
  // Jace Launcher (voice only) sends people here to see video: #move_call=<call id>&peer=<uuid>&name=<name>
  // ...or to join a voice room here: #join_voice=<channel id>&server=<server id or empty>&name=<channel name>
  const [moveCall, setMoveCall] = useState<{ id: string; peer: string; name: string } | null>(null);
  const [moveVoice, setMoveVoice] = useState<{ id: string; server: string | null; name: string } | null>(null);
  useEffect(() => {
    const h = new URLSearchParams(location.hash.slice(1));
    const id = h.get("move_call"), peer = h.get("peer"), room = h.get("join_voice");
    if (id && peer) setMoveCall({ id, peer, name: h.get("name") ?? "" });
    if (room) setMoveVoice({ id: room, server: h.get("server") || null, name: h.get("name") ?? "" });
    if ((id && peer) || room) history.replaceState(null, "", location.pathname + location.search);
  }, []);
  const [voice] = useState(() => new Voice(err));
  const room = useVoice(voice);
  useEffect(() => {
    const bye = () => { calls.hangUp(); void voice.leave(); };
    window.addEventListener("pagehide", bye);
    return () => { window.removeEventListener("pagehide", bye); bye(); };
  }, [calls, voice]);

  const loadFriends = useCallback(() => api<FriendsData>("/friends").then(setFriends).catch((e) => err(e.message)), [err]);
  const loadInbox = useCallback(() => {
    if (me.uuid !== JACE_BOT) return;
    void api<{ people: InboxEntry[] }>("/jace-bot/inbox").then((d) => setJaceInbox(d.people)).catch(() => {});
  }, [me.uuid]);
  useEffect(() => { loadInbox(); }, [loadInbox]);
  useEffect(() => {                                     // the Appeals unread count (staff only)
    if (!appealsOn) return;
    api<{ appeals: AppealRow[] }>("/appeals").then((r) => setAppealsUnread(r.appeals.filter((x) => x.unread).length)).catch(() => {});
  }, [appealsOn]);
  const loadGroups = useCallback(() => api<{ groups: Group[] }>("/groups").then((d) => setGroups(d.groups)).catch((e) => err(e.message)), [err]);
  const loadServers = useCallback(() => api<{ servers: ServerItem[] }>("/servers").then((d) => setServers(d.servers)).catch((e) => err(e.message)), [err]);
  const loadDetail = useCallback(async (id: string) => {
    try {
      const d = await api<ServerDetail>(`/servers/${id}`);
      setDetail(d);
      return d;
    } catch (e) { err((e as Error).message); setView({ kind: "home" }); return null; }
  }, [err]);
  const loadGroupCall = useCallback(async (id: string) => {
    try { const r = await api<{ participants: unknown[] }>(`/channels/${id}/voice`); setGroupCall((g) => ({ ...g, [id]: r.participants.length })); } catch { /* not a member */ }
  }, []);

  useEffect(() => { void loadFriends(); void loadGroups(); void loadServers(); }, [loadFriends, loadGroups, loadServers]);

  useEffect(() => {
    if (desktop() || !("Notification" in window) || Notification.permission !== "default") return;
    const ask = () => { void Notification.requestPermission(); window.removeEventListener("click", ask); };
    window.addEventListener("click", ask);
    return () => window.removeEventListener("click", ask);
  }, []);

  // presence: "using the Jace Social app" every 2 minutes; offline when the page closes
  useEffect(() => {
    const beat = () => api("/presence", { body: { activity: { type: "app", app: desktop() ? "jace-social-desktop" : "jace-social-web" } } }).catch(() => {});
    void beat();
    const t = setInterval(beat, 120_000);
    const bye = () => { void api("/presence", { body: { activity: null, offline: true, app: true } }).catch(() => {}); };
    window.addEventListener("pagehide", bye);
    return () => { clearInterval(t); window.removeEventListener("pagehide", bye); };
  }, []);

  // everyone we know: friends, group members, the open server's members (with nicknames and roles)
  const people = useMemo(() => {
    const m: Record<string, Person> = {};
    for (const f of [...friends.friends, ...friends.incoming, ...friends.outgoing]) m[f.uuid] = f;
    if (friends.jace) m[friends.jace.uuid] = friends.jace;                 // the official Jace bot
    for (const e of jaceInbox) m[e.uuid] ??= inboxPerson(e);              // signed in as the Jace bot: who wrote to it
    for (const g of groups) for (const p of g.members) m[p.uuid] ??= p;
    for (const p of detail?.members ?? []) m[p.uuid] = p;
    return m;
  }, [friends, groups, detail, jaceInbox]);

  // live updates
  useEffect(() => {
    let presenceTimer: ReturnType<typeof setTimeout> | null = null;
    let detailTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshDetail = (id: string) => {
      if (detailTimer) return;
      detailTimer = setTimeout(() => { detailTimer = null; if (viewRef.current.kind === "server" && viewRef.current.id === id) void loadDetail(id); }, 400);
    };
    return connectLive(me.realtime, me.inbox, (event, p) => {
      const v = viewRef.current;
      if (event === "message") {
        if (v.kind === "dm" && v.uuid === p.from) setReload((n) => n + 1);
        else notifyUser(`${p.name ?? "A friend"}`, "Sent you a message", { important: true, muteKey: [p.from] });
        clearTyping(`dm:${p.from}`, p.from);
        void loadFriends();
        loadInbox();
      } else if (event === "dm_update") {
        if (v.kind === "dm" && (v.uuid === p.from || v.uuid === p.with)) setReload((n) => n + 1);
      } else if (event === "friends") {
        void loadFriends();
        if (p.kind === "request") notifyUser("Friend request", `${p.name} wants to be friends`, { important: true });
      } else if (event === "presence") {
        if (!presenceTimer) presenceTimer = setTimeout(() => { presenceTimer = null; void loadFriends(); }, 1500);
      } else if (event === "channel") {
        const open = (v.kind === "group" && v.id === p.channel_id) || (v.kind === "server" && v.channel === p.channel_id);
        if (open) setReload((n) => n + 1);
        else if (!p.edited && !p.deleted && !p.reacted && p.name) {
          notifyUser(p.name, p.mentioned ? "Mentioned you" : p.server_id ? "New message in a server" : "New message in a group",
            { important: !!p.mentioned || !p.server_id, muteKey: [p.channel_id, p.server_id].filter(Boolean) });
        }
        if (p.from) clearTyping(`ch:${p.channel_id}`, p.from);
        if (p.server_id) { void loadServers(); if (v.kind === "server" && v.id === p.server_id) refreshDetail(p.server_id); }
        else void loadGroups();
      } else if (event === "typing") {
        const key = p.dm ? `dm:${p.from}` : `ch:${p.channel_id}`;
        setTyping((t) => ({ ...t, [key]: { ...(t[key] ?? {}), [p.from]: { name: p.name, until: Date.now() + 8000 } } }));
      } else if (event === "account_recovered") {    // a recovery ID brought an old account back into this one
        location.reload();
      } else if (event === "signed_out") {           // this account was deleted (on another device)
        if (!isDeletingAccount()) { setToken(null); location.href = "/app"; }
      } else if (event === "jace_support") {          // someone asked the Jace bot for a person
        loadInbox();
        notifyUser(`${p.name ?? "Someone"} wants a person`, "In the Jace inbox", { important: true });
      } else if (event === "appeal") {                // Jace ban appeals (lib/appeals.ts): only staff get these
        setAppealsRefresh((n) => n + 1);
        notifyUser(p.first ? `New appeal from @${p.username}` : `@${p.username} replied to their appeal`, "In Appeals",
          { important: true, onClick: () => { setView({ kind: "appeals", user: p.user_id }); setMobileMain(true); } });
        if (viewRef.current.kind !== "appeals") setAppealsUnread((n) => n + 1);
      } else if (event === "jace_profile") {          // your handle or picture couldn't go to Jace
        err(p.message);
      } else if (event === "broadcast_sent") {        // the Broadcast tab: done sending
        err(`Sent to ${p.sent} ${p.sent === 1 ? "person" : "people"}`);
      } else if (event === "appeals_access") {
        void api<Me>("/me").then(setMe).catch(() => {});
      } else if (event === "groups") {
        void loadGroups();
      } else if (event === "servers") {
        void loadServers();
        if (v.kind === "server" && v.id === p.server_id) {
          if (p.kind === "deleted" || p.kind === "removed") { setView({ kind: "home" }); if (room.channelId) void voice.refresh(); }
          else refreshDetail(p.server_id);
        }
      } else if (event === "voice") {
        void voice.refresh();
        if (p.server_id && v.kind === "server" && v.id === p.server_id) refreshDetail(p.server_id);
        if (!p.server_id) void loadGroupCall(p.channel_id);
      } else if (event === "voice_signal") {
        void voice.onSignal(p as { id: number; from: string; kind: string; channel_id: string });
      } else if (event === "call") {
        void calls.onSignal(p);
      }
    });
    function clearTyping(key: string, from: string) {
      setTyping((t) => { if (!t[key]?.[from]) return t; const c = { ...t[key] }; delete c[from]; return { ...t, [key]: c }; });
    }
  }, [me.realtime, me.inbox, notifyUser, calls, voice, loadFriends, loadGroups, loadServers, loadDetail, loadGroupCall, loadInbox]);   // eslint-disable-line react-hooks/exhaustive-deps

  // typing indicators fade after 8 seconds
  useEffect(() => {
    const t = setInterval(() => setTyping((all) => {
      const now = Date.now();
      let changed = false;
      const out: typeof all = {};
      for (const [k, v] of Object.entries(all)) {
        out[k] = Object.fromEntries(Object.entries(v).filter(([, x]) => x.until > now));
        if (Object.keys(out[k]).length !== Object.keys(v).length) changed = true;
      }
      return changed ? out : all;
    }), 2000);
    return () => clearInterval(t);
  }, []);

  // unread badge for the desktop app / tab title (muted chats don't count)
  const muted = settings.muted ?? [];
  const unread = friends.friends.reduce((n, f) => n + (muted.includes(f.uuid) ? 0 : f.unread ?? 0), 0) + friends.incoming.length
    + groups.reduce((n, g) => n + (muted.includes(g.id) ? 0 : g.unread), 0) + servers.reduce((n, s) => n + (muted.includes(s.id) ? 0 : s.unread), 0);
  useEffect(() => {
    document.title = unread ? `(${unread}) Jace Social` : "Jace Social";
    desktop()?.setUnread(unread);
  }, [unread]);

  async function openServer(id: string, channel?: string) {
    const d = await loadDetail(id);
    if (!d) return;
    const first = d.channels.find((c) => c.kind === "text" || c.kind === "announcement" || !c.kind);
    setView({ kind: "server", id, channel: channel ?? first?.id });
    setPins(false);
    setMobileMain(true);
  }

  const toggleMute = async (key: string) => {
    const next = muted.includes(key) ? muted.filter((m) => m !== key) : [...muted, key];
    setMe({ ...me, settings: { ...settings, muted: next } });
    try { setMe(await api<Me>("/me", { method: "PATCH", body: { settings: { muted: next } } })); } catch (e) { err((e as Error).message); }
  };
  const toggleCategory = (id: string) => {
    const next = collapsed.includes(id) ? collapsed.filter((x) => x !== id) : [...collapsed, id];
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSED, JSON.stringify(next)); } catch { /* fine */ }
  };

  const go = (v: View) => { setView(v); setPins(false); setMobileMain(true); if (v.kind === "group") void loadGroupCall(v.id); };
  const dmPerson = view.kind === "dm" ? people[view.uuid] : undefined;
  const group = view.kind === "group" ? groups.find((g) => g.id === view.id) : undefined;
  const channel = view.kind === "server" ? detail?.channels.find((c) => c.id === view.channel) : undefined;
  const showRight = (view.kind === "server" && showMembers && channel?.kind !== "voice") || view.kind === "group" || view.kind === "dm";
  const typingIn = (key: string) => Object.values(typing[key] ?? {}).map((t) => t.name);
  const perms = detail?.perms ?? 0;
  const canManageChannels = has(perms, P.MANAGE_CHANNELS);
  const joinVoice = (c: Channel) => {
    if (!detail) return;
    void voice.join(me.uuid, c.id, detail.server.id, c.name);
    setView({ kind: "server", id: detail.server.id, channel: c.id });
    setMobileMain(true);
  };

  // the server's channel list: channels without a category first, then each category
  const tree = useMemo(() => {
    if (!detail) return [];
    const chans = [...detail.channels].sort((a, b) => a.position - b.position);
    const loose = chans.filter((c) => c.kind !== "category" && !c.parent_id);
    const cats = chans.filter((c) => c.kind === "category");
    return [{ cat: null as Channel | null, items: loose }, ...cats.map((cat) => ({ cat, items: chans.filter((c) => c.parent_id === cat.id) }))];
  }, [detail]);

  const channelButton = (c: Channel) => {
    const isVoice = c.kind === "voice";
    const users = isVoice ? (room.channelId === c.id ? room.participants.map((p) => ({ uuid: p.uuid, muted: p.muted, deafened: p.deafened, streaming: p.streaming }))
      : (detail?.voice ?? []).filter((v) => v.channel_id === c.id)) : [];
    const mutedChan = muted.includes(c.id);
    return (
      <div key={c.id}>
        <div className={`side-item channel-item${view.kind === "server" && view.channel === c.id ? " active" : ""}${c.unread && !mutedChan ? " unread" : ""}${mutedChan ? " muted-chan" : ""}`}
          onClick={() => {
            if (isVoice) { if (room.channelId !== c.id && has(c.perms ?? 0, P.CONNECT)) joinVoice(c); else go({ kind: "server", id: detail!.server.id, channel: c.id }); return; }
            go({ kind: "server", id: detail!.server.id, channel: c.id });
            void loadDetail(detail!.server.id);
          }}
          onContextMenu={(e) => { e.preventDefault(); void toggleMute(c.id); err(mutedChan ? `Unmuted ${c.name}` : `Muted ${c.name}`); }}>
          <span className="hash">{isVoice ? "🔊" : c.kind === "announcement" ? "📣" : "#"}</span>
          <span className="name">{c.name}</span>
          {!!c.unread && !mutedChan && view.kind === "server" && view.channel !== c.id && <span className="badge">{c.unread}</span>}
          {canManageChannels && <button className="icon-btn hover-only" title="Channel settings" onClick={(e) => { e.stopPropagation(); setModal({ kind: "channel", channel: c }); }}>⚙</button>}
        </div>
        {isVoice && <VoiceUsers users={users} people={{ ...people, [me.uuid]: { ...me, ...(people[me.uuid] ?? {}) } }} speaking={room.speaking} />}
      </div>
    );
  };

  return (
    <div className={`app${showRight ? "" : " no-right"}${mobileMain ? " show-main" : ""}`}>
      {/* server rail */}
      <nav className="rail" aria-label="Servers">
        <button className={`rail-item rail-home${view.kind !== "server" ? " active" : ""}`} title="Home"
          onClick={() => { setView({ kind: "home" }); setMobileMain(false); }}>
          <svg className="rail-logo" viewBox="0 0 48 48" aria-label="Jace Social">   {/* the logo, in your accent color */}
            <path d="M16 12h16a6 6 0 0 1 6 6v8a6 6 0 0 1-6 6H22l-8.5 7 1.4-7.1A6 6 0 0 1 10 26v-8a6 6 0 0 1 6-6z" fill="#111317" />
            {[18, 24, 30].map((x) => <circle key={x} cx={x} cy={22} r={2.3} fill="var(--green)" />)}
          </svg>
          {friends.incoming.length > 0 && <span className="badge">{friends.incoming.length}</span>}
        </button>
        <div className="rail-sep" />
        {servers.map((s) => (
          <button key={s.id} className={`rail-item${view.kind === "server" && view.id === s.id ? " active" : ""}${muted.includes(s.id) ? " muted-chan" : ""}`} title={s.name}
            onClick={() => openServer(s.id)}
            onContextMenu={(e) => { e.preventDefault(); void toggleMute(s.id); err(muted.includes(s.id) ? `Unmuted ${s.name}` : `Muted ${s.name}`); }}>
            {s.icon_url ? <img src={s.icon_url} alt="" /> : s.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 3)}
            {s.unread > 0 && !muted.includes(s.id) && <span className="badge">{s.unread > 99 ? "99+" : s.unread}</span>}
          </button>
        ))}
        <button className="rail-item rail-add" title="Create or join a server" onClick={() => setModal({ kind: "server" })}>+</button>
        <UpdateButton />
        <MobileUpdate />
      </nav>

      {/* sidebar */}
      <aside className="sidebar">
        {view.kind === "server" && detail ? <>
          {detail.server.banner_url && <div className="side-banner" style={{ backgroundImage: `url(${detail.server.banner_url})` }} />}
          <div className="side-head clickable" onClick={() => setMenu(menu === "server" ? null : "server")} style={detail.server.accent_color ? { boxShadow: `inset 0 -2px ${detail.server.accent_color}` } : undefined}>
            <span className="grow">{detail.server.name}</span>
            <span className="muted">{menu === "server" ? "✕" : "▾"}</span>
          </div>
          {menu === "server" && (
            <div className="menu server-menu" onMouseLeave={() => setMenu(null)}>
              {has(perms, P.INVITE) && <button onClick={() => { setMenu(null); setModal({ kind: "serverSettings", tab: "invites" }); }}>👋 Invite people</button>}
              <button onClick={() => { setMenu(null); setModal({ kind: "serverSettings" }); }}>⚙ Server settings</button>
              {(detail.server.rules || detail.server.welcome?.message || detail.server.welcome?.channels?.length || detail.server.onboarding?.length) ?
                <button onClick={() => { setMenu(null); setModal({ kind: "serverWelcome" }); }}>📜 Rules &amp; welcome</button> : null}
              {canManageChannels && <button onClick={async () => {
                setMenu(null);
                const name = prompt("New channel name");
                if (!name) return;
                const kind = confirm("Make it a voice channel? (OK = voice, Cancel = text)") ? "voice" : "text";
                try { await api(`/servers/${detail.server.id}/channels`, { body: { name, kind } }); await loadDetail(detail.server.id); } catch (e) { err((e as Error).message); }
              }}>＃ Create channel</button>}
              {canManageChannels && <button onClick={async () => {
                setMenu(null);
                const name = prompt("New category name");
                if (!name) return;
                try { await api(`/servers/${detail.server.id}/channels`, { body: { name, kind: "category" } }); await loadDetail(detail.server.id); } catch (e) { err((e as Error).message); }
              }}>📁 Create category</button>}
              <button onClick={() => { setMenu(null); void toggleMute(detail.server.id); }}>{muted.includes(detail.server.id) ? "🔔 Unmute server" : "🔕 Mute server"}</button>
              {settings.developer && <button onClick={() => { setMenu(null); void navigator.clipboard?.writeText(detail.server.id); }}># Copy server ID</button>}
              {!detail.owner && <button style={{ color: "var(--red)" }} onClick={async () => {
                setMenu(null);
                if (!confirm(`Leave ${detail.server.name}?`)) return;
                try { await api(`/servers/${detail.server.id}/members?uuid=${me.uuid}`, { method: "DELETE" }); setView({ kind: "home" }); setDetail(null); void loadServers(); } catch (e) { err((e as Error).message); }
              }}>🚪 Leave server</button>}
            </div>
          )}
          <div className="side-scroll">
            {detail.server.description && <p className="muted small" style={{ margin: "4px 8px 8px" }}>{detail.server.description}</p>}
            {tree.map(({ cat, items }) => (cat || items.length) ? (
              <div key={cat?.id ?? "loose"}>
                {cat && (
                  <div className="side-label category" onClick={() => toggleCategory(cat.id)}>
                    <span>{collapsed.includes(cat.id) ? "›" : "⌄"} {cat.name}</span>
                    <span>
                      {canManageChannels && <button className="icon-btn hover-only" title="Create a channel here" onClick={async (e) => {
                        e.stopPropagation();
                        const name = prompt(`New channel in ${cat.name}`);
                        if (!name) return;
                        const kind = /voice/i.test(cat.name) ? "voice" : "text";
                        try { await api(`/servers/${detail.server.id}/channels`, { body: { name, kind, parent_id: cat.id } }); await loadDetail(detail.server.id); } catch (er) { err((er as Error).message); }
                      }}>＋</button>}
                      {canManageChannels && <button className="icon-btn hover-only" title="Category settings" onClick={(e) => { e.stopPropagation(); setModal({ kind: "channel", channel: cat }); }}>⚙</button>}
                    </span>
                  </div>
                )}
                {items.filter((c) => !cat || !collapsed.includes(cat.id) || (view.kind === "server" && view.channel === c.id) || room.channelId === c.id).map(channelButton)}
              </div>
            ) : null)}
          </div>
        </> : <>
          <div className="side-head"><span className="grow">Jace Social</span></div>
          <div className="side-scroll">
            <button className={`side-item${view.kind === "home" ? " active" : ""}`} onClick={() => { setView({ kind: "home" }); setMobileMain(true); }}>
              <span style={{ width: 32, textAlign: "center" }}>👥</span><span className="name">Friends</span>
              {friends.incoming.length > 0 && <span className="badge">{friends.incoming.length}</span>}
            </button>
            {appealsOn && (
              <button className={`side-item${view.kind === "appeals" ? " active" : ""}${appealsUnread ? " unread" : ""}`}
                onClick={() => go({ kind: "appeals", user: null })}>
                <span style={{ width: 32, textAlign: "center" }}>⚖️</span><span className="name">Appeals<span className="sub">Jace bans and mutes</span></span>
                {appealsUnread > 0 && <span className="badge">{appealsUnread}</span>}
              </button>
            )}
            <div className="side-label">Group chats
              <button className="icon-btn" title="New group chat" onClick={() => setModal({ kind: "group" })}>＋</button></div>
            {groups.length === 0 && <p className="muted small" style={{ margin: "0 8px" }}>None yet</p>}
            {groups.map((g) => (
              <button key={g.id} className={`side-item${view.kind === "group" && view.id === g.id ? " active" : ""}${g.unread && !muted.includes(g.id) ? " unread" : ""}${muted.includes(g.id) ? " muted-chan" : ""}`}
                onClick={() => go({ kind: "group", id: g.id })}
                onContextMenu={(e) => { e.preventDefault(); void toggleMute(g.id); err(muted.includes(g.id) ? `Unmuted ${g.name}` : `Muted ${g.name}`); }}>
                <Avatar p={{ name: g.name, avatar_url: g.icon_url }} size={32} />
                <span className="name">{g.name}<span className="sub">{room.channelId === g.id ? "🔊 In a call" : `${g.members.length} members`}</span></span>
                {g.unread > 0 && !muted.includes(g.id) && <span className="badge">{g.unread}</span>}
              </button>
            ))}
            {me.uuid === JACE_BOT && <button className={`side-item${view.kind === "broadcast" ? " active" : ""}`}
              onClick={() => go({ kind: "broadcast" })}>
              <span style={{ width: 32, textAlign: "center" }}>📣</span><span className="name">Broadcast<span className="sub">Send to everyone</span></span>
            </button>}
            {me.uuid === JACE_BOT && <JaceInbox entries={jaceInbox} active={view.kind === "dm" ? view.uuid : null}
              onOpen={(e) => { go({ kind: "dm", uuid: e.uuid }); }} />}
            {friends.jace && (
              <button className={`side-item${view.kind === "dm" && view.uuid === JACE_BOT ? " active" : ""}${friends.jace.unread ? " unread" : ""}`}
                onClick={() => { setJaceTab("chat"); go({ kind: "dm", uuid: JACE_BOT }); }}>
                <Avatar p={friends.jace} size={32} />
                <span className="name">{friends.jace.name} <BotTag p={friends.jace} /><span className="sub">Ask me a question</span></span>
                {!!friends.jace.unread && <span className="badge">{friends.jace.unread}</span>}
              </button>
            )}
            <div className="side-label">Direct messages</div>
            {sortFriends(friends.friends).map((f) => (
              <button key={f.uuid} className={`side-item${view.kind === "dm" && view.uuid === f.uuid ? " active" : ""}${f.unread && !muted.includes(f.uuid) ? " unread" : ""}${muted.includes(f.uuid) ? " muted-chan" : ""}`}
                onClick={() => go({ kind: "dm", uuid: f.uuid })}
                onContextMenu={(e) => { e.preventDefault(); void toggleMute(f.uuid); err(muted.includes(f.uuid) ? `Unmuted ${f.name}` : `Muted ${f.name}`); }}>
                <Avatar p={f} size={32} status={f.status} />
                <span className="name">{f.name}<span className="sub">{typingIn(`dm:${f.uuid}`).length ? "typing…" : shortLine(f)}</span></span>
                {!!f.unread && !muted.includes(f.uuid) && <span className="badge">{f.unread}</span>}
              </button>
            ))}
          </div>
        </>}
        <VoiceBar voice={voice} state={room} onOpen={() => {
          if (!room.channelId) return;
          if (room.serverId) void openServer(room.serverId, room.channelId);
          else go({ kind: "group", id: room.channelId });
        }} />
        <div className="me-panel">
          <span onClick={() => setMenu(menu === "account" ? null : "account")} style={{ cursor: "pointer" }} title="Switch accounts">
            <Avatar p={me} size={34} status={me.status === "invisible" ? "offline" : me.status} /></span>
          <div className="who" onClick={() => setModal({ kind: "status" })} title="Set status">
            <b>{me.name}<BotTag p={me} style={{ marginLeft: 6 }} /></b>
            <span>{me.custom_status ? `${me.status_emoji ?? ""} ${me.custom_status}` : statusLabel[me.status]}</span>
          </div>
          <button className="icon-btn" title="Settings" onClick={() => setModal({ kind: "settings" })}>⚙</button>
          {menu === "account" && (
            <div className="menu account-menu" onMouseLeave={() => setMenu(null)}>
              <AccountSwitcher me={me} compact />
              <hr />
              <button onClick={() => { setMenu(null); setModal({ kind: "status" }); }}>🟢 Set status</button>
              <button onClick={() => { setMenu(null); setModal({ kind: "settings" }); }}>⚙ Settings</button>
              {!me.is_bot && <button onClick={() => { setMenu(null); setModal({ kind: "welcome" }); }}>👋 Welcome tour</button>}
              {settings.developer && <button onClick={() => { setMenu(null); void navigator.clipboard?.writeText(me.uuid); }}># Copy my ID</button>}
              <button style={{ color: "var(--red)" }} onClick={signOut}>Sign out</button>
            </div>
          )}
        </div>
      </aside>

      {/* main */}
      <main className="main">
        {view.kind === "broadcast" && me.jace_staff && <>
          <div className="main-head"><button className="icon-btn mobile-only" onClick={() => setMobileMain(false)}>‹</button>
            <span className="title">📣 Broadcast</span><span className="topic">A message from the Jace bot to everyone</span></div>
          <Broadcast onError={err} />
        </>}
        {view.kind === "appeals" && appealsOn && <Appeals open={view.user} onOpen={(u) => setView({ kind: "appeals", user: u })}
          refresh={appealsRefresh} onUnread={setAppealsUnread} onError={err} back={() => setMobileMain(false)}
          onReconnected={() => void api<Me>("/me").then(setMe).catch(() => {})} />}
        {view.kind === "home" && <FriendsHome data={friends} reload={loadFriends} onError={err}
          onOpen={(p) => setProfile(p.uuid)} onMessage={(p) => go({ kind: "dm", uuid: p.uuid })}
          onCall={Calls.supported() && call.state === "idle" ? (p) => void calls.call(p.uuid, p.name) : undefined} back={() => setMobileMain(false)} />}
        {view.kind === "dm" && dmPerson && <>
          <div className="main-head">
            <button className="icon-btn mobile-only" onClick={() => setMobileMain(false)}>←</button>
            <Avatar p={dmPerson} size={26} status={dmPerson.status} /><span className="title">{dmPerson.name} <BotTag p={dmPerson} /></span>
            <span className="topic">{dmPerson.official ? "The official Jace Social bot" : shortLine(dmPerson)}</span>
            {Calls.supported() && !dmPerson.is_bot && <button className="icon-btn" title={`Voice call ${dmPerson.name}`} aria-label="Start a voice call"
              disabled={call.state !== "idle"} onClick={() => void calls.call(dmPerson.uuid, dmPerson.name)}>📞</button>}
            <button className="icon-btn" title={muted.includes(dmPerson.uuid) ? "Unmute" : "Mute"} onClick={() => void toggleMute(dmPerson.uuid)}>{muted.includes(dmPerson.uuid) ? "🔕" : "🔔"}</button>
          </div>
          {dmPerson.uuid === JACE_BOT && <JaceTabs tab={jaceTab} setTab={setJaceTab} me={me} onError={err} />}
          {dmPerson.uuid === JACE_BOT && jaceTab === "announcements" && <Announcements me={me} onError={err} />}
          {dmPerson.uuid === JACE_BOT && jaceTab === "docs" && <Docs me={me} onError={err} />}
          {dmPerson.uuid === JACE_BOT && jaceTab === "broadcast" && me.jace_staff && <Broadcast onError={err} />}
          {(dmPerson.uuid !== JACE_BOT || jaceTab === "chat") &&
          <Chat target={{ kind: "dm", uuid: dmPerson.uuid, name: dmPerson.name }} me={me} people={people} reloadKey={reload}
            onOpenProfile={setProfile} onError={err} placeholder={dmPerson.uuid === JACE_BOT ? "Ask me a question" : `Message ${dmPerson.name}`}
            settings={settings} typing={typingIn(`dm:${dmPerson.uuid}`)} />}
        </>}
        {view.kind === "group" && group && <>
          <div className="main-head">
            <button className="icon-btn mobile-only" onClick={() => setMobileMain(false)}>←</button>
            <Avatar p={{ name: group.name, avatar_url: group.icon_url }} size={26} />
            <span className="title">{group.name}</span><span className="spacer" />
            <button className={`btn small${room.channelId === group.id ? " primary" : ""}`} onClick={() => room.channelId === group.id ? void voice.leave() : void voice.join(me.uuid, group.id, null, group.name)}>
              {room.channelId === group.id ? "Leave call" : groupCall[group.id] ? `📞 Join call (${groupCall[group.id]})` : "📞 Start a call"}</button>
            <button className="icon-btn" title="Pinned messages" onClick={() => setPins(!pins)}>📌</button>
            <GroupMenu group={group} me={me} friends={friends.friends} onError={err} onChanged={loadGroups}
              onLeft={() => { setView({ kind: "home" }); void loadGroups(); }} />
          </div>
          {room.channelId === group.id && (
            <div className="group-call"><VoiceRoom voice={voice} state={room} channelId={group.id} channelName={group.name} people={people} me={me} canJoin onJoin={() => {}} /></div>
          )}
          <Chat target={{ kind: "channel", id: group.id, name: group.name, isServer: false }} me={me} people={people}
            reloadKey={reload} onOpenProfile={setProfile} onError={err} placeholder={`Message ${group.name}`} settings={settings}
            typing={typingIn(`ch:${group.id}`)} showPins={pins} onClosePins={() => setPins(false)} />
        </>}
        {view.kind === "server" && channel && detail && channel.kind === "voice" && (
          <>
            <div className="main-head">
              <button className="icon-btn mobile-only" onClick={() => setMobileMain(false)}>←</button>
              <span className="hash">🔊</span><span className="title">{channel.name}</span><span className="spacer" />
            </div>
            <VoiceRoom voice={voice} state={room} channelId={channel.id} channelName={channel.name} people={people} me={me}
              canJoin={has(channel.perms ?? 0, P.CONNECT)} onJoin={() => joinVoice(channel)} />
          </>
        )}
        {view.kind === "server" && channel && detail && channel.kind !== "voice" && <>
          <div className="main-head">
            <button className="icon-btn mobile-only" onClick={() => setMobileMain(false)}>←</button>
            <span className="hash">{channel.kind === "announcement" ? "📣" : "#"}</span><span className="title">{channel.name}</span>
            {channel.topic ? <span className="topic">{channel.topic}</span> : <span className="spacer" />}
            {!!channel.slowmode && <span className="muted small" title="Slowmode">🐢 {channel.slowmode}s</span>}
            <button className="icon-btn" title="Pinned messages" onClick={() => setPins(!pins)}>📌</button>
            <button className={`icon-btn${showMembers ? " on" : ""}`} title="Members" onClick={() => setShowMembers(!showMembers)}>👥</button>
          </div>
          <Chat target={{ kind: "channel", id: channel.id, name: channel.name, isServer: true, slowmode: channel.slowmode, announcement: channel.kind === "announcement" }}
            me={me} people={people} roles={detail.roles} perms={channel.perms} reloadKey={reload} onOpenProfile={setProfile} onError={err}
            placeholder={`Message #${channel.name}`} settings={settings} typing={typingIn(`ch:${channel.id}`)} showPins={pins} onClosePins={() => setPins(false)} />
        </>}
        {view.kind === "server" && !channel && <div className="empty">No channels yet</div>}
      </main>

      {/* right panel */}
      {showRight && (
        <aside className="right">
          {view.kind === "dm" && dmPerson && <ProfileCard p={dmPerson} onOpen={() => setProfile(dmPerson.uuid)} />}
          {view.kind === "group" && group && <MemberList members={group.members} roles={[]} onOpen={setProfile} />}
          {view.kind === "server" && detail && <MemberList members={detail.members} roles={detail.roles} owner={detail.server.owner} onOpen={setProfile} />}
        </aside>
      )}

      {profile && <ProfileModal uuid={profile} onClose={() => setProfile(null)} onError={err}
        detail={view.kind === "server" ? detail : null} me={me}
        onMessage={(p) => go({ kind: "dm", uuid: p.uuid })} onChanged={() => { void loadFriends(); if (detail) void loadDetail(detail.server.id); }} />}
      {modal?.kind === "settings" && <SettingsModal me={me} initialTab={modal.tab} onClose={() => setModal(null)} onSaved={setMe} onSignOut={signOut} onError={err}
        onWelcome={() => setModal({ kind: "welcome" })} />}
      {modal?.kind === "status" && <StatusModal me={me} onClose={() => setModal(null)} onSaved={setMe} onError={err} />}
      {modal?.kind === "welcome" && <Welcome me={me} onDone={() => setModal(null)} onSaved={setMe} onError={err} onJoinServer={() => setModal({ kind: "server" })} />}
      {modal?.kind === "group" && <NewGroupModal friends={friends.friends} onClose={() => setModal(null)} onError={err}
        onCreated={async (id) => { await loadGroups(); go({ kind: "group", id }); }} />}
      {modal?.kind === "server" && <AddServerModal initialCode={inviteCode} onClose={() => setModal(null)} onError={err}
        onDone={async (id) => { await loadServers(); await openServer(id); if (inviteCode) history.replaceState(null, "", "/app"); }} />}
      {modal?.kind === "serverSettings" && detail && <ServerSettings detail={detail} me={me} startTab={modal.tab} onClose={() => setModal(null)} onError={err}
        onChanged={() => { void loadDetail(detail.server.id); void loadServers(); }}
        onLeft={() => { setView({ kind: "home" }); setDetail(null); void loadServers(); }} />}
      {modal?.kind === "channel" && detail && <ChannelSettings detail={detail} channel={detail.channels.find((c) => c.id === modal.channel.id) ?? modal.channel}
        onClose={() => setModal(null)} onError={err} onChanged={() => void loadDetail(detail.server.id)} />}
      {view.kind === "server" && detail && (modal?.kind === "serverWelcome" || (!detail.onboarded && !modal)) && (
        <ServerOnboarding detail={detail} onError={err} onDone={() => { setModal(null); void loadDetail(detail.server.id); }}
          onOpenChannel={(id) => setView({ kind: "server", id: detail.server.id, channel: id })} />
      )}
      <CallPanel calls={calls} info={call} people={people} />
      <NewVersion busy={call.state !== "idle" || !!room.channelId} />
      {moveCall && call.state === "idle" && (
        <div className="call-panel" role="dialog" aria-label="Move your call here">
          <Avatar p={people[moveCall.peer] ?? { name: moveCall.name || "?" }} size={44} />
          <div className="call-who"><b>{people[moveCall.peer]?.name || moveCall.name || "Your call"}</b>
            <span>Your call is in Jace Launcher. Move it here to see their camera and screen.</span></div>
          <button className="btn primary small" onClick={() => { setMoveCall(null); void calls.takeOver(moveCall.peer, people[moveCall.peer]?.name || moveCall.name, moveCall.id); }}>
            Move call here</button>
          <button className="btn small" onClick={() => setMoveCall(null)}>Not now</button>
        </div>
      )}
      {moveVoice && room.channelId !== moveVoice.id && (
        <div className="call-panel" role="dialog" aria-label="Join voice here">
          <div className="call-who"><b>🔊 {moveVoice.name || "Voice"}</b>
            <span>Join here to see everyone's camera and screen.</span></div>
          <button className="btn primary small" onClick={() => {
            const v = moveVoice;
            setMoveVoice(null);
            void voice.join(me.uuid, v.id, v.server, v.name);
            go(v.server ? { kind: "server", id: v.server, channel: v.id } : { kind: "group", id: v.id });
          }}>Join voice</button>
          <button className="btn small" onClick={() => setMoveVoice(null)}>Not now</button>
        </div>
      )}
      {toast && <div role="alert" className="toast">{toast}</div>}
    </div>
  );
}

/** Members, grouped like Discord: roles shown separately (highest first), then online, then offline. */
function MemberList({ members, roles, owner, onOpen }: { members: Person[]; roles: ServerDetail["roles"]; owner?: string; onOpen: (uuid: string) => void }) {
  const hoisted = roles.filter((r) => r.hoist && !r.is_default).sort((a, b) => b.position - a.position);
  const groupOf = (m: Person) => (m.online ? hoisted.find((r) => m.roles?.includes(r.id))?.id ?? "online" : "offline");
  const sections: [string, string, Person[]][] = [
    ...hoisted.map((r) => [r.id, r.name, members.filter((m) => groupOf(m) === r.id)] as [string, string, Person[]]),
    ["online", "Online", members.filter((m) => groupOf(m) === "online")],
    ["offline", "Offline", members.filter((m) => groupOf(m) === "offline")],
  ];
  return <>{sections.filter(([, , list]) => list.length).map(([key, title, list]) => (
    <div key={key}>
      <div className="side-label">{title} — {list.length}</div>
      {[...list].sort((a, b) => (a.nickname || a.name).localeCompare(b.nickname || b.name)).map((m) => {
        const ns = nameStyle(m, roles);
        return (
          <button key={m.uuid} className="side-item" onClick={() => onOpen(m.uuid)} style={{ opacity: m.online ? 1 : 0.55 }}>
            <Avatar p={m} size={32} status={m.status} />
            <span className="name"><span style={{ color: ns.color }}>{ns.name}</span>
              <BotTag p={m} style={{ marginLeft: 5 }} />
              {m.uuid === owner && <span title="Owner"> 👑</span>}
              <span className="sub">{shortLine(m)}</span></span>
          </button>
        );
      })}
    </div>
  ))}</>;
}

function UpdateButton() {
  const [latest, setLatest] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const look = async () => {
      const d = await desktopReady();
      if (!d?.checkForUpdate || !d.applyUpdate) return;
      const r = await d.checkForUpdate();
      if (!stop) setLatest(r.newer && r.latest ? r.latest : null);
    };
    const first = setTimeout(look, 8_000);           // the app checks GitHub a few seconds after starting
    const t = setInterval(look, 3 * 3600_000);
    return () => { stop = true; clearTimeout(first); clearInterval(t); };
  }, []);
  if (!latest) return null;
  return (
    <button className="rail-item rail-update" title={`Update to Jace Social ${latest}`} aria-label={`Update to Jace Social ${latest}`}
      onClick={() => desktop()?.applyUpdate?.()}>⬆<small>Update</small></button>
  );
}

const rank = (p: Person) => (p.online ? (p.activity && p.activity.type !== "app" ? 0 : 1) : 2);
function sortFriends(list: Person[]) {
  return [...list].sort((a, b) => (b.unread ?? 0) - (a.unread ?? 0) || rank(a) - rank(b) || a.name.localeCompare(b.name));
}
function shortLine(p: Person) {
  const s = p.custom_status ? `${p.status_emoji ?? ""} ${p.custom_status}`.trim() : "";
  if (s) return s;
  const a = p.activity;
  if (!p.online) return "Offline";
  if (a?.type === "playing") return `Playing Minecraft${a.version ? " " + a.version : ""}`;
  if (a?.type === "hosting") return "Hosting a world";
  if (a?.type === "launcher") return "In Jace Launcher";
  return statusLabel[p.status];
}

function StatusModal({ me, onClose, onSaved, onError }: { me: Me; onClose: () => void; onSaved: (m: Me) => void; onError: (m: string) => void }) {
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal"><div className="modal-body"><StatusEditor me={me} onSaved={onSaved} onError={onError} /></div>
        <div className="modal-foot"><button className="btn" onClick={onClose}>Done</button></div></div>
    </div>
  );
}

function ProfileCard({ p, onOpen }: { p: Person; onOpen: () => void }) {
  return (
    <div>
      <div className="profile-banner" style={{ background: p.accent_color ?? "#2a4a37", height: 60, borderRadius: 12 }} />
      <div style={{ marginTop: -30, paddingLeft: 12, cursor: "pointer" }} onClick={onOpen}><Avatar p={p} size={64} status={p.status} /></div>
      <div style={{ padding: "8px 6px", display: "grid", gap: 10 }}>
        <div><b style={{ fontSize: 18, cursor: "pointer" }} onClick={onOpen}>{p.name}</b>
          <div className="muted small">{[p.handle ? `@${p.handle}` : p.jace_name && `@${p.jace_name}`, p.minecraft_name && `⛏ ${p.minecraft_name}`, p.pronouns].filter(Boolean).join(" · ")}</div></div>
        {p.custom_status && <div className="small">{p.status_emoji} {p.custom_status}</div>}
        <ActivityCard a={p.activity} />
        {joinAddress(p) && <div className="small muted">Join from Jace Launcher or the mod: <code>{joinAddress(p)}</code></div>}
        {p.bio && <div className="small" style={{ whiteSpace: "pre-wrap" }}>{p.bio}</div>}
        {p.links.length > 0 && <div className="chips">{p.links.map((l) => <a key={l.url} className="chip" href={l.url} target="_blank" rel="noopener noreferrer nofollow">{l.label}</a>)}</div>}
      </div>
    </div>
  );
}

function GroupMenu({ group, me, friends, onError, onChanged, onLeft }: {
  group: Group; me: Me; friends: Person[]; onError: (m: string) => void; onChanged: () => void; onLeft: () => void;
}) {
  const [open, setOpen] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setOpen(false); try { await fn(); onChanged(); } catch (e) { onError((e as Error).message); } };
  const addable = friends.filter((f) => !group.members.some((m) => m.uuid === f.uuid));
  return (
    <span style={{ position: "relative" }}>
      <button className="icon-btn" onClick={() => setOpen(!open)} aria-label="Group options">⋯</button>
      {open && (
        <div className="menu" style={{ right: 0, top: 32 }} onMouseLeave={() => setOpen(false)}>
          <button onClick={() => { const n = prompt("Group name", group.name); if (n) void run(() => api(`/groups/${group.id}`, { method: "PATCH", body: { name: n } })); }}>✎ Rename</button>
          <label style={{ display: "flex", gap: 8, padding: "7px 10px", cursor: "pointer" }}>🖼 Change picture
            <input type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void run(() => api(`/groups/${group.id}/icon`, { raw: f })); }} /></label>
          {addable.slice(0, 20).map((f) => (
            <button key={f.uuid} onClick={() => run(() => api(`/groups/${group.id}/members`, { body: { uuid: f.uuid } }))}>＋ Add {f.name}</button>
          ))}
          {group.owner === me.uuid && group.members.filter((m) => m.uuid !== me.uuid).map((m) => (
            <button key={m.uuid} onClick={() => { if (confirm(`Remove ${m.name}?`)) void run(() => api(`/groups/${group.id}/members?uuid=${m.uuid}`, { method: "DELETE" })); }}>✕ Remove {m.name}</button>
          ))}
          <button style={{ color: "var(--red)" }} onClick={async () => {
            if (!confirm("Leave this group chat?")) return;
            setOpen(false);
            try { await api(`/groups/${group.id}/members?uuid=${me.uuid}`, { method: "DELETE" }); onLeft(); } catch (e) { onError((e as Error).message); }
          }}>⎋ Leave group</button>
        </div>
      )}
    </span>
  );
}

function FriendsHome({ data, reload, onError, onOpen, onMessage, onCall, back }: {
  data: FriendsData; reload: () => void; onError: (m: string) => void;
  onOpen: (p: Person) => void; onMessage: (p: Person) => void; onCall?: (p: Person) => void; back: () => void;
}) {
  const [tab, setTab] = useState<"online" | "all" | "pending" | "add">("online");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [results, setResults] = useState<Person[]>([]);
  const list = tab === "online" ? data.friends.filter((f) => f.online) : data.friends;

  async function add(body: { name?: string; uuid?: string }) {
    setNote("");
    try {
      const r = await api<{ status: string; friend: Person }>("/friends", { body });
      setNote(r.status === "accepted" ? `You and ${r.friend.name} are now friends!` : `Friend request sent to ${r.friend.name}`);
      setName(""); setResults([]); reload();
    } catch (e) { onError((e as Error).message); }
  }
  async function search(q: string) {
    setName(q);
    const term = q.trim().replace(/^[#@]/, "");
    if (term.length < 2) { setResults([]); return; }
    try { setResults((await api<{ users: Person[] }>(`/users?q=${encodeURIComponent(term)}`)).users); } catch { setResults([]); }
  }
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); reload(); } catch (e) { onError((e as Error).message); } };

  return <>
    <div className="main-head">
      <button className="icon-btn mobile-only" onClick={back}>←</button>
      <span className="title">👥 Friends</span>
      <div className="tabs">
        <button className={`tab${tab === "online" ? " active" : ""}`} onClick={() => setTab("online")}>Online</button>
        <button className={`tab${tab === "all" ? " active" : ""}`} onClick={() => setTab("all")}>All</button>
        <button className={`tab${tab === "pending" ? " active" : ""}`} onClick={() => setTab("pending")}>
          Pending{data.incoming.length > 0 && <> <span className="badge">{data.incoming.length}</span></>}</button>
        <button className={`tab add${tab === "add" ? " active" : ""}`} onClick={() => setTab("add")}>Add friend</button>
      </div>
    </div>
    <div className="list">
      {tab === "add" && <>
        <h3>Add a friend</h3>
        <p className="muted small">Start with <b>#</b> for a Minecraft username (#Steve) or <b>@</b> for someone&apos;s handle or Jace account (@steve).</p>
        <AddFriendForm value={name} onChange={(v) => void search(v)} onSend={(n) => void add({ name: n })} />
        {note && <p className="small" style={{ color: "var(--green)" }}>{note}</p>}
        {results.map((p) => (
          <PersonRow key={p.uuid} p={p} onClick={() => onOpen(p)}><button className="btn small" onClick={() => add({ uuid: p.uuid })}>Add</button></PersonRow>
        ))}
      </>}
      {(tab === "online" || tab === "all") && <>
        <div className="side-label">{tab === "online" ? "Online" : "All friends"} — {list.length}</div>
        {list.length === 0 && <p className="muted">{tab === "online" ? "No friends are online right now." : "No friends yet - add some!"}</p>}
        {sortFriends(list).map((f) => (
          <PersonRow key={f.uuid} p={f} onClick={() => onOpen(f)}>
            {onCall && f.online && <button className="btn small" title={`Voice call ${f.name}`} onClick={() => onCall(f)}>📞</button>}
            <button className="btn small" onClick={() => onMessage(f)}>Message</button>
          </PersonRow>
        ))}
      </>}
      {tab === "pending" && <>
        <div className="side-label">Incoming — {data.incoming.length}</div>
        {data.incoming.map((p) => (
          <PersonRow key={p.uuid} p={p} onClick={() => onOpen(p)}>
            <button className="btn primary small" onClick={() => act(() => api("/friends/respond", { body: { uuid: p.uuid, accept: true } }))}>Accept</button>
            <button className="btn small" onClick={() => act(() => api("/friends/respond", { body: { uuid: p.uuid, accept: false } }))}>Decline</button>
          </PersonRow>
        ))}
        <div className="side-label">Sent — {data.outgoing.length}</div>
        {data.outgoing.map((p) => (
          <PersonRow key={p.uuid} p={p} onClick={() => onOpen(p)}>
            <button className="btn small" onClick={() => act(() => api(`/friends?uuid=${p.uuid}`, { method: "DELETE" }))}>Cancel</button>
          </PersonRow>
        ))}
      </>}
    </div>
  </>;
}

