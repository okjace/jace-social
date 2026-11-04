// POST {name, kind?: text|voice|announcement|category|forum|media|stage, parent_id?, topic?, private?, available_tags?}: add a channel
//      (manage channels). private: only you and people with roles you add later can see it.
// PUT {order: [{id, parent_id}]}: reorder channels and move them between categories
import { ApiError, body, db, handler, me } from "@/lib/server";
import { channelName, cleanId, cleanName, notifyChanged } from "@/lib/chat";
import { need, P, serverCtx } from "@/lib/perms";
import { cleanTags } from "@/lib/forums";

const KINDS = ["text", "voice", "announcement", "category", "forum", "media", "stage"];

export const POST = handler(async (req, ctx) => {
  const p = await me(req);
  const id = cleanId((await ctx.params).id);
  const sc = await serverCtx(id, p.uuid);
  need(sc.base, P.MANAGE_CHANNELS);
  const b = await body<{ name?: string; topic?: string; kind?: string; parent_id?: string | null; private?: boolean; available_tags?: unknown }>(req);
  const kind = KINDS.includes(String(b.kind)) ? String(b.kind) : "text";
  const { count } = await db().from("channels").select("id", { count: "exact", head: true }).eq("server_id", id).neq("kind", "post");
  if ((count ?? 0) >= 100) throw new ApiError(400, "A server can have up to 100 channels");
  let parent: string | null = null;
  if (b.parent_id && kind !== "category") {
    const { data: c } = await db().from("channels").select("id, kind").eq("id", cleanId(b.parent_id)).eq("server_id", id).maybeSingle();
    if (!c || c.kind !== "category") throw new ApiError(400, "Pick a category in this server");
    parent = c.id;
  }
  const topic = (b.topic ?? "").trim().slice(0, 200) || null;
  // categories keep their capitals (like Discord shows them); other channels are lowercase-with-dashes
  const name = ["category", "voice", "stage"].includes(kind) ? cleanName(b.name, "Name") : channelName(b.name);
  const available_tags = (kind === "forum" || kind === "media") && b.available_tags !== undefined ? cleanTags(b.available_tags) : [];
  const { data, error } = await db().from("channels")
    .insert({ server_id: id, name, topic, kind, parent_id: parent, position: count ?? 0, available_tags }).select("*").single();
  if (error) throw error;
  if (b.private) {
    const everyone = sc.roles.find((r) => r.is_default);
    if (everyone) await db().from("channel_overrides").insert({ channel_id: data.id, target_type: "role", target_id: everyone.id, allow: 0, deny: P.VIEW });
    await db().from("channel_overrides").insert({ channel_id: data.id, target_type: "member", target_id: p.uuid, allow: P.VIEW, deny: 0 });
  }
  const { data: members } = await db().from("server_members").select("uuid").eq("server_id", id);
  await notifyChanged((members ?? []).map((m) => m.uuid), "servers", { kind: "changed", server_id: id });
  return { channel: data };
});

export const PUT = handler(async (req, ctx) => {
  const p = await me(req);
  const id = cleanId((await ctx.params).id);
  need((await serverCtx(id, p.uuid)).base, P.MANAGE_CHANNELS);
  const order = (await body<{ order?: { id: string; parent_id?: string | null }[] }>(req)).order ?? [];
  const { data: chans } = await db().from("channels").select("id, kind").eq("server_id", id);
  const known = new Map((chans ?? []).map((c) => [c.id, c.kind]));
  await Promise.all(order.map((o, i) => {
    const cid = cleanId(o.id);
    if (!known.has(cid)) throw new ApiError(400, "Unknown channel");
    const parent = o.parent_id && known.get(o.parent_id) === "category" && known.get(cid) !== "category" ? o.parent_id : null;
    return db().from("channels").update({ position: i, parent_id: parent }).eq("id", cid);
  }));
  const { data: members } = await db().from("server_members").select("uuid").eq("server_id", id);
  await notifyChanged((members ?? []).map((m) => m.uuid), "servers", { kind: "changed", server_id: id });
  return { ok: true };
});
