// GET: the player's Jace Social friends, for inviting them from a Jace Games room (lib/gamesIntegration.ts).
//   -> {linked, friends: [{uuid, name, handle, picture, status, activity, jace_sub, jace_username}]}
//   Online friends first, then by name; no bots. jace_sub says who can sign in to Jace Games.
import { friendsOf, JACE_BOT, publicProfile } from "@/lib/server";
import { activityLine, gamesHandler } from "@/lib/gamesIntegration";

export const GET = gamesHandler(async (_req, who) => {
  if (!who.profile) return { linked: false, friends: [] };
  const friends = (await friendsOf(who.profile.uuid))
    .filter((f) => !f.is_bot && f.uuid !== JACE_BOT && !f.deleted_at)
    .map((f) => {
      const pub = publicProfile(f);                // invisible people look offline, with no activity
      return {
        uuid: f.uuid, name: pub.name, handle: pub.handle, picture: pub.avatar_url,
        status: pub.status as "online" | "idle" | "dnd" | "offline", activity: pub.online ? activityLine(pub.activity) : null,
        jace_sub: f.jace_sub ?? null, jace_username: f.jace_name ?? null,
      };
    })
    .sort((a, b) => Number(a.status === "offline") - Number(b.status === "offline") || a.name.localeCompare(b.name));
  return { linked: true, friends };
});
