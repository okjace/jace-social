// Jace and Jace Social, kept in step for people who sign in with Jace:
//   admins    Jace's admins (userinfo is_admin, for official apps) are admins here too: they run the
//             official Jace bot like its owner (lib/jaceBot.ts isJaceStaff) - asked with their own
//             stored token, remembered for a few minutes (jace_admins, supabase/014_jace_admins.sql)
//   profile   changing your @handle or picture here changes your Jace username and picture too
//             (POST /api/oauth/profile, official apps only). Handles with "." can't be Jace usernames.
import { after } from "next/server";
import { JACE } from "./jace";
import { jaceTokenOf } from "./jaceSync";
import { db, notify, type Profile } from "./server";

const ADMIN_TTL = 10 * 60_000;

/** Is this person one of Jace's admins? (false without a Jace token, or if Jace can't be asked) */
export async function isJaceAdmin(p: Profile): Promise<boolean> {
  if (p.is_bot || !p.jace_sub) return false;
  const { data: row, error } = await db().from("jace_admins").select("is_admin, checked_at").eq("uuid", p.uuid).maybeSingle();
  if (error) return false;                                                // before 014_jace_admins.sql
  if (row && Date.now() - new Date(row.checked_at).getTime() < ADMIN_TTL) return row.is_admin;
  const token = await jaceTokenOf(p.uuid);
  let isAdmin = false;
  if (token) {
    try {
      const r = await fetch(`${JACE}/api/oauth/userinfo`, { cache: "no-store", signal: AbortSignal.timeout(8_000), headers: { Authorization: `Bearer ${token}` } });
      if (r.status >= 500) return row?.is_admin ?? false;                 // Jace is down: keep what we knew
      if (r.ok) isAdmin = (await r.json() as { is_admin?: boolean }).is_admin === true;
    } catch { return row?.is_admin ?? false; }
  }
  await db().from("jace_admins").upsert({ uuid: p.uuid, is_admin: isAdmin, checked_at: new Date().toISOString() }, { onConflict: "uuid" });
  return isAdmin;
}

const JACE_USERNAME = /^[A-Za-z0-9_]{3,20}$/;

/** After answering: send a changed handle (as the Jace username) and/or picture to Jace. Problems are
 *  told to the person as a "jace_profile" event (e.g. that username is taken on Jace). */
export function pushProfileToJace(p: Profile, change: { handle?: string | null; picture?: string | null }) {
  if (!p.jace_sub || p.is_bot) return;
  after(async () => {
    const token = await jaceTokenOf(p.uuid);
    if (!token) return;
    const body: Record<string, unknown> = {};
    const problems: string[] = [];
    if (change.handle !== undefined && change.handle) {
      if (JACE_USERNAME.test(change.handle)) body.username = change.handle;
      else problems.push(`@${change.handle} can't be a Jace username (only letters, numbers and _), so your Jace username stays the same.`);
    }
    if (change.picture !== undefined) body.picture = change.picture;
    if (Object.keys(body).length) {
      try {
        const r = await fetch(`${JACE}/api/oauth/profile`, {
          method: "POST", cache: "no-store", signal: AbortSignal.timeout(20_000),
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        const d = await r.json().catch(() => ({})) as { username?: string; error?: string; error_description?: string };
        if (r.ok) {
          if (d.username) await db().from("profiles").update({ jace_name: d.username }).eq("uuid", p.uuid);
        } else if (r.status === 404) {
          return;                                                        // Jace doesn't have this yet
        } else if (r.status === 409) {
          problems.push(`The Jace username ${body.username} is taken, so your Jace username stays the same.`);
        } else {
          problems.push(`Jace didn't take the change: ${d.error_description || d.error || r.status}`);
        }
      } catch {
        problems.push("Couldn't reach Jace to change your Jace profile - try again later.");
      }
    }
    if (problems.length) await notify([p.inbox], "jace_profile", { message: problems.join(" ") });
  });
}
