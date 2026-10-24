// Jace ban appeals, for the Jace Official organization's owner and admins. A muted or banned Jace
// account can only message Jace Official; this shows those appeals in Jace Social so staff can read
// them, reply as Jace Official, and lift or keep a ban without going to Jace.
//
//   who      Jace decides: GET /api/oauth/appeals answers 200 only for Jace Official's owner and
//            admins (their own Jace token, scope messages). We remember the answer for a few minutes
//            (jace_appeal_staff) and never show appeals - or that anyone is banned - to anyone else
//   private  appeal messages are fetched live with the staff member's own token and shown only to
//            them; they're never stored or copied into normal chats (the message sync skips the
//            Jace Official thread). Only "seen" times are kept (jace_appeal_seen)
//   replies  POST /api/oauth/appeals/{id} sends as Jace Official, with external_id js-appeal-<reply id>
//            so a retried reply is skipped by Jace instead of sent twice
//   unban    Jace's moderation API with Jace Social's own client secret - so only right after the
//            clicker's own token passed the appeals check again (never from the cache)
//   notify   the cron run polls each staff member's appeals; a new message from an appealing person
//            sends them one "appeal" event (not one per poll)
import { after } from "next/server";
import { JACE, jaceModeration } from "./jace";
import { jaceTokenOf } from "./jaceSync";
import { ApiError, db, notify, type Profile } from "./server";

export type Appeal = {
  user_id: string; username: string; picture: string | null;
  status: "banned" | "muted" | "active" | "deleted";
  ban_reason: string | null; banned_at: string | null; mute_reason: string | null; muted_at: string | null;
  last_message: AppealMessage | null;
};
export type AppealMessage = { id: string; from_id: string; from_name: string; to_id: string; body: string; created_at: string };
type Access = "staff" | "reconnect" | "none";

const STAFF_TTL = 5 * 60_000;          // how long a "yes, staff" answer is trusted
const OTHERS_TTL = 15 * 60_000;        // and a "no" (so a new Jace Official admin shows up within minutes)

/** A Jace appeals API call with this staff member's token: {status, data} (status 0: Jace unreachable). */
async function jace<T>(token: string, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: T & { error?: string; error_description?: string } }> {
  try {
    const r = await fetch(`${JACE}${path}`, {
      method, cache: "no-store", signal: AbortSignal.timeout(method === "GET" ? 8_000 : 15_000),
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  } catch {
    return { status: 0, data: {} as T & { error?: string } };
  }
}

async function saveAccess(uuid: string, is_staff: boolean, reconnect: boolean) {
  await db().from("jace_appeal_staff").upsert({ uuid, is_staff, reconnect, checked_at: new Date().toISOString() }, { onConflict: "uuid" });
}

/**
 * May this profile see appeals? From the cache unless it's old (or fresh is asked for), else by asking
 * Jace with their own token. -> the access, and the appeals list when Jace was just asked.
 */
export async function appealsAccess(p: Profile, fresh = false): Promise<{ access: Access; appeals?: Appeal[] }> {
  if (p.is_bot || !p.jace_sub) return { access: "none" };
  const { data: row, error } = await db().from("jace_appeal_staff").select("*").eq("uuid", p.uuid).maybeSingle();
  if (error) return { access: "none" };                                  // before 013_jace_appeals.sql
  if (!fresh && row && Date.now() - new Date(row.checked_at).getTime() < (row.is_staff ? STAFF_TTL : OTHERS_TTL))
    return { access: !row.is_staff ? "none" : row.reconnect ? "reconnect" : "staff" };
  const token = await jaceTokenOf(p.uuid);
  if (!token) {                                                           // signed in some other way, or disconnected
    if (row?.is_staff) { await saveAccess(p.uuid, true, true); return { access: "reconnect" }; }
    await saveAccess(p.uuid, false, false);
    return { access: "none" };
  }
  const r = await jace<{ appeals: Appeal[] }>(token, "GET", "/api/oauth/appeals");
  if (r.status === 200) { await saveAccess(p.uuid, true, false); return { access: "staff", appeals: r.data.appeals ?? [] }; }
  if (r.status === 401 && row?.is_staff) { await saveAccess(p.uuid, true, true); return { access: "reconnect" }; }
  if (r.status === 0 || r.status >= 500)                                 // Jace is down: keep what we knew
    return { access: row?.is_staff ? (row.reconnect ? "reconnect" : "staff") : "none" };
  await saveAccess(p.uuid, false, false);                                 // 403 forbidden / insufficient_scope, or 401 for others
  return { access: "none" };
}

/** Only for staff: anyone else gets the same 404 as for a page that doesn't exist. */
async function requireStaff(p: Profile, fresh = false) {
  const a = await appealsAccess(p, fresh);
  if (a.access === "none") throw new ApiError(404, "Not found");
  return a;
}

const RECONNECT = { reconnect: true, error: "Your Jace sign-in stopped working - reconnect Jace to see appeals" };

/** GET /api/v1/appeals: the inbox, newest activity first, with "waiting for a reply" and unread. */
export async function listAppeals(p: Profile) {
  const a = await requireStaff(p, true);
  if (a.access === "reconnect") return { appeals: [], ...RECONNECT };
  const appeals = a.appeals ?? [];
  const { data: seen } = await db().from("jace_appeal_seen").select("user_id, last_message_at, read_at").eq("staff", p.uuid);
  const byUser = new Map((seen ?? []).map((s) => [s.user_id as string, s]));
  await remember(p.uuid, appeals, byUser);                               // seen here: the poll won't notify about these
  return {
    appeals: appeals.map((x) => {
      const waiting = !!x.last_message && x.last_message.from_id === x.user_id;
      const read = byUser.get(x.user_id)?.read_at as string | undefined;
      return { ...x, waiting, unread: waiting && (!read || new Date(x.last_message!.created_at) > new Date(read)) };
    }),
  };
}

/** GET /api/v1/appeals/{id}: one thread (opening it marks it read). */
export async function appealThread(p: Profile, userId: string, since?: string | null) {
  const a = await requireStaff(p);
  if (a.access === "reconnect") return RECONNECT;
  const token = (await jaceTokenOf(p.uuid))!;
  const r = await jace<Appeal & { messages: AppealMessage[] }>(token, "GET",
    `/api/oauth/appeals/${encodeURIComponent(userId)}${since ? `?since=${encodeURIComponent(since)}` : ""}`);
  await failed(p, r);
  const newest = r.data.messages?.at(-1)?.created_at ?? null;
  await db().from("jace_appeal_seen").upsert({ staff: p.uuid, user_id: userId, read_at: new Date().toISOString(),
    ...(newest ? { last_message_at: newest } : {}) }, { onConflict: "staff,user_id" });
  return { appeal: r.data, messages: r.data.messages ?? [] };
}

/** POST /api/v1/appeals/{id} {body, reply_id}: reply as Jace Official (the same reply_id again is skipped by Jace). */
export async function replyToAppeal(p: Profile, userId: string, body: unknown, replyId: unknown) {
  const text = String(body ?? "").trim();
  if (text.length < 1 || text.length > 4000) throw new ApiError(400, "Replies are 1 to 4000 characters");
  if (typeof replyId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(replyId)) throw new ApiError(400, "reply_id is missing");
  const a = await requireStaff(p);
  if (a.access === "reconnect") throw new ApiError(401, RECONNECT.error);
  const token = (await jaceTokenOf(p.uuid))!;
  const r = await jace<{ imported: number; skipped: number }>(token, "POST", `/api/oauth/appeals/${encodeURIComponent(userId)}`,
    { body: text, external_id: `js-appeal-${replyId}` });
  await failed(p, r);
  return { imported: r.data.imported ?? 0, skipped: r.data.skipped ?? 0 };
}

/** POST /api/v1/appeals/{id}/decision {action: "unban"|"keep", reason?, body?, reply_id?}. */
export async function decideAppeal(p: Profile, userId: string, b: { action?: unknown; reason?: unknown; body?: unknown; reply_id?: unknown }) {
  // the moderation API uses Jace Social's own secret: check the clicker with Jace right now, not the cache
  const a = await requireStaff(p, true);
  if (a.access === "reconnect") throw new ApiError(401, RECONNECT.error);
  if (b.action === "keep") return { kept: true, ...(await replyToAppeal(p, userId, b.body, b.reply_id)) };
  if (b.action !== "unban") throw new ApiError(400, 'action is "unban" or "keep"');
  const reason = String(b.reason ?? "").trim().slice(0, 300) || `Appeal accepted by @${p.jace_name ?? p.name} in Jace Social`;
  const r = await jaceModeration("unban", userId, reason);
  if (!r.ok) throw new ApiError(r.status === 404 ? 404 : 502, `Jace: ${r.error}`);
  return { result: r.data };
}

/** Turn Jace's errors into ours (401: reconnect; 403: not staff any more). */
async function failed(p: Profile, r: { status: number; data: { error?: string; error_description?: string } }) {
  if (r.status >= 200 && r.status < 300) return;
  if (r.status === 401) { await saveAccess(p.uuid, true, true); throw new ApiError(401, RECONNECT.error); }
  if (r.status === 403) { await saveAccess(p.uuid, false, false); throw new ApiError(404, "Not found"); }
  if (r.status === 404) throw new ApiError(404, "That person hasn't written to Jace Official");
  if (r.status === 400) throw new ApiError(400, r.data.error_description || "Jace refused that");
  throw new ApiError(502, "Couldn't reach Jace - try again");
}

/** Note the newest message of each appeal as seen (so the poll only notifies about newer ones). */
async function remember(staff: string, appeals: Appeal[], seen: Map<string, { last_message_at?: string | null }>) {
  const rows = appeals.filter((x) => x.last_message && (!seen.get(x.user_id)?.last_message_at
    || new Date(x.last_message.created_at) > new Date(seen.get(x.user_id)!.last_message_at!)))
    .map((x) => ({ staff, user_id: x.user_id, last_message_at: x.last_message!.created_at }));
  if (rows.length) await db().from("jace_appeal_seen").upsert(rows, { onConflict: "staff,user_id" });
}

/** The cron run: each staff member's appeals; one event per new message from an appealing person. */
export async function pollAppeals() {
  const { data: staff, error } = await db().from("jace_appeal_staff").select("uuid, polled_at, profiles(*)")
    .eq("is_staff", true).eq("reconnect", false);
  if (error) return { staff: 0, notified: 0 };                            // before 013_jace_appeals.sql
  let notified = 0;
  for (const s of staff ?? []) {
    const p = s.profiles as unknown as Profile;
    const token = await jaceTokenOf(s.uuid);
    if (!token || !p) continue;
    const r = await jace<{ appeals: Appeal[] }>(token, "GET", "/api/oauth/appeals");
    if (r.status === 401) { await saveAccess(s.uuid, true, true); continue; }
    if (r.status === 403) { await saveAccess(s.uuid, false, false); continue; }
    if (r.status !== 200) continue;
    const appeals = r.data.appeals ?? [];
    const { data: seen } = await db().from("jace_appeal_seen").select("user_id, last_message_at").eq("staff", s.uuid);
    const byUser = new Map((seen ?? []).map((x) => [x.user_id as string, x]));
    if (s.polled_at) {                                                     // the first poll only takes note
      for (const x of appeals) {
        const m = x.last_message;
        if (!m || m.from_id !== x.user_id) continue;                       // Jace Official wrote last
        const before = byUser.get(x.user_id)?.last_message_at as string | undefined;
        if (before && new Date(m.created_at) <= new Date(before)) continue;
        await notify([p.inbox], "appeal", { user_id: x.user_id, username: x.username, first: !before });
        notified++;
      }
    }
    await remember(s.uuid, appeals, byUser);
    await db().from("jace_appeal_staff").update({ polled_at: new Date().toISOString(), checked_at: new Date().toISOString() }).eq("uuid", s.uuid);
  }
  return { staff: staff?.length ?? 0, notified };
}

/** For /me: may this profile see the Appeals inbox (from the cache; refreshed after answering if old). */
export async function appealsFlag(p: Profile): Promise<Access> {
  if (p.is_bot || !p.jace_sub) return "none";
  const { data: row, error } = await db().from("jace_appeal_staff").select("is_staff, reconnect, checked_at").eq("uuid", p.uuid).maybeSingle();
  if (error) return "none";
  const old = !row || Date.now() - new Date(row.checked_at).getTime() >= (row.is_staff ? STAFF_TTL : OTHERS_TTL);
  if (!row) return (await appealsAccess(p)).access;                        // never asked: ask now (once)
  if (old) after(() => appealsAccess(p).then(async (a) => {               // tell the app if it changed
    const was: Access = !row.is_staff ? "none" : row.reconnect ? "reconnect" : "staff";
    if (a.access !== was) await notify([p.inbox], "appeals_access", { access: a.access });
  }).catch(() => {}));
  return !row.is_staff ? "none" : row.reconnect ? "reconnect" : "staff";
}
