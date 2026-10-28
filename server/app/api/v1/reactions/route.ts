// POST {scope: "c"|"d", message_id, emoji}: add a reaction; DELETE (same body): remove yours.
// scope "c" = group/server messages, "d" = direct messages.
import { assertCanPost } from "@/lib/moderation";
import { ApiError, body, db, handler, inboxesOf, me, notify, type Profile } from "@/lib/server";
import { channelFor } from "@/lib/chat";
import { has, P } from "@/lib/perms";

const MAX_KINDS = 20;

async function target(p: Profile, scope: string, id: number) {
  if (scope === "c") {
    const { data: m } = await db().from("channel_messages").select("id, channel_id").eq("id", id).maybeSingle();
    if (!m) throw new ApiError(404, "Message not found");
    const { channel, members, perms } = await channelFor(m.channel_id, p.uuid);
    if (!has(perms, P.REACT)) throw new ApiError(403, "You can't add reactions here");
    return { notifyTo: members, event: "channel", payload: { channel_id: channel.id, server_id: channel.server_id, id, reacted: true } };
  }
  if (scope === "d") {
    const { data: m } = await db().from("messages").select("id, sender, recipient").eq("id", id).maybeSingle();
    if (!m || (m.sender !== p.uuid && m.recipient !== p.uuid)) throw new ApiError(404, "Message not found");
    const other = m.sender === p.uuid ? m.recipient : m.sender;
    return { notifyTo: [other, p.uuid], event: "dm_update", payload: { from: p.uuid, id, reacted: true, with: other } };
  }
  throw new ApiError(400, "scope must be c or d");
}

async function react(req: Request, on: boolean) {
  const p = await me(req);
  const b = await body<{ scope?: string; message_id?: number; emoji?: string }>(req);
  const id = Number(b.message_id);
  const emoji = String(b.emoji ?? "").trim();
  if (!id || !emoji || emoji.length > 32 || /\s/.test(emoji)) throw new ApiError(400, "Pick an emoji");
  if (on) assertCanPost(p);                                 // muted: no reactions either (lib/moderation.ts)
  const t = await target(p, String(b.scope), id);
  if (on) {
    const { data: kinds } = await db().from("message_reactions").select("emoji").eq("scope", b.scope!).eq("message_id", id);
    const set = new Set((kinds ?? []).map((k) => k.emoji));
    if (!set.has(emoji) && set.size >= MAX_KINDS) throw new ApiError(400, `Up to ${MAX_KINDS} different reactions per message`);
    await db().from("message_reactions").upsert({ scope: b.scope, message_id: id, uuid: p.uuid, emoji });
    if (p.is_bot) {           // API bots' reactions go in their activity log too
      const { logBot } = await import("@/lib/botlog");
      const where = t.payload as { server_id?: string | null; channel_id?: string };
      await logBot(p.uuid, "react", `Reacted ${emoji} to a message`, { server_id: where.server_id ?? null, channel_id: where.channel_id ?? null });
    }
  } else {
    await db().from("message_reactions").delete().eq("scope", b.scope!).eq("message_id", id).eq("uuid", p.uuid).eq("emoji", emoji);
  }
  await notify(await inboxesOf(t.notifyTo), t.event, t.payload);
  return { ok: true };
}

export const POST = handler(async (req) => react(req, true));
export const DELETE = handler(async (req) => react(req, false));
