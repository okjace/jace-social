// POST {to, game, url, code}: invite a friend to a Jace Games room, as a direct message from the
// player (the same path as POST /api/v1/messages: stored, unread, live, synced to Jace). 10 a minute.
import { areFriends, db, JACE_BOT } from "@/lib/server";
import { sendDm } from "@/lib/dms";
import { GamesError, gamesHandler, isRoomUrl, linked } from "@/lib/gamesIntegration";

const INVITES_PER_MINUTE = 10;
const bad = (why: string) => new GamesError(400, "invalid_request", why);

export const POST = gamesHandler(async (req, who) => {
  const p = linked(who);
  const b = await req.json().catch(() => null) as { to?: unknown; game?: unknown; url?: unknown; code?: unknown } | null;
  if (!b || typeof b !== "object") throw bad("Expected a JSON body");
  const to = typeof b.to === "string" ? b.to.replace(/-/g, "").toLowerCase() : "";
  if (!/^[0-9a-f]{32}$/.test(to)) throw bad("to must be a friend's uuid");
  const game = typeof b.game === "string" ? b.game.trim() : "";
  if (game.length < 1 || game.length > 60 || /[\u0000-\u001f\u007f]/.test(game)) throw bad("game must be 1 to 60 characters");
  const url = typeof b.url === "string" ? b.url.trim() : "";
  if (!isRoomUrl(url)) throw bad("url must be a Jace Games room link (…/r/<code>)");
  if (typeof b.code !== "string" || !/^[A-Z0-9]{4,8}$/.test(b.code)) throw bad("code must be 4 to 8 capital letters or digits");

  if (to === p.uuid || to === JACE_BOT || !(await areFriends(p.uuid, to))) throw new GamesError(403, "not_friends");
  const { data: them } = await db().from("profiles").select("is_bot").eq("uuid", to).maybeSingle();
  if (!them || them.is_bot) throw new GamesError(403, "not_friends");

  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await db().from("messages").select("id", { count: "exact", head: true })
    .eq("sender", p.uuid).gt("created_at", minuteAgo).like("body", "🎮 Join me in % on Jace Games: %");
  if (error) throw error;
  if ((count ?? 0) >= INVITES_PER_MINUTE) throw new GamesError(429, "rate_limited");

  await sendDm(p, { to, body: `🎮 Join me in ${game} on Jace Games: ${url}` });   // (its own 20/min limit -> rate_limited too)
  return { ok: true };
});
