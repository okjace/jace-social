// GET: your group chats (members, unread count, last message time)
// POST {name?, members: [uuid]}: start a group chat with friends (up to 10 people including you)
import { checkName } from "@/lib/automod";
import { assertCanPost } from "@/lib/moderation";
import { ApiError, areFriends, body, cleanUuid, db, handler, me } from "@/lib/server";
import { MAX_GROUP, cleanName, notifyChanged, postMessage, profilesById, unreadCounts, type Channel } from "@/lib/chat";

export const GET = handler(async (req) => {
  const p = await me(req);
  const { data: mine } = await db().from("channel_members").select("channel_id").eq("uuid", p.uuid);
  const ids = (mine ?? []).map((m) => m.channel_id);
  if (!ids.length) return { groups: [] };
  const [{ data: chans }, { data: members }] = await Promise.all([
    db().from("channels").select("*").in("id", ids).is("server_id", null),
    db().from("channel_members").select("channel_id, uuid").in("channel_id", ids),
  ]);
  const people = await profilesById([...new Set((members ?? []).map((m) => m.uuid))]);
  const unread = await unreadCounts(p.uuid, ids);
  const latest: Record<string, string> = {};
  await Promise.all(ids.map(async (id) => {
    const { data } = await db().from("channel_messages").select("created_at").eq("channel_id", id)
      .order("id", { ascending: false }).limit(1).maybeSingle();
    latest[id] = data?.created_at ?? "";
  }));
  const groups = (chans ?? []).map((c: Channel) => ({
    id: c.id, name: c.name, icon_url: c.icon_url, owner: c.owner, created_at: c.created_at,
    members: (members ?? []).filter((m) => m.channel_id === c.id).map((m) => people[m.uuid]).filter(Boolean),
    unread: unread[c.id] ?? 0, last_message_at: latest[c.id] || c.created_at,
  }));
  groups.sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
  return { groups };
});

export const POST = handler(async (req) => {
  const p = await me(req);
  const b = await body<{ name?: string; members?: string[] }>(req);
  const others = [...new Set((b.members ?? []).map(cleanUuid))].filter((u) => u !== p.uuid);
  if (!others.length) throw new ApiError(400, "Pick at least one friend");
  if (others.length + 1 > MAX_GROUP) throw new ApiError(400, `Group chats can have up to ${MAX_GROUP} people`);
  for (const u of others) if (!(await areFriends(p.uuid, u))) throw new ApiError(403, "You can only add friends to a group chat");
  const people = await profilesById(others);
  assertCanPost(p);
  if (b.name?.trim()) await checkName(p, "a group chat's name", b.name);
  const name = b.name?.trim() ? cleanName(b.name, "Group name")
    : [p.display_name || p.name, ...others.map((u) => people[u]?.name ?? "?")].join(", ").slice(0, 48);
  const { data: ch, error } = await db().from("channels").insert({ name, owner: p.uuid }).select("*").single();
  if (error) throw error;
  const all = [p.uuid, ...others];
  const { error: mErr } = await db().from("channel_members").insert(all.map((uuid) => ({ channel_id: ch.id, uuid })));
  if (mErr) throw mErr;
  await postMessage(ch as Channel, all, null, `${p.display_name || p.name} started the group`, "system");
  await notifyChanged(others, "groups", { kind: "added", id: ch.id, name });
  return { group: { id: ch.id, name, owner: p.uuid } };
});
