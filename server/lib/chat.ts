// Group chats and servers. Both are made of "channels" with "channel_messages":
// a group chat is one channel with its own member list (server_id null), and a
// server has several channels that every member of the server can read.
import { randomBytes } from "node:crypto";
import { previewLater, type Embed } from "./embeds";
import { channelPerms, has, overridesFor, P, permsIn, serverCtx, type ServerCtx } from "./perms";
import { ApiError, db, inboxesOf, me, notify, publicProfile, type Profile } from "./server";

export const MAX_GROUP = 10;           // people in one group chat (like Discord's group DMs)
export const MAX_SERVERS = 100;        // servers one player can be in

export type Channel = {
  id: string; server_id: string | null; name: string; topic: string | null; icon_url: string | null;
  owner: string | null; position: number; created_at: string;
  kind: "text" | "voice" | "announcement" | "category"; parent_id: string | null; slowmode: number; user_limit: number;
};
export type Attachment = { url: string; name: string; type: string; size: number; width?: number; height?: number; no_preview?: boolean };

/** The columns every message read returns. */
export const MESSAGE_COLUMNS: string = "id, channel_id, sender, body, kind, created_at, edited_at, reply_to, attachments, embeds, "
  + "mentions, mention_roles, mention_everyone, pinned_at, components";
export type Role = "owner" | "admin" | "member";

export const inviteCode = () => randomBytes(6).toString("base64url");

export function cleanId(v: unknown): string {
  const s = String(v ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(s)) throw new ApiError(400, "Bad id");
  return s.toLowerCase();
}

export function cleanName(v: unknown, what: string, max = 48): string {
  const s = String(v ?? "").trim();
  if (!s) throw new ApiError(400, `${what} can't be empty`);
  if (s.length > max) throw new ApiError(400, `${what} can be up to ${max} characters`);
  return s;
}

/** Text channel names look like Discord's: lowercase-with-dashes. */
export const channelName = (v: unknown) =>
  cleanName(v, "Channel name").toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 48) || "channel";

/** Is this player in the server at all? (Their legacy owner/admin/member role, or null.) */
export async function memberRole(serverId: string, uuid: string): Promise<Role | null> {
  const { data } = await db().from("server_members").select("role").eq("server_id", serverId).eq("uuid", uuid).maybeSingle();
  return (data?.role as Role) ?? null;
}

/** Older checks by role, now in terms of permissions: admin = manage the server. */
export async function requireRole(serverId: string, uuid: string, need: "member" | "admin" | "owner"): Promise<ServerCtx> {
  const ctx = await serverCtx(serverId, uuid);
  if (need === "owner" && !ctx.owner) throw new ApiError(403, "Only the owner can do that");
  if (need === "admin" && !has(ctx.base, P.MANAGE_SERVER)) throw new ApiError(403, "You don't have permission to manage the server");
  return ctx;
}

/** Everyone in a server who can see this channel (for notifications). */
export async function channelViewers(channel: Channel): Promise<string[]> {
  const serverId = channel.server_id!;
  const [{ data: members }, { data: server }, { data: roles }, { data: memberRoles }, overrides] = await Promise.all([
    db().from("server_members").select("uuid, role, timeout_until").eq("server_id", serverId),
    db().from("servers").select("*").eq("id", serverId).single(),
    db().from("server_roles").select("*").eq("server_id", serverId),
    db().from("server_member_roles").select("uuid, role_id").eq("server_id", serverId),
    overridesFor([channel.id, ...(channel.parent_id ? [channel.parent_id] : [])]),
  ]);
  if (!overrides.length) return (members ?? []).map((m) => m.uuid);   // nothing private: everyone
  const all = (roles ?? []).map((r) => ({ ...r, permissions: Number(r.permissions) }));
  return (members ?? []).filter((m) => {
    const mine = (memberRoles ?? []).filter((r) => r.uuid === m.uuid).map((r) => r.role_id);
    let base = all.find((r) => r.is_default)?.permissions ?? 0;
    for (const r of all) if (mine.includes(r.id)) base |= r.permissions;
    const ctx = { server, uuid: m.uuid, owner: server?.owner === m.uuid, roles: all, myRoles: mine, base,
      top: 0, nickname: null, timeoutUntil: null } as ServerCtx;
    if (ctx.owner || has(base, P.ADMIN)) return true;
    return has(channelPerms(ctx, channel, overrides), P.VIEW);
  }).map((m) => m.uuid);
}

/**
 * The channel, if this player may see it, plus everyone who can (to notify). For server
 * channels also their permissions there (ctx, perms); group chats allow everything.
 */
export async function channelFor(channelId: string, uuid: string) {
  const { data } = await db().from("channels").select("*").eq("id", cleanId(channelId)).maybeSingle();
  if (!data) throw new ApiError(404, "Chat not found");
  const ch = data as Channel;
  if (ch.server_id) {
    let ctx: ServerCtx;
    try { ctx = await serverCtx(ch.server_id, uuid); } catch { throw new ApiError(404, "Chat not found"); }
    const perms = await permsIn(ctx, ch);
    if (!has(perms, P.VIEW)) throw new ApiError(404, "Chat not found");
    return { channel: ch, members: await channelViewers(ch), ctx, perms };
  }
  const { data: rows } = await db().from("channel_members").select("uuid").eq("channel_id", ch.id);
  const members = (rows ?? []).map((r) => r.uuid as string);
  if (!members.includes(uuid)) throw new ApiError(404, "Chat not found");
  // group chats: everyone can do everything except manage the server
  const perms = P.VIEW | P.SEND | P.ATTACH | P.REACT | P.MENTION_EVERYONE | P.CONNECT | P.SPEAK | P.STREAM;
  return { channel: ch, members, ctx: null as ServerCtx | null, perms };
}

/** Mentions in a message: <@playerid>, <@&roleid>, @everyone / @here. */
export async function parseMentions(body: string, channel: Channel, members: string[], perms: number) {
  const ids = [...body.matchAll(/<@([0-9a-f]{32})>/g)].map((m) => m[1]).filter((id) => members.includes(id));
  let roles = [...body.matchAll(/<@&([0-9a-f-]{36})>/g)].map((m) => m[1]);
  const everyone = /(^|\s)@(everyone|here)\b/.test(body) && has(perms, P.MENTION_EVERYONE);
  if (roles.length && channel.server_id) {
    const { data } = await db().from("server_roles").select("id, mentionable").eq("server_id", channel.server_id).in("id", roles);
    roles = (data ?? []).filter((r) => r.mentionable || has(perms, P.MENTION_EVERYONE)).map((r) => r.id);
  } else roles = [];
  let notifyIds = new Set(ids);
  if (everyone) notifyIds = new Set(members);
  else if (roles.length) {
    const { data } = await db().from("server_member_roles").select("uuid").in("role_id", roles);
    for (const r of data ?? []) if (members.includes(r.uuid)) notifyIds.add(r.uuid);
  }
  return { mentions: [...new Set(ids)], mention_roles: roles, mention_everyone: everyone, notify: [...notifyIds] };
}

/** Unread counts for channels (messages newer than what this player last read). */
export async function unreadCounts(uuid: string, channelIds: string[]): Promise<Record<string, number>> {
  if (!channelIds.length) return {};
  const { data: reads } = await db().from("channel_reads").select("channel_id, last_read")
    .eq("uuid", uuid).in("channel_id", channelIds);
  const last: Record<string, number> = {};
  for (const r of reads ?? []) last[r.channel_id] = Number(r.last_read);
  const out: Record<string, number> = {};
  await Promise.all(channelIds.map(async (id) => {
    const { count } = await db().from("channel_messages").select("id", { count: "exact", head: true })
      .eq("channel_id", id).gt("id", last[id] ?? 0).neq("sender", uuid);
    out[id] = count ?? 0;
  }));
  return out;
}

/** Profiles (public view) for a list of players, keyed by id. */
export async function profilesById(uuids: string[]) {
  if (!uuids.length) return {} as Record<string, ReturnType<typeof publicProfile>>;
  const { data } = await db().from("profiles").select("*").in("uuid", uuids);
  return Object.fromEntries((data ?? []).map((p) => [p.uuid, publicProfile(p as Profile)]));
}

export type PostExtras = {
  reply_to?: number | null; attachments?: Attachment[]; perms?: number; components?: unknown[]; embeds?: Embed[];
};

/** Post a message (or a system line like "Alex joined") and tell everyone who can see it. */
export async function postMessage(channel: Channel, members: string[], sender: Profile | null, body: string,
                                  kind: "text" | "system" = "text", extras: PostExtras = {}) {
  const mentions = kind === "text" && sender
    ? await parseMentions(body, channel, members, extras.perms ?? 0)
    : { mentions: [], mention_roles: [], mention_everyone: false, notify: [] as string[] };
  const embeds = extras.embeds ?? [];          // link previews are added after sending (previewLater below)
  if (extras.reply_to) {
    const { data: parent } = await db().from("channel_messages").select("id, channel_id, sender").eq("id", extras.reply_to).maybeSingle();
    if (!parent || parent.channel_id !== channel.id) throw new ApiError(400, "That message isn't in this chat");
    if (parent.sender && members.includes(parent.sender)) mentions.notify.push(parent.sender);   // replies ping
  }
  const { data: row, error } = await db().from("channel_messages").insert({
    channel_id: channel.id, sender: sender?.uuid ?? null, body, kind,
    reply_to: extras.reply_to ?? null, attachments: extras.attachments ?? [], embeds, components: extras.components ?? [],
    mentions: mentions.mentions, mention_roles: mentions.mention_roles, mention_everyone: mentions.mention_everyone,
  }).select(MESSAGE_COLUMNS).single();
  if (error) throw error;
  const data = row as unknown as { id: number } & Record<string, unknown>;
  if (sender) {
    await db().from("channel_reads").upsert({ channel_id: channel.id, uuid: sender.uuid, last_read: data.id });
  }
  if (sender?.is_bot) {     // every message a bot sends (hosted, block or through the API) goes in its activity log
    const { logBot, short } = await import("./botlog");
    await logBot(sender.uuid, "message", `Sent in ${channel.server_id ? "#" : ""}${channel.name ?? "a group chat"}: ${short(body, 300)}`,
      { server_id: channel.server_id, channel_id: channel.id });
  }
  const pinged = new Set(mentions.notify.filter((m) => m !== sender?.uuid));
  const payload = {
    channel_id: channel.id, server_id: channel.server_id, id: data.id,
    from: sender?.uuid ?? null, name: sender ? (sender.display_name || sender.name) : null,
  };
  const others = members.filter((m) => m !== sender?.uuid);
  await notify(await inboxesOf(others.filter((m) => !pinged.has(m))), "channel", payload);
  if (pinged.size) await notify(await inboxesOf([...pinged]), "channel", { ...payload, mentioned: true });
  if (kind === "text" && !extras.embeds) {
    previewLater("channel_messages", data.id, body, async () =>
      notify(await inboxesOf(members), "channel", { channel_id: channel.id, server_id: channel.server_id, id: data.id, edited: true }));
  }
  // bots in this chat react to it (block bots, the Jace bot, and code bots' "message" event)
  if (sender && kind === "text") {
    const { onChannelMessage } = await import("./bots");
    await onChannelMessage(channel, members, sender, data).catch((e: unknown) => console.error("bots", e));
  }
  return data;
}

/**
 * Messages are listed by their time, then id (history imported from Jace keeps its original
 * times, so ids aren't always in time order). For "?before=<id>": the PostgREST filter for
 * messages older than that one, or null if it doesn't exist.
 */
export async function olderThan(table: "messages" | "channel_messages", id: number): Promise<string | null> {
  const { data } = await db().from(table).select("created_at").eq("id", id).maybeSingle();
  if (!data) return null;
  const t = `"${data.created_at}"`;
  return `created_at.lt.${t},and(created_at.eq.${t},id.lt.${id})`;
}

/** Tell players something about a group or server changed (members, names, channels). */
export async function notifyChanged(uuids: string[], event: "groups" | "servers", payload: Record<string, unknown>) {
  await notify(await inboxesOf(uuids), event, payload);
}

/** A group/server message by id, if this player can see its chat. */
export async function loadChannelMessage(req: Request, idParam: string) {
  const p = await me(req);
  const id = Number(idParam);
  const { data: m } = await db().from("channel_messages").select("*").eq("id", id).maybeSingle();
  if (!m) throw new ApiError(404, "Message not found");
  const { channel, members, perms } = await channelFor(m.channel_id, p.uuid);
  return { p, m, channel, members, perms };
}

/** A system line in the server's system channel (or its first text channel) + a refresh. */
export async function announce(serverId: string, text: string) {
  const { data: s } = await db().from("servers").select("system_channel").eq("id", serverId).single();
  let q = db().from("channels").select("*").eq("server_id", serverId).neq("kind", "voice").neq("kind", "category");
  q = s?.system_channel ? q.eq("id", s.system_channel) : q.order("position");
  const { data: ch } = await q.limit(1).maybeSingle();
  const { data: members } = await db().from("server_members").select("uuid").eq("server_id", serverId);
  const all = (members ?? []).map((m) => m.uuid);
  if (ch) await postMessage(ch as Channel, all, null, text, "system");
  await notifyChanged(all, "servers", { kind: "changed", server_id: serverId });
  return all;
}


/** The server for an invite code or custom link (vanity). */
export async function findInvite(code: string) {
  const c = code.trim();
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(c)) throw new ApiError(404, "That invite doesn't work");
  const cols = "id, name, icon_url, banner_url, description, accent_color, vanity, invites_paused, created_at";
  let { data } = await db().from("servers").select(cols).eq("invite_code", c).maybeSingle();
  if (!data) ({ data } = await db().from("servers").select(cols).eq("vanity", c.toLowerCase()).maybeSingle());
  if (!data) throw new ApiError(404, "That invite doesn't work - ask for a new one");
  return data;
}

