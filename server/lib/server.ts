// Shared server helpers: database client, auth, live notifications, responses.
import { createHash, randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const ONLINE_WINDOW_MS = 3 * 60 * 1000;   // heartbeat every 2 min, offline after 3
const SESSION_DAYS = 30;

/** Project URL, tolerating a pasted ".../rest/v1/" or trailing slash. */
export function supabaseUrl(): string | undefined {
  return process.env.SUPABASE_URL?.trim().replace(/\/(rest|realtime|auth)\/v1.*$/, "").replace(/\/+$/, "");
}

let _db: SupabaseClient | null = null;
export function db(): SupabaseClient {
  if (!_db) {
    const url = supabaseUrl();
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new ApiError(500, "Server is missing SUPABASE_URL / SUPABASE_SECRET_KEY");
    _db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return _db;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type Profile = {
  uuid: string; name: string; inbox: string;
  activity: Activity | null; last_seen: string | null; signed_up: string | null;
  jace_sub?: string | null; jace_name?: string | null; mc_linked?: boolean;
  display_name?: string | null; avatar_url?: string | null; bio?: string | null; pronouns?: string | null;
  accent_color?: string | null; links?: { label: string; url: string }[];
  status?: Status; custom_status?: string | null; status_emoji?: string | null;
  is_bot?: boolean; bot_owner?: string | null; bot_public?: boolean; bot_commands?: unknown[]; bot_program?: unknown; bot_code?: string | null;
  bot_enabled?: boolean; banner_url?: string | null; settings?: Record<string, unknown>; onboarded_at?: string | null;
  handle?: string | null; handle_changed_at?: string | null;
  banned_at?: string | null; ban_reason?: string | null; jace_welcome?: string | null;
  deleted_at?: string | null;                     // set aside for 10 days (lib/accountDeletion.ts)
};

/** The official Jace bot's player id (lib/bots.ts, lib/jaceBot.ts). */
export const JACE_BOT = "00000000000000000000000000000ace";
const BANNED = "This account is banned from Jace Social";
export type Status = "online" | "idle" | "dnd" | "invisible";
/**
 * Rich presence. type says where they are; the rest is optional detail:
 * details/state are two free text lines (e.g. "Survival world", "Building a castle"),
 * started_at shows "for 12 minutes", app is what sent it (launcher / minecraft / jace-social).
 */
export type Activity = {
  type: "launcher" | "playing" | "hosting" | "app";
  instance?: string; version?: string; server?: string; world?: string; address?: string;
  loader?: string; modpack?: string; details?: string; state?: string; started_at?: string; app?: string;
};

/** Where this site lives (for OAuth redirects and links). */
export const siteUrl = () => (process.env.PUBLIC_URL || "https://jace-social.vercel.app").replace(/\/+$/, "");

export const token = () => randomBytes(32).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export type Ctx = { params: Promise<Record<string, string>> };

/** Wrap a route handler: JSON errors, CORS for the web app and other sites. */
export function handler(fn: (req: Request, ctx: Ctx) => Promise<unknown>) {
  return async (req: Request, ctx: Ctx) => {
    try {
      const out = await fn(req, ctx);
      if (out instanceof Response) return out;
      return Response.json(out, { headers: { "Access-Control-Allow-Origin": "*" } });
    } catch (e) {
      if (e instanceof ApiError) return Response.json({ error: e.message }, { status: e.status });
      console.error(e);
      // Database errors: share only the error code (e.g. 42501 = no permission,
      // 42P01 = table missing) so setup problems can be diagnosed safely.
      const code = (e as { code?: string })?.code;
      return Response.json({ error: code ? `Database error (${code})` : "Server error" }, { status: 500 });
    }
  };
}

export async function body<T>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { throw new ApiError(400, "Expected a JSON body"); }
}

/** The signed-in player for this request (Authorization: Bearer <token>). */
export async function me(req: Request): Promise<Profile> {
  const auth = req.headers.get("authorization") ?? "";
  const t = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!t) throw new ApiError(401, "Not signed in");
  const { data } = await db().from("sessions").select("uuid, expires_at, profiles(*)")
    .eq("token_hash", sha256(t)).maybeSingle();
  if (!data || new Date(data.expires_at) < new Date()) throw new ApiError(401, "Session expired - sign in again");
  const p = data.profiles as unknown as Profile;
  if (p.banned_at) throw new ApiError(403, BANNED);        // banned by the Jace bot (lib/jaceBot.ts)
  return p;
}

export async function createSession(uuid: string) {
  const { data: who } = await db().from("profiles").select("banned_at").eq("uuid", uuid).maybeSingle();
  if (who?.banned_at) throw new ApiError(403, BANNED);
  const t = token();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  const { error } = await db().from("sessions").insert({ token_hash: sha256(t), uuid, expires_at: expires });
  if (error) throw error;
  return { token: t, expires_at: expires };
}

/** Find or create a profile row (players can be added as friends before they sign up). */
export async function ensureProfile(uuid: string, name: string, signingUp = false): Promise<Profile> {
  const { data: existing } = await db().from("profiles").select("*").eq("uuid", uuid).maybeSingle();
  if (existing) {
    const patch: Partial<Profile> = {};
    if (existing.name !== name) patch.name = name;
    if (signingUp && !existing.signed_up) patch.signed_up = new Date().toISOString();
    if (Object.keys(patch).length) await db().from("profiles").update(patch).eq("uuid", uuid);
    return { ...existing, ...patch } as Profile;
  }
  const row = { uuid, name, inbox: token(), signed_up: signingUp ? new Date().toISOString() : null };
  const { data, error } = await db().from("profiles").insert(row).select("*").single();
  if (error) throw error;
  return data as Profile;
}

/** Look up a Minecraft player by username (Mojang). */
export async function mojangLookup(name: string): Promise<{ uuid: string; name: string }> {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new ApiError(400, "That isn't a valid Minecraft username");
  const r = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
  if (r.status === 404 || r.status === 204) throw new ApiError(404, `No Minecraft player called "${name}"`);
  if (!r.ok) throw new ApiError(502, "Couldn't reach Mojang - try again");
  const d = await r.json();
  return { uuid: d.id, name: d.name };
}

/**
 * Live notification to players' private channels (Supabase Realtime broadcast).
 * Payloads only say *what changed* - never message text - so a leaked channel
 * name reveals nothing private; clients fetch details through the API.
 */
export async function notify(inboxes: string[], event: string, payload: Record<string, unknown>) {
  const url = supabaseUrl();
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key || !inboxes.length) return;
  try {
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: inboxes.map((topic) => ({ topic, event, payload, private: false })) }),
    });
  } catch (e) {
    console.error("realtime notify failed", e);   // notifications are best-effort
  }
}

export function isOnline(p: Pick<Profile, "last_seen">) {
  return !!p.last_seen && Date.now() - new Date(p.last_seen).getTime() < ONLINE_WINDOW_MS;
}

/** Minecraft head for players without their own picture. */
export function avatarFor(p: Pick<Profile, "uuid" | "avatar_url" | "mc_linked">) {
  if (p.avatar_url) return p.avatar_url;
  return p.mc_linked !== false ? `https://mc-heads.net/avatar/${p.uuid}/128` : null;
}

/**
 * Public view of a player (what friends see). "Invisible" players look offline,
 * and their last-seen time is hidden.
 */
export function publicProfile(p: Profile) {
  if (p.deleted_at) return deletedProfile(p.uuid);
  const invisible = p.status === "invisible";
  const online = isOnline(p) && !invisible;
  return {
    uuid: p.uuid, name: p.display_name || p.name, online, uses_jace: !!p.signed_up,
    activity: online ? p.activity : null, last_seen: invisible ? null : p.last_seen,
    status: online ? (p.status ?? "online") : "offline",
    custom_status: p.custom_status ?? null, status_emoji: p.status_emoji ?? null,
    minecraft_name: p.mc_linked !== false ? p.name : null,
    jace_name: p.jace_name ?? null,
    handle: p.handle ?? null,
    avatar_url: avatarFor(p),
    bio: p.bio ?? null, pronouns: p.pronouns ?? null, accent_color: p.accent_color ?? null, links: p.links ?? [],
    banner_url: p.banner_url ?? null, is_bot: !!p.is_bot, bot_owner: p.is_bot ? p.bot_owner ?? null : null,
    official: p.uuid === JACE_BOT, banned: !!p.banned_at,
  };
}

/** How a deleted account looks to everyone else (its messages stay until it's gone for good). */
function deletedProfile(uuid: string) {
  return {
    uuid, name: "Deleted account", online: false, uses_jace: false, activity: null, last_seen: null, status: "offline",
    custom_status: null, status_emoji: null, minecraft_name: null, jace_name: null, handle: null, avatar_url: null, bio: null,
    pronouns: null, accent_color: null, links: [], banner_url: null, is_bot: false, bot_owner: null, official: false, banned: false,
    deleted: true,
  };
}

// --- handles: each account's unique @name, chosen by its owner (supabase/006_handles.sql)
export const HANDLE_RE = /^[a-z0-9_](?:[a-z0-9_.]{1,18}[a-z0-9_])$/;
export const JACE_BOT_HANDLE = "jacebot";                    // the official Jace bot's (lib/bots.ts)
const RESERVED = new Set(["everyone", "here", "jace", "jacesocial", JACE_BOT_HANDLE, "jace_bot", "jace.bot", "admin", "administrator", "moderator", "mod", "support",
  "system", "staff", "official", "help", "null", "undefined"]);
export const HANDLE_COOLDOWN_DAYS = 7;

/** "@Steve.Builds " -> "steve.builds", or a message saying what's wrong with it. */
export function checkHandle(raw: unknown): string {
  const h = String(raw ?? "").trim().replace(/^@/, "").toLowerCase();
  if (h.length < 3 || h.length > 20) throw new ApiError(400, "Handles are 3 to 20 characters");
  if (!HANDLE_RE.test(h)) throw new ApiError(400, "Handles can use letters, numbers, _ and . (not at the start or end)");
  if (h.includes("..")) throw new ApiError(400, "Handles can't have two dots in a row");
  if (RESERVED.has(h)) throw new ApiError(400, `@${h} is reserved`);
  return h;
}

/** The account with this @handle, or null. */
export async function profileByHandle(raw: string): Promise<Profile | null> {
  const h = raw.trim().replace(/^@/, "").toLowerCase();
  if (!HANDLE_RE.test(h)) return null;
  const { data, error } = await db().from("profiles").select("*").eq("handle", h).limit(1).maybeSingle();
  if (error) return null;                          // before 006_handles.sql: no handles yet
  return data?.deleted_at ? null : data as Profile | null;
}

/** A new random player id for Jace-only accounts (same shape as a Minecraft UUID). */
export const newPlayerId = () => randomBytes(16).toString("hex");

/** Accepted friends of a player, as profile rows. */
export async function friendsOf(uuid: string): Promise<Profile[]> {
  const { data, error } = await db().from("friendships")
    .select("requester, addressee, a:profiles!friendships_requester_fkey(*), b:profiles!friendships_addressee_fkey(*)")
    .eq("status", "accepted").or(`requester.eq.${uuid},addressee.eq.${uuid}`);
  if (error) throw error;
  return (data ?? []).map((r) => (r.requester === uuid ? r.b : r.a) as unknown as Profile).filter((f) => !f.deleted_at);
}

export async function areFriends(a: string, b: string): Promise<boolean> {
  const { data } = await db().from("friendships")
    .select("status, a:profiles!friendships_requester_fkey(*), b:profiles!friendships_addressee_fkey(*)")   // (*): works before 010 too
    .or(`and(requester.eq.${a},addressee.eq.${b}),and(requester.eq.${b},addressee.eq.${a})`).maybeSingle();
  const gone = (x: unknown) => !!(x as { deleted_at?: string | null } | null)?.deleted_at;
  return data?.status === "accepted" && !gone(data.a) && !gone(data.b);     // not with a deleted account
}

/** Inboxes (live-notification channels) of these players. */
export async function inboxesOf(uuids: string[]): Promise<string[]> {
  if (!uuids.length) return [];
  const { data } = await db().from("profiles").select("inbox").in("uuid", uuids);
  return (data ?? []).map((r) => r.inbox);
}

export function cleanUuid(u: unknown): string {
  const s = String(u ?? "").replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(s)) throw new ApiError(400, "Bad player id");
  return s;
}

/** Merge one player into another (account linking). Roles, reactions and bots move first
 *  (004_community.sql), then everything else (003_social.sql), which deletes src. */
export async function mergeProfiles(src: string, dst: string) {
  const jace = await db().rpc("merge_jace_sync", { src, dst });                                 // 007_jace_messages.sql
  if (jace.error && !/merge_jace_sync/.test(jace.error.message)) throw jace.error;
  const extra = await db().rpc("merge_profiles_extra", { src, dst });
  if (extra.error && !/merge_profiles_extra/.test(extra.error.message)) throw extra.error;   // 004 not run yet: skip
  const { error } = await db().rpc("merge_profiles", { src, dst });
  if (error) throw error;
}

/** A bot's API token: a session that doesn't expire until it's regenerated (kind "bot"). */
export async function createBotToken(uuid: string) {
  const t = "bot." + token();
  const { error } = await db().from("sessions").insert({ token_hash: sha256(t), uuid, kind: "bot", expires_at: "2999-01-01T00:00:00Z" });
  if (error) throw error;
  return t;
}
