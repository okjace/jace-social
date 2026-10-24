// GET ?with=<uuid>&before=<id>: chat history with a friend (newest 50, oldest first), with reactions
//   and the messages replied to
// POST {to, body, reply_to?, attachments?}: send a message to a friend
import { ApiError, areFriends, body, cleanUuid, db, handler, JACE_BOT, me, notify } from "@/lib/server";
import { answerLater } from "@/lib/jaceBot";
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

/** They let anyone message them (Settings -> Links & privacy -> "Anyone can find me and message me"). */
async function opensDms(uuid: string) {
  const { data } = await db().from("profiles").select("settings, is_bot, banned_at, deleted_at").eq("uuid", uuid).maybeSingle();
  return !!data && !data.is_bot && !data.banned_at && !data.deleted_at && (data.settings as { open_dms?: boolean } | null)?.open_dms === true;
}

/** They wrote to you first because you let anyone message you, so you can answer them - they're in
 *  their own settings.dm_allow (set below, never by the app; removing a friend clears it). */
async function wroteFirst(them: string, you: string) {
  const { data } = await db().from("profiles").select("settings").eq("uuid", them).maybeSingle();
  return ((data?.settings as { dm_allow?: string[] } | null)?.dm_allow ?? []).includes(you);
}

/** You wrote to someone who isn't your friend (they let anyone message them): they may answer you. */
async function allowReplies(p: { uuid: string; settings?: Record<string, unknown> | null }, to: string) {
  const { data } = await db().from("profiles").select("settings").eq("uuid", p.uuid).single();
  const settings = (data?.settings ?? {}) as { dm_allow?: string[] };
  if ((settings.dm_allow ?? []).includes(to)) return;
  await db().from("profiles").update({ settings: { ...settings, dm_allow: [to, ...(settings.dm_allow ?? [])].slice(0, 300) } }).eq("uuid", p.uuid);
}

export const POST = handler(async (req) => {
  const p = await me(req);
  const b = await body<{ to?: string; body?: string; reply_to?: number; attachments?: unknown; no_embed?: unknown }>(req);
  const to = cleanUuid(b.to);
  const text = String(b.body ?? "").trim();
  const attachments = cleanAttachments(b.attachments, p.uuid);
  if (!text && !attachments.length) throw new ApiError(400, "Message is empty");
  if (text.length > 2000) throw new ApiError(400, "Messages can be up to 2000 characters");
  // anyone can message the official Jace bot, and it can message anyone
  const official = p.uuid === JACE_BOT || to === JACE_BOT;
  if (to === p.uuid) throw new ApiError(400, "That's you");
  const friends = official || (await areFriends(p.uuid, to));
  const open = !friends && (await opensDms(to));
  const answering = !friends && !open && (await wroteFirst(to, p.uuid));
  if (!friends && !open && !answering)
    throw new ApiError(403, "You can only message friends (or people who let anyone message them)");
  if (open || answering) await allowReplies(p, to);      // and they can answer you (answering: you accepted the chat)
  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  const { count } = await db().from("messages").select("id", { count: "exact", head: true })
    .eq("sender", p.uuid).gt("created_at", minuteAgo);
  if ((count ?? 0) >= (p.uuid === JACE_BOT ? 300 : 20)) throw new ApiError(429, "Slow down a little - try again in a minute");
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
  if (to === JACE_BOT) answerLater(p, text);               // the Jace bot answers (AI, unless a person has the chat)
  pushDmLater(p, to, data);                          // also to Jace, when both people use Jace (after answering)
  if (b.no_embed !== true) previewLater("messages", data.id, text, async () => {   // (no_embed: the sender said no link preview)
    await notify([o?.inbox, p.inbox].filter(Boolean) as string[], "dm_update", { from: p.uuid, with: to, id: data.id, edited: true });
  });
  return { message: data };
});
