// Deleting your account by asking the Jace bot, and getting it back with a recovery ID for 10 days
// (supabase/010_account_deletion.sql has how the account is set aside and recovered).
//
//   1. "delete my account" to the Jace bot -> it answers with a button (DELETE_MARK in its message)
//   2. the app signs you in again (Jace or Minecraft): a session made in the last 10 minutes
//   3. "Are you sure?" -> DELETE /api/v1/me with that fresh session -> the recovery ID, shown once
//   4. in a new account, paste the recovery ID to the Jace bot -> that account becomes the old one
import { randomBytes } from "node:crypto";
import { after } from "next/server";
import { ApiError, db, newPlayerId, notify, sha256, type Profile } from "./server";

export { DELETE_MARK } from "./deleteMark";
export const RECOVER_DAYS = 10;
const FRESH_MINUTES = 10;

const ASKS_TO_DELETE = /\b(delete|remove|close|erase|deactivate|get rid of|terminate)\b[\s\S]{0,40}\b(account|profile)\b/i;
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";                // no 0/O, 1/I: easy to copy by hand
const RECOVERY_ID = /\bJSR(?:-?[2-9A-HJ-NP-Z]{4}){4}\b/i;

export const asksToDelete = (text: string) => ASKS_TO_DELETE.test(text) && !RECOVERY_ID.test(text);
export const findRecoveryId = (text: string) => text.match(RECOVERY_ID)?.[0] ?? null;
const normalize = (id: string) => id.toUpperCase().replace(/[^0-9A-Z]/g, "");   // JSRXXXXXXXXXXXXXXXX

function newRecoveryId() {
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => ALPHABET[b % 32]).join("");   // 16 x 5 bits = 80 random bits
  return `JSR-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
}

/** DELETE /api/v1/me: only with a session made in the last few minutes (signing in again). */
export async function deleteAccount(p: Profile, req: Request) {
  if (p.is_bot) throw new ApiError(400, "Bots are deleted from My bots");
  const t = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const { data: s } = await db().from("sessions").select("created_at, kind").eq("token_hash", sha256(t)).maybeSingle();
  if (!s || s.kind === "bot" || Date.now() - new Date(s.created_at).getTime() > FRESH_MINUTES * 60_000)
    throw new ApiError(401, "Sign in again first, then delete your account within 10 minutes");
  const id = newRecoveryId();
  const expires = new Date(Date.now() + RECOVER_DAYS * 86400_000).toISOString();
  const { error } = await db().rpc("park_account", { acct: p.uuid, parked: newPlayerId(), hash: sha256(normalize(id)), expires });
  if (error) throw error;
  after(() => notify([p.inbox], "signed_out", {}));                 // their other devices, after this answer arrives
  return { recovery_id: id, expires_at: expires };
}

/** A recovery ID sent to the Jace bot: turn this account back into the deleted one. What to answer. */
export async function recoverAccount(p: Profile, raw: string): Promise<string> {
  const { data: dead } = await db().from("profiles").select("uuid, recover_expires_at, display_name, name")
    .eq("recover_hash", sha256(normalize(raw))).not("deleted_at", "is", null).maybeSingle();
  if (!dead || new Date(dead.recover_expires_at) < new Date())
    return "That recovery ID doesn't work. It may be mistyped, already used, or older than 10 days.";
  if (p.is_bot) return "Bots can't recover accounts.";
  const { error } = await db().rpc("recover_account", { dead: dead.uuid, alive: p.uuid });
  if (error) { console.error("recover account", error); return "Something went wrong recovering it - try again in a minute."; }
  await notify([p.inbox], "account_recovered", {});               // the app reloads with the old account
  return `Welcome back, ${dead.display_name || dead.name}! Your account is recovered - friends, messages, servers and settings.`;
}

/** The regular cron run: accounts deleted more than 10 days ago go for good. */
export async function purgeDeletedAccounts() {
  const { data, error } = await db().from("profiles").delete()
    .not("deleted_at", "is", null).lt("recover_expires_at", new Date().toISOString()).select("uuid");
  if (error && !/deleted_at|recover_expires_at/.test(error.message)) throw error;   // before 010: nothing to do
  return data?.length ?? 0;
}
