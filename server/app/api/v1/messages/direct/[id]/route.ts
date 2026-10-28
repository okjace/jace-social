// PATCH {body, link_preview?, file_previews?}: edit your own direct message (and turn its previews on or off); DELETE: delete it
import { guardPost } from "@/lib/automod";
import { ApiError, body, db, handler, me, notify } from "@/lib/server";
import { previewLater } from "@/lib/embeds";
import { editChanges } from "@/lib/uploads";

async function load(req: Request, idParam: string) {
  const p = await me(req);
  const { data: m } = await db().from("messages").select("*").eq("id", Number(idParam)).maybeSingle();
  if (!m || m.sender !== p.uuid) throw new ApiError(404, "Message not found");
  const { data: o } = await db().from("profiles").select("inbox").eq("uuid", m.recipient).single();
  return { p, m, inbox: o?.inbox as string | undefined };
}

export const PATCH = handler(async (req, ctx) => {
  const { p, m, inbox } = await load(req, (await ctx.params).id);
  const b = await body<{ body?: string; link_preview?: unknown; file_previews?: unknown }>(req);
  const text = String(b.body ?? "").trim();
  if ((!text && !(m.attachments ?? []).length) || text.length > 2000) throw new ApiError(400, "Messages need 1-2000 characters");
  if (text !== m.body) await guardPost(p, "an edited message", text);
  const { changes, lookUp } = editChanges(m, text, b);
  if (!Object.keys(changes).length) return { ok: true };
  await db().from("messages").update(changes).eq("id", m.id);
  const tell = async () => notify([inbox, p.inbox].filter(Boolean) as string[], "dm_update", { from: p.uuid, with: m.recipient, id: m.id, edited: true });
  await tell();
  if (lookUp) previewLater("messages", m.id, text, tell);
  return { ok: true };
});

export const DELETE = handler(async (req, ctx) => {
  const { p, m, inbox } = await load(req, (await ctx.params).id);
  await db().from("messages").delete().eq("id", m.id);
  await db().from("message_reactions").delete().eq("scope", "d").eq("message_id", m.id);
  if (inbox) await notify([inbox], "dm_update", { from: p.uuid, id: m.id, deleted: true });
  return { ok: true };
});
