// GET: servers you're in (with unread counts)
// POST {name}: create a server (you're the owner; it starts with #general)
import { checkName } from "@/lib/automod";
import { assertCanPost } from "@/lib/moderation";
import { ApiError, body, db, handler, me } from "@/lib/server";
import { MAX_SERVERS, cleanName, inviteCode, postMessage, unreadCounts, type Channel } from "@/lib/chat";
import { createDefaultRole } from "@/lib/perms";

export const GET = handler(async (req) => {
  const p = await me(req);
  const { data: mine } = await db().from("server_members").select("role, joined_at, servers(*)").eq("uuid", p.uuid)
    .order("joined_at");
  const ids = (mine ?? []).map((m) => (m.servers as unknown as { id: string }).id);
  const { data: chans } = ids.length ? await db().from("channels").select("id, server_id").in("server_id", ids) : { data: [] };
  const unread = await unreadCounts(p.uuid, (chans ?? []).map((c) => c.id));
  return {
    servers: (mine ?? []).map((m) => {
      const s = m.servers as unknown as { id: string; name: string; icon_url: string | null; owner: string };
      const total = (chans ?? []).filter((c) => c.server_id === s.id).reduce((n, c) => n + (unread[c.id] ?? 0), 0);
      return { id: s.id, name: s.name, icon_url: s.icon_url, role: m.role, unread: total };
    }),
  };
});

export const POST = handler(async (req) => {
  const p = await me(req);
  const name = cleanName((await body<{ name?: string }>(req)).name, "Server name");
  assertCanPost(p);
  await checkName(p, "a server's name", name);
  const { count } = await db().from("server_members").select("uuid", { count: "exact", head: true }).eq("uuid", p.uuid);
  if ((count ?? 0) >= MAX_SERVERS) throw new ApiError(400, `You can be in up to ${MAX_SERVERS} servers`);
  const { data: s, error } = await db().from("servers").insert({ name, owner: p.uuid, invite_code: inviteCode() }).select("*").single();
  if (error) throw error;
  await db().from("server_members").insert({ server_id: s.id, uuid: p.uuid, role: "owner", onboarded: true });
  await createDefaultRole(s.id);
  const { data: cat } = await db().from("channels").insert({ server_id: s.id, name: "Text channels", kind: "category", position: 0 }).select("id").single();
  const { data: ch } = await db().from("channels").insert({ server_id: s.id, name: "general", position: 1, parent_id: cat?.id ?? null }).select("*").single();
  const { data: vcat } = await db().from("channels").insert({ server_id: s.id, name: "Voice channels", kind: "category", position: 2 }).select("id").single();
  await db().from("channels").insert({ server_id: s.id, name: "General", kind: "voice", position: 3, parent_id: vcat?.id ?? null });
  await db().from("servers").update({ system_channel: ch.id }).eq("id", s.id);
  await postMessage(ch as Channel, [p.uuid], null, `Welcome to ${name}! Invite friends with the link jace-social.vercel.app/${s.invite_code}`, "system");
  return { server: s };
});
