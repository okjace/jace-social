// Jace Social's direct messages and group chats, synced both ways with people's Jace messages
// (jaceo.vercel.app's messages API). Jace's own site no longer shows its messages, so this is
// where people read them now.
//
//   connect   "Sign in with Jace" asks for the messages scope; the access token (365 days, no
//             refresh) is kept encrypted (JACE_TOKEN_KEY) in jace_connections, never sent to clients
//   import    the first sync walks every Jace conversation once: direct messages into messages,
//             Jace groups into group chats (channels with server_id null), original times kept
//   pull      later syncs (the cron job every few minutes, and right after someone opens a chat)
//             fetch only conversations with something new (?since=), from per-conversation cursors
//   push      a message sent in Jace Social between two Jace people (or in a group chat that came
//             from Jace) also goes to Jace with external_id js-dm-<id> / js-ch-<id>, after the
//             answer to the sender, through the jace_outbox queue (retried with backoff)
//   no loops  jace_message_links says which local message each Jace message is. Messages we push
//             are linked under the id Jace gives them ("app-" + hash), so they never come back;
//             messages that came from Jace are never pushed back
//
// Text only: Jace's API has no files, edits, deletes, reactions or read receipts. Minecraft-only
// people (no jace_sub) and conversations with them are never touched.
import { after } from "next/server";
import { JACE, type JaceUser } from "./jace";
import {
  appMessageId, backoffSeconds, CHANNEL_MAX, classify, decryptToken, DM_MAX, encryptToken, externalIdFor, JACE_MAX,
  MAX_ATTEMPTS, splitBody, tokenKey, type JaceFailure,
} from "./jaceSyncCore";
import { db, inboxesOf, newPlayerId, notify, token as newToken, type Profile } from "./server";

type Connection = {
  uuid: string; token_enc: string | null; granted_at: string | null; status: "ok" | "disconnected" | "banned";
  sync_enabled: boolean; imported_at: string | null; last_sync_at: string | null; last_error: string | null;
  syncing_until: string | null;
};
type JaceMessage = { id: string; from_id: string; from_name?: string; to_id?: string; body: string; created_at: string };
type Conversations = {
  direct: { user_id: string; username: string; last_message: JaceMessage | null }[];
  groups: { id: string; name: string; member_ids: string[]; created_at: string }[];
};

/** Is syncing possible on this server at all (an encryption key for the tokens)? */
export const syncAvailable = () => !!tokenKey();

class JaceError extends Error {
  constructor(public kind: JaceFailure, public status: number, message: string) { super(message); }
}

async function jace<T>(accessToken: string, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${JACE}${path}`, {
      method, cache: "no-store", signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new JaceError("temporary", 0, "Couldn't reach Jace");
  }
  const d = await r.json().catch(() => ({})) as { error?: string; error_description?: string };
  if (!r.ok) throw new JaceError(classify(r.status, d), r.status, (d.error_description || d.error || `Jace answered ${r.status}`).slice(0, 300));
  return d as T;
}

// --- the connection ---------------------------------------------------------------------------

async function connection(uuid: string): Promise<Connection | null> {
  const { data, error } = await db().from("jace_connections").select("*").eq("uuid", uuid).maybeSingle();
  if (error) return null;                            // before supabase/007_jace_messages.sql
  return data as Connection | null;
}

/** This person's stored Jace access token (decrypted, server only), or null. Kept from signing in with
 *  Jace even while message syncing is off - Jace ban appeals (lib/appeals.ts) use it too. */
export async function jaceTokenOf(uuid: string): Promise<string | null> {
  return tokenOf(await connection(uuid));
}

/** The Jace Official organization's thread (ban appeals): never synced into normal chats. */
export const isJaceOfficial = (userId: string, username?: string | null) =>
  (!!process.env.JACE_OFFICIAL_USER_ID && userId === process.env.JACE_OFFICIAL_USER_ID) || /^jace official$/i.test((username ?? "").trim());

function tokenOf(c: Connection | null): string | null {
  const key = tokenKey();
  if (!c?.token_enc || !key) return null;
  try { return decryptToken(c.token_enc, key); } catch { return null; }
}

/**
 * Signing in (or linking) with Jace gave us a token: keep it. It never starts syncing by itself:
 * a new connection starts with syncing OFF, and nothing is imported until the person turns on
 * "Sync messages with Jace" (Settings -> Accounts -> Jace messages). People who already sync keep
 * syncing (the token is just fresh again, e.g. after Reconnect).
 */
export async function saveConnection(uuid: string, u: JaceUser) {
  const key = tokenKey();
  if (!key || !u.token || !/\bmessages\b/.test(u.scope || "messages")) return;   // no key, or a token without messages
  const before = await connection(uuid);
  const { error } = await db().from("jace_connections").upsert({
    uuid, token_enc: encryptToken(u.token, key), granted_at: new Date().toISOString(),
    status: u.banned ? "banned" : "ok", last_error: u.banned ? "This Jace account is banned" : null, syncing_until: null,
    sync_enabled: before?.sync_enabled ?? false,
  });
  if (error) { console.error("jace connection", error.message); return; }
  if (!u.banned && before?.sync_enabled) startSync(uuid);   // reconnected: pick up where it left off
}

/** After answering: pull what's new from Jace (everything, the first time) and resend anything queued. */
export function startSync(uuid: string) {
  after(async () => {
    await syncPerson(uuid).catch((e) => console.error("jace import", e));
    await retryOutbox({ sender: uuid }).catch((e) => console.error("jace outbox", e));
  });
}

/** What settings show: none (never connected), ok, disconnected, banned; and the switch. */
export async function connectionInfo(uuid: string) {
  const c = await connection(uuid);
  return {
    available: syncAvailable(),
    state: !c ? "none" : c.status === "ok" && !c.token_enc ? "disconnected" : c.status,
    sync_enabled: c?.sync_enabled ?? false,
    imported: !!c?.imported_at, last_sync_at: c?.last_sync_at ?? null, last_error: c?.last_error ?? null,
    granted_at: c?.granted_at ?? null,
  };
}

export async function setSyncEnabled(uuid: string, on: boolean) {
  await db().from("jace_connections").update({ sync_enabled: on }).eq("uuid", uuid);
}

/** "Disconnect Jace messages": the token is deleted; what's queued for Jace isn't sent. */
export async function disconnect(uuid: string) {
  await db().from("jace_connections").update({ token_enc: null, status: "disconnected", last_error: null }).eq("uuid", uuid);
  await db().from("jace_outbox").update({ status: "failed", last_error: "Disconnected" }).eq("sender", uuid).eq("status", "pending");
}

async function setFailed(uuid: string, e: JaceError) {
  if (e.kind === "disconnected")
    await db().from("jace_connections").update({ status: "disconnected", last_error: "Reconnect Jace to keep syncing" }).eq("uuid", uuid);
  else if (e.kind === "banned")
    await db().from("jace_connections").update({ status: "banned", last_error: "This Jace account is banned" }).eq("uuid", uuid);
  else
    await db().from("jace_connections").update({ last_error: e.message }).eq("uuid", uuid);
}

// --- people -------------------------------------------------------------------------------------

/** The Jace Social profile for a Jace account; someone who never signed in gets a placeholder
 *  (like "added as a friend but never signed in"), which becomes theirs when they sign in with Jace. */
async function profileForJace(sub: string, username: string | undefined, cache: Map<string, Profile>): Promise<Profile> {
  const hit = cache.get(sub);
  if (hit && (!username || hit.signed_up || hit.jace_name === username)) return hit;
  const find = async () => (await db().from("profiles").select("*").eq("jace_sub", sub).maybeSingle()).data as Profile | null;
  let p = hit ?? await find();
  // a placeholder made without a name (Jace's group list only has ids) takes it when it shows up
  if (p && !p.signed_up && username && p.jace_name !== username) {
    const name = username.slice(0, 32);
    await db().from("profiles").update({ name, jace_name: name }).eq("uuid", p.uuid);
    p = { ...p, name, jace_name: name };
  }
  if (!p) {
    const name = (username || "Jace user").slice(0, 32);
    const { data, error } = await db().from("profiles").insert({
      uuid: newPlayerId(), name, inbox: newToken(), signed_up: null, jace_sub: sub, jace_name: name, mc_linked: false,
    }).select("*").single();
    p = error ? await find() : data as Profile;      // someone else made it at the same moment
    if (!p) throw error;
  }
  cache.set(sub, p);
  return p;
}

/** People who talk on Jace become friends here, so their conversation shows in Chats. */
async function ensureFriends(a: string, b: string) {
  const { data } = await db().from("friendships").select("status")
    .or(`and(requester.eq.${a},addressee.eq.${b}),and(requester.eq.${b},addressee.eq.${a})`).maybeSingle();
  if (data) {
    if (data.status === "pending")
      await db().from("friendships").update({ status: "accepted" })
        .or(`and(requester.eq.${a},addressee.eq.${b}),and(requester.eq.${b},addressee.eq.${a})`);
    return;
  }
  await db().from("friendships").insert({ requester: a, addressee: b, status: "accepted" });   // a race: the pair index stops a second one
}

// --- pulling (and the first import) -------------------------------------------------------------

/** Start a sync for this person after answering, unless one ran in the last 20 seconds. */
export function pullSoon(uuid: string) {
  after(async () => {
    const c = await connection(uuid);
    if (!c || c.status !== "ok" || !c.sync_enabled || !c.token_enc) return;
    if (c.last_sync_at && Date.now() - new Date(c.last_sync_at).getTime() < 20_000) return;
    await syncPerson(uuid).catch((e) => console.error("jace pull", e));
  });
}

type Stats = { imported: number; conversations: number };

/** Bring this person's Jace messages in: everything the first time, then only what's new. */
export async function syncPerson(uuid: string): Promise<Stats & { skipped?: string }> {
  const c = await connection(uuid);
  const accessToken = tokenOf(c);
  if (!c || !accessToken) return { imported: 0, conversations: 0, skipped: "not connected" };
  if (c.status !== "ok") return { imported: 0, conversations: 0, skipped: c.status };
  if (!c.sync_enabled) return { imported: 0, conversations: 0, skipped: "off" };
  // one sync per person at a time (the cron job and opening a chat can overlap)
  const now = new Date();
  const { data: locked } = await db().from("jace_connections")
    .update({ syncing_until: new Date(now.getTime() + 90_000).toISOString() })
    .eq("uuid", uuid).or(`syncing_until.is.null,syncing_until.lt."${now.toISOString()}"`).select("uuid");
  if (!locked?.length) return { imported: 0, conversations: 0, skipped: "already syncing" };

  const stats: Stats = { imported: 0, conversations: 0 };
  try {
    const { data: meRow } = await db().from("profiles").select("*").eq("uuid", uuid).single();
    const me = meRow as Profile;
    if (!me.jace_sub) return { ...stats, skipped: "no Jace account" };
    const first = !c.imported_at;
    const cache = new Map<string, Profile>([[me.jace_sub, me]]);
    const { data: curRows } = await db().from("jace_sync_cursors").select("conversation, last_at").eq("uuid", uuid);
    const cursors = new Map((curRows ?? []).map((r) => [r.conversation as string, r.last_at as string]));
    // This Jace login's account was deleted (lib/accountDeletion.ts): a new account starts fresh -
    // only Jace messages from after that, so the old chats, friends and groups don't come back.
    const floors = new Map<string, string | null>();
    const floor = (await deletedAt(me.jace_sub, floors)) ?? undefined;
    const list = await jace<Conversations>(accessToken, "GET", "/api/oauth/messages");

    for (const d of list.direct ?? []) {
      const key = `dm:${d.user_id}`;
      const since = cursors.get(key) ?? floor;
      if (since && d.last_message && new Date(d.last_message.created_at) <= new Date(since)) continue;   // nothing new
      if (since && !d.last_message) continue;
      if (isJaceOfficial(d.user_id, d.username)) continue;   // appeals live only in the Appeals inbox (lib/appeals.ts)
      const partner = await profileForJace(d.user_id, d.username, cache);
      if (partner.uuid === me.uuid) continue;
      // ...and the same when the other person deleted theirs: nothing from before comes to their new account
      const from = later(since, await deletedAt(d.user_id, floors));
      if (from && d.last_message && new Date(d.last_message.created_at) <= new Date(from)) continue;
      const { messages } = await jace<{ messages: JaceMessage[] }>(accessToken, "GET",
        `/api/oauth/messages/dm/${encodeURIComponent(d.user_id)}${from ? `?since=${encodeURIComponent(from)}` : ""}`);
      if (!messages?.length) continue;
      await ensureFriends(me.uuid, partner.uuid);
      const n = await importDm(me, partner, messages, cache, first);
      stats.imported += n; stats.conversations++;
      await saveCursor(uuid, key, messages);
    }

    for (const g of list.groups ?? []) {
      const key = `g:${g.id}`;
      const since = cursors.get(key) ?? floor;
      const { messages } = await jace<{ messages: JaceMessage[] }>(accessToken, "GET",
        `/api/oauth/messages/groups/${encodeURIComponent(g.id)}${since ? `?since=${encodeURIComponent(since)}` : ""}`);
      if (!messages?.length && since === floor && floor) continue;   // a group from before the account was deleted
      const channelId = await channelForGroup(g, me, cache, floors);
      if (!messages?.length) continue;
      const n = await importGroup(channelId, me, messages, cache, first, floors);
      stats.imported += n; stats.conversations++;
      await saveCursor(uuid, key, messages);
    }

    await db().from("jace_connections").update({
      last_sync_at: new Date().toISOString(), last_error: null, ...(first ? { imported_at: new Date().toISOString() } : {}),
    }).eq("uuid", uuid);
    if (first && stats.imported) {                    // one refresh for the whole history, not a ping per message
      await notify([me.inbox], "friends", { kind: "jace_import" });
      await notify([me.inbox], "groups", { kind: "jace_import" });
    }
    return stats;
  } catch (e) {
    if (e instanceof JaceError) { await setFailed(uuid, e); return { ...stats, skipped: e.message }; }
    throw e;
  } finally {
    await db().from("jace_connections").update({ syncing_until: null }).eq("uuid", uuid);
  }
}

async function saveCursor(uuid: string, conversation: string, messages: JaceMessage[]) {
  const last = messages.reduce((m, x) => (new Date(x.created_at) > new Date(m) ? x.created_at : m), messages[0].created_at);
  await db().from("jace_sync_cursors").upsert({ uuid, conversation, last_at: last });
}

/**
 * Claim a Jace message before importing it: the link row (jace id, part 0) can only be made
 * once, so a message is never imported twice, even by two syncs at once, and our own pushes
 * (linked under their "app-" id when sent) are skipped. -> true if it's ours to import.
 */
async function claim(jaceId: string, kind: "dm" | "ch"): Promise<boolean> {
  const { data, error } = await db().from("jace_message_links")
    .upsert({ jace_id: jaceId, part: 0, kind, local_id: null, origin: "jace" }, { onConflict: "jace_id,part", ignoreDuplicates: true })
    .select("jace_id");
  if (error) throw error;
  return !!data?.length;
}

async function link(jaceId: string, kind: "dm" | "ch", ids: number[]) {
  await db().from("jace_message_links").update({ local_id: ids[0] }).eq("jace_id", jaceId).eq("part", 0);
  if (ids.length > 1)
    await db().from("jace_message_links").insert(ids.slice(1).map((id, i) => ({ jace_id: jaceId, part: i + 1, kind, local_id: id, origin: "jace" })));
}

async function unclaim(jaceId: string) {
  await db().from("jace_message_links").delete().eq("jace_id", jaceId).is("local_id", null);
}

async function importDm(me: Profile, partner: Profile, messages: JaceMessage[], cache: Map<string, Profile>, history: boolean) {
  let n = 0;
  for (const m of messages) {
    const body = String(m.body ?? "");
    if (!body.trim() || !(await claim(m.id, "dm"))) continue;
    try {
      const sender = m.from_id === me.jace_sub ? me : m.from_id === partner.jace_sub ? partner : await profileForJace(m.from_id, m.from_name, cache);
      const recipient = sender.uuid === me.uuid ? partner : me;
      const parts = splitBody(body, DM_MAX);
      const { data, error } = await db().from("messages").insert(parts.map((part) => ({
        sender: sender.uuid, recipient: recipient.uuid, body: part, created_at: m.created_at,
        read_at: history || sender.uuid === me.uuid ? new Date().toISOString() : null,    // old history isn't "unread"
      }))).select("id");
      if (error) throw error;
      const ids = (data ?? []).map((r) => r.id as number).sort((a, b) => a - b);
      await link(m.id, "dm", ids);
      n++;
      if (!history) {                                 // like a message sent here (app/api/v1/messages/route.ts)
        await notify([recipient.inbox], "message", { from: sender.uuid, name: sender.display_name || sender.name, id: ids[0] });
        await notify([sender.inbox], "dm_update", { from: sender.uuid, with: recipient.uuid, id: ids[0] });
      }
    } catch (e) {
      await unclaim(m.id);
      throw e;
    }
  }
  return n;
}

/** When the Jace Social account of this Jace login was last deleted (null: never). Cached per sync. */
async function deletedAt(sub: string | null | undefined, floors: Map<string, string | null>): Promise<string | null> {
  if (!sub) return null;
  if (!floors.has(sub)) {
    // kept for good (supabase/012_deleted_logins.sql); before 012: the accounts still in their 10 days
    const kept = await db().from("jace_deleted_logins").select("deleted_at").eq("jace_sub", sub).maybeSingle();
    const { data } = !kept.error ? kept : await db().from("profiles").select("deleted_at").eq("deleted_jace_sub", sub)
      .not("deleted_at", "is", null).order("deleted_at", { ascending: false }).limit(1).maybeSingle();
    floors.set(sub, (data?.deleted_at as string | undefined) ?? null);
  }
  return floors.get(sub)!;
}
const later = (a: string | undefined, b: string | null) => (!b ? a : !a || new Date(b) > new Date(a) ? b : a);

/** The group chat for a Jace group: made the first time anyone syncs it; new Jace members are added
 *  (but not someone whose account was deleted since: they come back only by writing in it again). */
async function channelForGroup(g: Conversations["groups"][number], me: Profile, cache: Map<string, Profile>,
  floors: Map<string, string | null>): Promise<string> {
  const { data: existing } = await db().from("jace_group_links").select("channel_id").eq("jace_group_id", g.id).maybeSingle();
  let channelId = existing?.channel_id as string | undefined;
  const subs = [...new Set([...(g.member_ids ?? []), me.jace_sub!])];
  const keep = await Promise.all(subs.map(async (sub) => sub === me.jace_sub || !(await deletedAt(sub, floors))));
  const members = await Promise.all(subs.filter((_, i) => keep[i]).map((sub) => profileForJace(sub, undefined, cache)));
  if (!channelId) {
    const name = (g.name || "Jace group").trim().slice(0, 48) || "Jace group";
    const { data: ch, error } = await db().from("channels")
      .insert({ name, owner: null, created_at: g.created_at || new Date().toISOString() }).select("id").single();
    if (error) throw error;
    const { error: linkErr } = await db().from("jace_group_links").insert({ jace_group_id: g.id, channel_id: ch.id });
    if (linkErr) {                                   // someone else's sync made it first: use theirs
      await db().from("channels").delete().eq("id", ch.id);
      const { data: theirs } = await db().from("jace_group_links").select("channel_id").eq("jace_group_id", g.id).single();
      channelId = theirs!.channel_id as string;
    } else channelId = ch.id as string;
  }
  const { data: have } = await db().from("channel_members").select("uuid").eq("channel_id", channelId);
  const missing = members.filter((p) => !(have ?? []).some((h) => h.uuid === p.uuid));
  if (missing.length) {
    await db().from("channel_members").upsert(missing.map((p) => ({ channel_id: channelId, uuid: p.uuid })),
      { onConflict: "channel_id,uuid", ignoreDuplicates: true });
    await notify(await inboxesOf(missing.map((p) => p.uuid)), "groups", { kind: "added", id: channelId });
  }
  return channelId!;
}

async function importGroup(channelId: string, me: Profile, messages: JaceMessage[], cache: Map<string, Profile>, history: boolean,
  floors: Map<string, string | null>) {
  const { data: rows } = await db().from("channel_members").select("uuid").eq("channel_id", channelId);
  const members = (rows ?? []).map((r) => r.uuid as string);
  let n = 0, newest = 0;
  for (const m of messages) {
    const body = String(m.body ?? "");
    const gone = await deletedAt(m.from_id, floors);
    if (gone && new Date(m.created_at) <= new Date(gone)) continue;   // written by an account that's deleted now
    if (!body.trim() || !(await claim(m.id, "ch"))) continue;
    try {
      const sender = await profileForJace(m.from_id, m.from_name, cache);
      if (!members.includes(sender.uuid)) {          // left the group on Jace's side later: still show who wrote it
        await db().from("channel_members").upsert({ channel_id: channelId, uuid: sender.uuid }, { onConflict: "channel_id,uuid", ignoreDuplicates: true });
        members.push(sender.uuid);
      }
      const { data, error } = await db().from("channel_messages").insert(splitBody(body, CHANNEL_MAX).map((part) => ({
        channel_id: channelId, sender: sender.uuid, body: part, kind: "text", created_at: m.created_at,
      }))).select("id");
      if (error) throw error;
      const ids = (data ?? []).map((r) => r.id as number).sort((a, b) => a - b);
      await link(m.id, "ch", ids);
      newest = Math.max(newest, ...ids);
      n++;
      if (!history) {                                 // like postMessage (lib/chat.ts)
        await notify(await inboxesOf(members.filter((u) => u !== sender.uuid)), "channel",
          { channel_id: channelId, server_id: null, id: ids[0], from: sender.uuid, name: sender.display_name || sender.name });
      }
    } catch (e) {
      await unclaim(m.id);
      throw e;
    }
  }
  if (history && newest)                              // old history isn't "unread" for the person importing it
    await db().from("channel_reads").upsert({ channel_id: channelId, uuid: me.uuid, last_read: newest });
  return n;
}

// --- pushing --------------------------------------------------------------------------------------

type Sent = { id: number; body: string; created_at: string };

/** A direct message was just sent here: also send it to Jace if both people use Jace (after answering). */
export function pushDmLater(sender: Profile, recipientUuid: string, m: Sent) {
  if (!sender.jace_sub || !String(m.body ?? "").trim()) return;
  after(async () => {
    const { data: r } = await db().from("profiles").select("jace_sub").eq("uuid", recipientUuid).maybeSingle();
    if (!r?.jace_sub || r.jace_sub === sender.jace_sub) return;
    await queuePush(sender, "dm", m, r.jace_sub as string).catch((e) => console.error("jace push", e));
  });
}

/** A group chat message was just sent here: also send it to Jace if the chat came from a Jace group. */
export function pushChannelLater(sender: Profile, channelId: string, m: Sent) {
  if (!sender.jace_sub || !String(m.body ?? "").trim()) return;
  after(async () => {
    const { data: g, error } = await db().from("jace_group_links").select("jace_group_id").eq("channel_id", channelId).maybeSingle();
    if (error || !g) return;
    await queuePush(sender, "ch", m, g.jace_group_id as string).catch((e) => console.error("jace push", e));
  });
}

async function queuePush(sender: Profile, kind: "dm" | "ch", m: Sent, target: string) {
  const c = await connection(sender.uuid);
  if (!c || c.status !== "ok" || !c.sync_enabled || !c.token_enc) return;      // this person doesn't sync
  const { data: from } = await db().from("jace_message_links").select("origin").eq("kind", kind).eq("local_id", m.id).maybeSingle();
  if (from) return;                                  // it came from Jace (or is already on its way)
  const externalId = externalIdFor(kind, m.id);
  const clientId = process.env.JACE_OAUTH_CLIENT_ID ?? "";
  // mark it as ours first, under the id Jace will give it, so pulling never brings it back
  await db().from("jace_message_links").upsert({ jace_id: appMessageId(clientId, externalId), part: 0, kind, local_id: m.id, origin: "local" },
    { onConflict: "jace_id,part", ignoreDuplicates: true });
  const { data: row } = await db().from("jace_outbox").upsert({
    sender: sender.uuid, kind, local_id: m.id, target, external_id: externalId,
    body: [...m.body].slice(0, JACE_MAX).join(""), created_at: m.created_at,
  }, { onConflict: "external_id", ignoreDuplicates: true }).select("*").maybeSingle();
  if (row) await deliver(row as Outbox);
}

type Outbox = {
  id: number; sender: string; kind: "dm" | "ch"; local_id: number; target: string; external_id: string; body: string;
  created_at: string; status: string; attempts: number;
};

/** Send one queued message to Jace and record how it went. */
async function deliver(row: Outbox, accessToken?: string | null): Promise<void> {
  const t = accessToken ?? tokenOf(await connection(row.sender));
  if (!t) {                                          // disconnected meanwhile: try again after reconnecting
    await db().from("jace_outbox").update({ next_at: new Date(Date.now() + 6 * 3600_000).toISOString(), last_error: "Not connected" }).eq("id", row.id);
    return;
  }
  const path = `/api/oauth/messages/${row.kind === "dm" ? "dm" : "groups"}/${encodeURIComponent(row.target)}`;
  // never in the future, even if this server's clock is ahead of Jace's
  const createdAt = new Date(Math.min(new Date(row.created_at).getTime(), Date.now() - 1000)).toISOString();
  try {
    await jace(t, "POST", path, { messages: [{ body: row.body, created_at: createdAt, external_id: row.external_id }] });
    await db().from("jace_outbox").update({ status: "sent", attempts: row.attempts + 1, last_error: null }).eq("id", row.id);
  } catch (e) {
    if (!(e instanceof JaceError)) throw e;
    const attempts = row.attempts + 1;
    const update: Record<string, unknown> = { attempts, last_error: e.message };
    if (e.kind === "muted") update.status = "muted";                         // kept here, not on Jace; no retries
    else if (e.kind === "banned" || e.kind === "not_found" || e.kind === "rejected") update.status = "failed";
    else if (e.kind === "disconnected") update.next_at = new Date(Date.now() + 6 * 3600_000).toISOString();   // waits for "Reconnect Jace"
    else if (attempts >= MAX_ATTEMPTS) update.status = "failed";
    else update.next_at = new Date(Date.now() + backoffSeconds(attempts) * 1000).toISOString();
    await db().from("jace_outbox").update(update).eq("id", row.id);
    if (e.kind === "disconnected" || e.kind === "banned") await setFailed(row.sender, e);
  }
}

/** Resend what's due (the cron job), or everything one person has waiting (after they reconnect). */
export async function retryOutbox(opts: { sender?: string; limit?: number } = {}) {
  let q = db().from("jace_outbox").select("*").eq("status", "pending").order("id").limit(opts.limit ?? 100);
  q = opts.sender ? q.eq("sender", opts.sender) : q.lte("next_at", new Date().toISOString());
  const { data, error } = await q;
  if (error) return 0;
  for (const row of (data ?? []) as Outbox[]) await deliver(row);
  return data?.length ?? 0;
}

/** The cron job: resend what's due, then sync whoever waited longest, within the time it has. */
export async function syncEveryone(budgetMs = 50_000) {
  const start = Date.now();
  const resent = await retryOutbox({ limit: 200 });
  const { data, error } = await db().from("jace_connections").select("uuid")
    .eq("status", "ok").eq("sync_enabled", true).not("token_enc", "is", null)
    .order("last_sync_at", { ascending: true, nullsFirst: true }).limit(200);
  if (error) return { resent, synced: 0, imported: 0 };
  let synced = 0, imported = 0;
  for (const { uuid } of data ?? []) {
    if (Date.now() - start > budgetMs) break;
    try { imported += (await syncPerson(uuid as string)).imported; synced++; }
    catch (e) { console.error("jace sync", uuid, e); }
  }
  return { resent, synced, imported };
}
