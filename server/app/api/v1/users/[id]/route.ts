// GET: someone's profile, whether you're friends, and servers you share
import { areFriends, cleanUuid, db, handler, me, publicProfile, ApiError, type Profile } from "@/lib/server";

export const GET = handler(async (req, ctx) => {
  const p = await me(req);
  const id = cleanUuid((await ctx.params).id);
  const { data } = await db().from("profiles").select("*").eq("uuid", id).maybeSingle();
  if (!data) throw new ApiError(404, "Player not found");
  const friend = id === p.uuid || (await areFriends(p.uuid, id));
  const pub = publicProfile(data as Profile);
  const { data: mine } = await db().from("server_members").select("server_id").eq("uuid", p.uuid);
  const { data: theirs } = await db().from("server_members").select("server_id, servers(id, name, icon_url)")
    .eq("uuid", id).in("server_id", (mine ?? []).map((m) => m.server_id));
  return {
    ...pub,
    // presence is for friends (and people you share a server with)
    ...(friend || theirs?.length ? {} : { online: false, activity: null, status: "offline", last_seen: null }),
    is_friend: friend && id !== p.uuid, is_you: id === p.uuid,
    // they let anyone message them (Settings -> Links & privacy), so you can without being friends
    can_message: id !== p.uuid && !pub.is_bot && (friend || (data as Profile).settings?.open_dms === true),
    mutual_servers: (theirs ?? []).map((t) => t.servers),
  };
});
