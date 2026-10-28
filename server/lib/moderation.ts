// Moderation of accounts on all of Jace Social (not one server - servers have their own bans and
// timeouts): bans and mutes, both for a while or for good (supabase/018_moderation.sql).
//   - banned: signed out everywhere and can't sign in (lib/server.ts me / createSession)
//   - muted: can read but not post - messages, edits, reactions, profile text and pictures,
//     names of new group chats and servers (assertCanPost)
// They come from Jace Social's staff (Reports, profiles, the Jace bot), from Jace's auto moderation
// (lib/automod.ts: auto-mute), or from the person's linked Jace account: Jace bans and mutes carry
// over, with their end times, and are lifted here when Jace lifts them (syncFromJace).
import { ApiError, db, notify, type Profile } from "./server";
import { jaceModeration } from "./jace";

const future = (t: string | null | undefined) => !t || new Date(t).getTime() > Date.now();

/** Banned right now (a ban that ran out doesn't count). */
export const isBanned = (p: Pick<Profile, "banned_at" | "ban_until">) => !!p.banned_at && future(p.ban_until);
/** Muted right now. */
export const isMuted = (p: Pick<Profile, "muted_at" | "mute_until">) => !!p.muted_at && future(p.mute_until);

/** "until Oct 30, 3:00 PM UTC" / "for good" */
function until(t: string | null | undefined) {
  if (!t) return "for good";
  return `until ${new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC`;
}

/** The one thing everything that posts asks first. Throws when they're muted. */
export function assertCanPost(p: Profile) {
  if (!isMuted(p)) return;
  throw new ApiError(403, `You're muted on Jace Social ${until(p.mute_until)}${p.mute_reason ? ` (${p.mute_reason})` : ""} - you can read, but not post`);
}

/** What the apps show you about your own account (GET /me). */
export function ownModeration(p: Profile) {
  return isMuted(p) ? { muted: true, mute_until: p.mute_until ?? null, mute_reason: p.mute_reason ?? null } : { muted: false };
}

/** Mute someone here, for `minutes` (null: for good). */
export async function mute(uuid: string, minutes: number | null, reason: string, from: "staff" | "jace" | "automod") {
  const at = new Date().toISOString();
  const end = minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
  const { data } = await db().from("profiles").update({ muted_at: at, mute_until: end, mute_reason: reason.slice(0, 400) || null, mute_from: from })
    .eq("uuid", uuid).select("inbox").maybeSingle();
  if (data?.inbox) await notify([data.inbox], "moderation", { muted: true, mute_until: end, mute_reason: reason });
}

export async function unmute(uuid: string) {
  const { data } = await db().from("profiles").update({ muted_at: null, mute_until: null, mute_reason: null, mute_from: null })
    .eq("uuid", uuid).select("inbox").maybeSingle();
  if (data?.inbox) await notify([data.inbox], "moderation", { muted: false });
}

/** Ban someone here, for `minutes` (null: for good): signed out everywhere. */
export async function banHere(uuid: string, minutes: number | null, reason: string | null, from: "staff" | "jace") {
  const end = minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
  await db().from("profiles").update({ banned_at: new Date().toISOString(), ban_until: end, ban_reason: reason, ban_from: from }).eq("uuid", uuid);
  await db().from("sessions").delete().eq("uuid", uuid);
  await db().from("voice_states").delete().eq("uuid", uuid).then(() => {}, () => {});
}

export async function unbanHere(uuid: string) {
  await db().from("profiles").update({ banned_at: null, ban_until: null, ban_reason: null, ban_from: null }).eq("uuid", uuid);
}

/** A ban or mute that has run out: cleared (so it doesn't come back as "banned" anywhere). */
export async function clearExpired(p: Profile): Promise<Profile> {
  const patch: Partial<Profile> = {};
  if (p.banned_at && !isBanned(p)) Object.assign(patch, { banned_at: null, ban_until: null, ban_reason: null, ban_from: null });
  if (p.muted_at && !isMuted(p)) Object.assign(patch, { muted_at: null, mute_until: null, mute_reason: null, mute_from: null });
  if (!Object.keys(patch).length) return p;
  await db().from("profiles").update(patch).eq("uuid", p.uuid);
  return { ...p, ...patch };
}

/**
 * A linked Jace account's ban and mute, here too: asked from Jace (at most every 5 minutes, unless
 * `now`), then applied - banned or muted on Jace: the same here, until the same time; lifted on
 * Jace: lifted here (only the ones that came from Jace - not Jace Social's own).
 * -> the profile as it is now
 */
export async function syncFromJace(p: Profile, now = false): Promise<Profile> {
  if (!p.jace_sub || p.is_bot) return p;
  const every = process.env.NODE_ENV === "production" ? 5 * 60_000 : 0;     // (local tests: every time)
  if (!now && p.jace_mod_checked_at && Date.now() - new Date(p.jace_mod_checked_at).getTime() < every) return p;
  await db().from("profiles").update({ jace_mod_checked_at: new Date().toISOString() }).eq("uuid", p.uuid).then(() => {}, () => {});
  const r = await jaceModeration("status", p.jace_sub);
  if (!r.ok) return p;                                  // (Jace down, or the account is gone there: leave it)
  const j = r.data;
  const minutesLeft = (t: string | null | undefined) => (t ? Math.max(1, (new Date(t).getTime() - Date.now()) / 60_000) : null);
  let out = { ...p };
  if (j.banned && (!p.banned_at || p.ban_from === "jace")) {
    if (!p.banned_at || (p.ban_until ?? null) !== (j.ban_until ?? null)) {
      await banHere(p.uuid, minutesLeft(j.ban_until), `Banned on Jace${j.ban_reason ? `: ${j.ban_reason}` : ""}`, "jace");
      out = { ...out, banned_at: new Date().toISOString(), ban_until: j.ban_until ?? null, ban_from: "jace" };
    }
  } else if (!j.banned && p.banned_at && p.ban_from === "jace") {
    await unbanHere(p.uuid);
    out = { ...out, banned_at: null, ban_until: null, ban_reason: null, ban_from: null };
  }
  if (j.muted && (!isMuted(p) || p.mute_from === "jace")) {
    if (!isMuted(p) || (p.mute_until ?? null) !== (j.mute_until ?? null)) {
      const why = `Muted on Jace${j.mute_reason ? `: ${j.mute_reason}` : ""}`;
      await mute(p.uuid, minutesLeft(j.mute_until), why, "jace");
      out = { ...out, muted_at: new Date().toISOString(), mute_until: j.mute_until ?? null, mute_reason: why, mute_from: "jace" };
    }
  } else if (!j.muted && p.muted_at && p.mute_from === "jace") {
    await unmute(p.uuid);
    out = { ...out, muted_at: null, mute_until: null, mute_reason: null, mute_from: null };
  }
  return out;
}

/** Durations staff can pick (minutes; null: for good). */
export const DURATIONS: Record<string, number | null> = {
  "10m": 10, "1h": 60, "6h": 360, "1d": 1440, "3d": 4320, "1w": 10080, "30d": 43200, forever: null,
};
export function duration(v: unknown): number | null {
  if (typeof v === "number" && v > 0) return Math.min(Math.round(v), 5_256_000);
  if (typeof v === "string" && v in DURATIONS) return DURATIONS[v];
  return null;
}
