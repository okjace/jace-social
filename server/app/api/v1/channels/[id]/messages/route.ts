// GET ?before=<id>&around=<id>: 50 messages (oldest first) with senders, reactions and replied-to messages
// POST {body, reply_to?, attachments?}: send a message to a group chat or server channel
import { checkUploads } from "@/lib/storage";
import { ApiError, body, db, handler, me } from "@/lib/server";
import { MESSAGE_COLUMNS, channelFor, olderThan, postMessage, profilesById, type Attachment } from "@/lib/chat";
import { pullSoon, pushChannelLater } from "@/lib/jaceSync";
import { has, P } from "@/lib/perms";
import { reactionsFor, repliedTo } from "@/lib/reactions";
import { cleanAttachments } from "@/lib/uploads";

export const maxDuration = 30;

export const GET = handler(async (req, ctx) => {
  const p = await me(req);
  const { channel, perms } = await channelFor((await ctx.params).id, p.uuid);
  const params = new URL(req.url).searchParams;
  const before = Number(params.get("before"));
  let q = db().from("channel_messages").select(MESSAGE_COLUMNS)
    .eq("channel_id", channel.id).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(50);
  if (before) {
    const older = await olderThan("channel_messages", before);
    q = older ? q.or(older) : q.lt("id", before);
  }
  const { data, error } = await q;
  if (error) throw error;
  if (!channel.server_id) pullSoon(p.uuid);          // group chats can come from Jace (lib/jaceSync.ts)
  const msgs = (data ?? []).reverse() as unknown as { id: number; sender: string | null; reply_to: number | null }[];
  const replies = await repliedTo("channel_messages", msgs.map((m) => m.reply_to));
  const replied = Object.values(replies) as { sender: string | null }[];
  const senders = [...msgs.map((m) => m.sender), ...replied.map((r) => r.sender)].filter(Boolean) as string[];
  const [people, reactions] = await Promise.all([
    profilesById([...new Set(senders)]),
    reactionsFor("c", msgs.map((m) => m.id), p.uuid),
  ]);
  return {
    channel, perms, people, replies,
    messages: msgs.map((m) => ({ ...m, reactions: reactions[m.id] ?? [] })),
  };
});

export const POST = handler(async (req, ctx) => {
  const p = await me(req);
  const { channel, members, ctx: server, perms } = await channelFor((await ctx.params).id, p.uuid);
  if (channel.kind === "category" || channel.kind === "voice") throw new ApiError(400, "You can't send messages there");
  if (server?.timeoutUntil && new Date(server.timeoutUntil) > new Date())
    throw new ApiError(403, `You're timed out until ${new Date(server.timeoutUntil).toLocaleString()}`);
  if (!has(perms, P.SEND) || (channel.kind === "announcement" && !has(perms, P.MANAGE_MESSAGES)))
    throw new ApiError(403, "You can't send messages in this channel");
  const b = await body<{ body?: string; reply_to?: number; attachments?: Attachment[]; no_embed?: unknown }>(req);
  const text = String(b.body ?? "").trim();
  const attachments = cleanAttachments(b.attachments, p.uuid);
  await checkUploads(attachments.map((x) => x.url));   // real sizes on R2/B2 (lib/storage.ts)
  if (attachments.length && !has(perms, P.ATTACH)) throw new ApiError(403, "You can't attach files here");
  if (!text && !attachments.length) throw new ApiError(400, "Message is empty");
  if (text.length > 2000) throw new ApiError(400, "Messages can be up to 2000 characters");
  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  const { count } = await db().from("channel_messages").select("id", { count: "exact", head: true })
    .eq("sender", p.uuid).gt("created_at", minuteAgo);
  if ((count ?? 0) >= 30) throw new ApiError(429, "Slow down a little - try again in a minute");
  if (channel.slowmode && !has(perms, P.MANAGE_MESSAGES)) {
    const since = new Date(Date.now() - channel.slowmode * 1000).toISOString();
    const { count: recent } = await db().from("channel_messages").select("id", { count: "exact", head: true })
      .eq("channel_id", channel.id).eq("sender", p.uuid).gt("created_at", since);
    if (recent) throw new ApiError(429, `Slowmode is on: one message every ${channel.slowmode} seconds`);
  }
  const message = await postMessage(channel, members, p, text, "text", { reply_to: b.reply_to ? Number(b.reply_to) : null, attachments, perms,
    ...(b.no_embed === true ? { embeds: [] } : {}) });   // no link preview: the sender said no
  if (!channel.server_id) pushChannelLater(p, channel.id, message as { id: number; body: string; created_at: string });
  return { message };
});
