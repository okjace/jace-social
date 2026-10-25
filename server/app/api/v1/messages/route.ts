// GET ?with=<uuid>&before=<id>: chat history with a friend (newest 50, oldest first), with reactions
//   and the messages replied to
// POST {to, body, reply_to?, attachments?}: send a message to a friend
import { body, cleanUuid, db, handler, me } from "@/lib/server";
import { olderThan } from "@/lib/chat";
import { DM_COLUMNS, sendDm, type DmInput } from "@/lib/dms";
import { pullSoon } from "@/lib/jaceSync";
import { reactionsFor, repliedTo } from "@/lib/reactions";

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
  const b = await body<DmInput>(req);
  return { message: await sendDm(p, b) };
});
