// Server-to-server API for Jace Games (jace-games.vercel.app): its server lists a player's
// friends here, invites them to game rooms and shows what they're playing
// (app/api/v1/integrations/games/*). Every call carries two things:
//   X-Jace-App-Key   the key Jace Games and this server share (JACE_GAMES_APP_KEY)
//   Authorization    "Bearer <the player's Jace access token>" from Sign in with Jace, which this
//                    server checks with Jace (userinfo, cached a minute) and maps to the profile
//                    with that jace_sub
// Errors are {"error": code, "error_description"?} with fixed codes, since Jace Games reads them.
import { createHash, timingSafeEqual } from "node:crypto";
import { JACE } from "./jace";
import { ApiError, db, sha256, type Activity, type Profile } from "./server";

/** An error Jace Games can act on: {error: code, error_description?}. */
export class GamesError extends Error {
  constructor(public status: number, public code: string, public description?: string) { super(code); }
}

/** The JSON for an error: ours as is, the shared helpers' (lib/server.ts, lib/dms.ts) as fixed codes. */
function errorResponse(e: unknown): Response {
  if (e instanceof GamesError)
    return Response.json({ error: e.code, ...(e.description ? { error_description: e.description } : {}) }, { status: e.status });
  if (e instanceof ApiError) {
    const code = e.status === 429 ? "rate_limited" : e.status === 400 ? "invalid_request" : e.status === 403 ? "forbidden" : "server_error";
    return Response.json({ error: code, ...(code === "invalid_request" || code === "forbidden" ? { error_description: e.message } : {}) },
      { status: e.status >= 500 ? 500 : e.status });
  }
  console.error(e);
  return Response.json({ error: "server_error" }, { status: 500 });
}

export type Player = { profile: Profile | null; sub: string };

/** Wrap a Jace Games route: checks the app key and the player's Jace token first. */
export function gamesHandler(fn: (req: Request, who: Player) => Promise<unknown>) {
  return async (req: Request) => {
    try {
      checkAppKey(req);
      const out = await fn(req, await player(req));
      return Response.json(out, { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

/** The player's profile, or 404 not_linked when they've never used Jace Social. */
export function linked(who: Player): Profile {
  if (!who.profile) throw new GamesError(404, "not_linked");
  return who.profile;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

function checkAppKey(req: Request) {
  const key = process.env.JACE_GAMES_APP_KEY?.trim();
  if (!key) throw new GamesError(503, "not_configured");
  const given = req.headers.get("x-jace-app-key") ?? "";
  // hashes first, so both sides are the same length and the comparison takes the same time
  if (!given || !timingSafeEqual(digest(given), digest(key))) throw new GamesError(401, "invalid_app_key");
}

// Jace's answer for each token (by hash), for a minute: Jace Games calls several times a minute
type Who = { sub: string; banned: boolean } | "invalid";
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; who: Who }>();

async function jaceUserinfo(accessToken: string): Promise<Who> {
  const key = sha256(accessToken);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.who;
  let r: Response;
  try {
    r = await fetch(`${JACE}/api/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GamesError(502, "jace_unavailable", "Couldn't reach Jace");
  }
  let who: Who;
  if (r.status === 401) who = "invalid";
  else if (!r.ok) throw new GamesError(502, "jace_unavailable", `Jace answered ${r.status}`);    // not cached
  else {
    const d = await r.json().catch(() => ({})) as { sub?: unknown; id?: unknown; banned?: unknown };
    const sub = String(d.sub ?? d.id ?? "");
    if (!sub) throw new GamesError(502, "jace_unavailable", "Jace didn't say who this is");
    who = { sub, banned: d.banned === true };
  }
  if (cache.size >= 5000) {
    for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_MS) cache.delete(k);
    if (cache.size >= 5000) cache.clear();
  }
  cache.set(key, { at: Date.now(), who });
  return who;
}

async function player(req: Request): Promise<Player> {
  const auth = req.headers.get("authorization") ?? "";
  const t = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!t) throw new GamesError(401, "invalid_token");
  const who = await jaceUserinfo(t);
  if (who === "invalid") throw new GamesError(401, "invalid_token");
  if (who.banned) throw new GamesError(403, "account_banned");
  const { data, error } = await db().from("profiles").select("*").eq("jace_sub", who.sub).limit(1).maybeSingle();
  if (error) throw error;
  const profile = data as Profile | null;
  if (profile && (profile.banned_at || profile.deleted_at)) throw new GamesError(403, "account_banned");
  return { profile, sub: who.sub };
}

/** Where game rooms live: JACE_GAMES_URL (or jace-games.vercel.app), and localhost while developing. */
export function isRoomUrl(url: string): boolean {
  if (url.length > 300 || /\s/.test(url)) return false;
  const base = (process.env.JACE_GAMES_URL?.trim() || "https://jace-games.vercel.app").replace(/\/+$/, "");
  if (url.startsWith(`${base}/r/`)) return true;
  return process.env.NODE_ENV !== "production" && /^http:\/\/localhost:\d{1,5}\/r\//.test(url);
}

// --- presence: what Jace Games says someone is playing is an "app" activity with app "jace-games"
export const GAMES_APP = "jace-games";
/** Jace Games reports every couple of minutes; after this its activity is stale. */
export const GAMES_FRESH_MS = 3 * 60_000;

export const isGamesActivity = (a: Activity | null | undefined) => a?.type === "app" && a.app === GAMES_APP;
export const freshGamesActivity = (a: Activity | null | undefined) =>
  isGamesActivity(a) && !!a!.reported_at && Date.now() - Date.parse(a!.reported_at) < GAMES_FRESH_MS;

/** A friend's activity as one line for Jace Games (null when there's nothing to show). */
export function activityLine(a: Activity | null | undefined): string | null {
  if (!a) return null;
  if (isGamesActivity(a)) return a.details ?? null;
  if (a.type === "hosting") return `Hosting ${a.world ? `"${a.world}"` : "a world"} in Minecraft`;
  if (a.type === "playing") return `Playing Minecraft${a.version ? " " + a.version : ""}${a.server ? " on " + a.server : ""}`;
  if (a.type === "launcher") return "In Jace Launcher";
  return null;                                     // just using the Jace Social app
}
