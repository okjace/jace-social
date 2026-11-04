// Signing in with a Jace account: their Jace Social account (made the first time), the Jace token kept
// for message sync (only one with the "messages" scope), their Jace ban / mute carried over, then a
// session. Used by the browser sign-in (auth/jace/callback) and Jace OS (auth/jace/os: the computer's
// Jace account, through jace-account's token exchange).
import { createSession, db, newPlayerId, supabaseUrl, token, type Profile } from "./server";
import type { JaceUser } from "./jace";
import { saveConnection } from "./jaceSync";
import { syncFromJace } from "./moderation";

export async function signInWithJace(u: JaceUser) {
  const { data: existing } = await db().from("profiles").select("*").eq("jace_sub", u.sub).maybeSingle();
  let p = existing as Profile | null;
  if (p) {
    const patch: Partial<Profile> = {};
    if (p.jace_name !== u.username) patch.jace_name = u.username;
    // a placeholder made for their Jace messages (lib/jaceSync.ts) becomes their account
    if (!p.signed_up) { patch.signed_up = new Date().toISOString(); if (!p.avatar_url && u.picture) patch.avatar_url = u.picture; }
    if (Object.keys(patch).length) await db().from("profiles").update(patch).eq("uuid", p.uuid);
  } else {
    const row = {
      uuid: newPlayerId(), name: u.username, inbox: token(), signed_up: new Date().toISOString(),
      jace_sub: u.sub, jace_name: u.username, mc_linked: false, avatar_url: u.picture,
    };
    const { data, error } = await db().from("profiles").insert(row).select("*").single();
    if (error) throw error;
    p = data as Profile;
  }
  await saveConnection(p.uuid, u);                   // keep the token for syncing Jace messages
  await syncFromJace(p, true);                       // banned or muted on Jace: here too (lib/moderation.ts)
  const session = await createSession(p.uuid);       // (refuses banned accounts)
  return { ...session, uuid: p.uuid, realtime_url: supabaseUrl() ?? "", realtime_key: process.env.SUPABASE_PUBLISHABLE_KEY ?? "" };
}
