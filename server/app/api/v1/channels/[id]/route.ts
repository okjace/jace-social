// PATCH {name?, topic?, position?, parent_id?, slowmode?, user_limit?, available_tags? (forums)}: edit a server
//   channel (manage channels). A forum post: {title?, tags?} (its author or moderators), {locked?, pinned?} (moderators)
// DELETE: delete a server channel (manage channels; a server keeps at least one text channel), or a forum post
//   (its author, or moderators)
import { ApiError, body, db, handler, me } from "@/lib/server";
import { channelFor, channelName, cleanId, cleanName, notifyChanged } from "@/lib/chat";
import { has, need, P } from "@/lib/perms";
import { cleanTags, updatePost } from "@/lib/forums";

export const PATCH = handler(async (req, ctx) => {
  const p = await me(req);
  const { channel, ctx: sc, perms, members: viewers } = await channelFor((await ctx.params).id, p.uuid);
  if (!channel.server_id || !sc) throw new ApiError(400, "Rename group chats with /groups/{id}");
  if (channel.kind === "post") {
    const r = await updatePost(channel, perms, p, await body(req));
    await notifyChanged(viewers, "channel", { channel_id: channel.parent_id, server_id: channel.server_id, post_id: channel.id, edited: true });
    return r;
  }
  need(perms, P.MANAGE_CHANNELS);
  const b = await body<{ name?: string; topic?: string | null; position?: number; parent_id?: string | null; slowmode?: number; user_limit?: number;
    available_tags?: unknown }>(req);
  const patch: Record<string, unknown> = {};
  if (b.available_tags !== undefined) {
    if (channel.kind !== "forum" && channel.kind !== "media") throw new ApiError(400, "Only forums have tags");
    patch.available_tags = cleanTags(b.available_tags);
  }
  if (b.name !== undefined) patch.name = ["category", "voice", "stage"].includes(channel.kind) ? cleanName(b.name, "Name") : channelName(b.name);
  if (b.topic !== undefined) {
    const t = (b.topic ?? "").trim();
    if (t.length > 200) throw new ApiError(400, "Topics can be up to 200 characters");
    patch.topic = t || null;
  }
  if (typeof b.position === "number") patch.position = Math.max(0, Math.min(1000, Math.round(b.position)));
  if (b.slowmode !== undefined) patch.slowmode = Math.max(0, Math.min(21600, Math.round(Number(b.slowmode) || 0)));
  if (b.user_limit !== undefined) patch.user_limit = Math.max(0, Math.min(25, Math.round(Number(b.user_limit) || 0)));
  if (b.parent_id !== undefined && channel.kind !== "category") {
    if (b.parent_id) {
      const { data: c } = await db().from("channels").select("id, kind").eq("id", cleanId(b.parent_id)).eq("server_id", channel.server_id).maybeSingle();
      if (!c || c.kind !== "category") throw new ApiError(400, "Pick a category in this server");
    }
    patch.parent_id = b.parent_id || null;
  }
  await db().from("channels").update(patch).eq("id", channel.id);
  const { data: members } = await db().from("server_members").select("uuid").eq("server_id", channel.server_id);
  await notifyChanged((members ?? []).map((m) => m.uuid), "servers", { kind: "changed", server_id: channel.server_id });
  return { ok: true };
});

export const DELETE = handler(async (req, ctx) => {
  const p = await me(req);
  const { channel, perms, members: viewers } = await channelFor((await ctx.params).id, p.uuid);
  if (!channel.server_id) throw new ApiError(400, "Leave group chats with /groups/{id}/members");
  if (channel.kind === "post") {                         // a forum post: its author or moderators
    if (channel.owner !== p.uuid && !has(perms, P.MANAGE_MESSAGES)) throw new ApiError(403, "Only its author or moderators can delete this post");
    await db().from("channels").delete().eq("id", channel.id);
    await notifyChanged(viewers, "channel", { channel_id: channel.parent_id, server_id: channel.server_id, post_id: channel.id, deleted: true });
    return { ok: true };
  }
  need(perms, P.MANAGE_CHANNELS);
  if (channel.kind === "text" || channel.kind === "announcement") {
    const { count } = await db().from("channels").select("id", { count: "exact", head: true })
      .eq("server_id", channel.server_id).in("kind", ["text", "announcement"]);
    if ((count ?? 0) <= 1) throw new ApiError(400, "A server needs at least one text channel");
  }
  // a category's channels stay, just without the category
  await db().from("channels").update({ parent_id: null }).eq("parent_id", channel.id);
  await db().from("channels").delete().eq("id", channel.id);
  const { data: members } = await db().from("server_members").select("uuid").eq("server_id", channel.server_id);
  await notifyChanged((members ?? []).map((m) => m.uuid), "servers", { kind: "changed", server_id: channel.server_id });
  return { ok: true };
});
