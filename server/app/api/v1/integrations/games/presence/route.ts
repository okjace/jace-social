// POST {activity: "Playing Connect Four on Jace Games" | null}: what the player is doing in Jace Games,
// shown to their friends. Never replaces Minecraft rich presence reported in the last 2 minutes.
import { db, friendsOf, isOnline, notify, type Activity } from "@/lib/server";
import { GAMES_APP, GamesError, gamesHandler, isGamesActivity, linked } from "@/lib/gamesIntegration";

const MINECRAFT_FRESH_MS = 2 * 60_000;

export const POST = gamesHandler(async (req, who) => {
  const p = linked(who);
  const b = await req.json().catch(() => null) as { activity?: unknown } | null;
  if (!b || typeof b !== "object" || !("activity" in b)) throw new GamesError(400, "invalid_request", "activity is required (a string or null)");
  let text: string | null = null;
  if (b.activity !== null) {
    if (typeof b.activity !== "string") throw new GamesError(400, "invalid_request", "activity must be a string or null");
    text = b.activity.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (text.length > 80) throw new GamesError(400, "invalid_request", "activity can be up to 80 characters");
    if (!text) text = null;
  }

  const cur = p.activity;
  // the launcher or the game itself (Minecraft) reported recently: that stays
  const minecraft = cur && cur.type !== "app" && !!p.last_seen && Date.now() - Date.parse(p.last_seen) < MINECRAFT_FRESH_MS;
  if (minecraft) return { ok: true };

  const now = new Date().toISOString();
  let activity: Activity | null;
  let last_seen = p.last_seen;
  if (text) {
    const same = isGamesActivity(cur) && cur!.details === text && cur!.started_at;
    activity = { type: "app", app: GAMES_APP, details: text, started_at: same ? cur!.started_at : now, reported_at: now };
    last_seen = now;                               // playing in Jace Games keeps them online
  } else {
    if (!isGamesActivity(cur)) return { ok: true };   // nothing of ours to clear
    activity = null;
  }
  const wasOnline = isOnline(p);
  await db().from("profiles").update({ activity, last_seen }).eq("uuid", p.uuid);
  // tell friends only when something visible changed
  if (wasOnline !== isOnline({ last_seen }) || cur?.details !== activity?.details || isGamesActivity(cur) !== isGamesActivity(activity)) {
    const friends = await friendsOf(p.uuid);
    await notify(friends.map((f) => f.inbox), "presence", { uuid: p.uuid });
  }
  return { ok: true };
});
