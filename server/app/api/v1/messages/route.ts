// GET ?with=<uuid>&before=<id>: chat history with a friend (newest 50, oldest first), with reactions
//   and the messages replied to
// POST {to, body, reply_to?, attachments?}: send a message to a friend
import { ApiError, areFriends, body, cleanUuid, db, handler, me, notify } from "@/lib/server";
import { olderThan } from "@/lib/chat";
import { pullSoon, pushDmLater } from "@/lib/jaceSync";
import { previewLater } from "@/lib/embeds";
import { reactionsFor, repliedTo } from "@/lib/reactions";
import { cleanAttachments } from "@/lib/uploads";

const DM_COLUMNS = "id, sender, recipient, body, created_at, read_at, edited_at, reply_to, attachments, embeds";

export const GET = handler(async (req) => {
  const p = await me(req);
  const params = new URL(req.url).searchParams;
  const other = cleanUuid(params.get("with"));
  let q = db().from("messages").select(DM_COLUMNS)
    .or(`and(sender.eq.${p.uuid},recipient.eq.${other}),and(sender.eq.${other},recipient.eq.${p.uuid})`)
    .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(50);
  const before = Number(params.get("before"));
  if (before) {
    const older = await olderThan("messages", before);
    q = older ? q.or(older) : q.lt("id", before);
  }
  const { data, error } = await q;
  if (error) throw error;
  pullSoon(p.uuid);                                  // anything new on Jace arrives right after (lib/jaceSync.ts)
  const msgs = (data ?? []).reverse();
  const [reactions, replies] = await Promise.all([
    reactionsFor("d", msgs.map((m) => m.id), p.uuid),
    repliedTo("messages", msgs.map((m) => m.reply_to)),
  ]);
  return { messages: msgs.map((m) => ({ ...m, reactions: reactions[m.id] ?? [] })), replies };
});

export const POST = handler(async (req) => {
  const p = await me(req);
  const b = await body<{ to?: string; body?: string; reply_to?: number; attachments?: unknown }>(req);
  const to = cleanUuid(b.to);
  const text = String(b.body ?? "").trim();
  const attachments = cleanAttachments(b.attachments, p.uuid);
  if (!text && !attachments.length) throw new ApiError(400, "Message is empty");
  if (text.length > 2000) throw new ApiError(400, "Messages can be up to 2000 characters");
  if (!(await areFriends(p.uuid, to))) throw new ApiError(403, "You can only message friends");
  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  const { count } = await db().from("messages").select("id", { count: "exact", head: true })
    .eq("sender", p.uuid).gt("created_at", minuteAgo);
  if ((count ?? 0) >= 20) throw new ApiError(429, "Slow down a little - try again in a minute");
  let replyTo: number | null = null;
  if (b.reply_to) {
    const { data: parent } = await db().from("messages").select("id, sender, recipient").eq("id", Number(b.reply_to)).maybeSingle();
    if (!parent || ![parent.sender, parent.recipient].includes(p.uuid) || ![parent.sender, parent.recipient].includes(to))
      throw new ApiError(400, "That message isn't in this chat");
    replyTo = parent.id;
  }
  const { data, error } = await db().from("messages")
    .insert({ sender: p.uuid, recipient: to, body: text, reply_to: replyTo, attachments })
    .select(DM_COLUMNS).single();
  if (error) throw error;
  const { data: o } = await db().from("profiles").select("inbox").eq("uuid", to).single();
  if (o) await notify([o.inbox], "message", { from: p.uuid, name: p.name, id: data.id });
  pushDmLater(p, to, data);                          // also to Jace, when both people use Jace (after answering)
  previewLater("messages", data.id, text, async () => {
    await notify([o?.inbox, p.inbox].filter(Boolean) as string[], "dm_update", { from: p.uuid, with: to, id: data.id, edited: true });
  });
  return { message: data };
});
