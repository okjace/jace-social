// GET ?q=name : find Jace Social players by @handle, display name, Jace or Minecraft username (10 max).
// Only people who let anyone find them (Settings -> Links & privacy), your friends, and the exact
// @handle you typed show up.
import { ApiError, db, friendsOf, handler, me, publicProfile, type Profile } from "@/lib/server";

export const GET = handler(async (req) => {
  const p = await me(req);
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().replace(/^@/, "");
  if (q.length < 2) throw new ApiError(400, "Type at least 2 characters");
  const like = `${q.replace(/[%\\,()*]/g, "")}%`;   // (keep _: handles have it; it only matches itself or one letter)
  const search = (withHandle: boolean) => db().from("profiles").select("*").not("signed_up", "is", null)
    .or(`${withHandle ? `handle.ilike.${like},` : ""}name.ilike.${like},jace_name.ilike.${like},display_name.ilike.${like}`).limit(40);
  let { data, error } = await search(true);
  if (error) ({ data, error } = await search(false));      // before supabase/006_handles.sql
  if (error) throw error;
  const friends = new Set((await friendsOf(p.uuid)).map((f) => f.uuid));
  const exact = q.toLowerCase();
  const found = (data as Profile[] ?? []).filter((x) => !x.deleted_at && x.uuid !== p.uuid && (
    friends.has(x.uuid) || (x.settings as { open_dms?: boolean } | undefined)?.open_dms === true
    || x.handle?.toLowerCase() === exact || (x.is_bot && x.bot_public)));
  return { users: found.slice(0, 10).map((x) => ({ ...publicProfile(x), is_friend: friends.has(x.uuid) })) };
});
