// The parts of the Jace message sync (lib/jaceSync.ts) that don't touch the database, so
// they can be tested on their own (scripts/test-jace-core.mjs).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const DM_MAX = 2000;          // Jace Social direct messages (supabase/004_community.sql)
export const CHANNEL_MAX = 4000;     // group chat messages
export const JACE_MAX = 4000;        // Jace messages

/**
 * Split a message into parts of at most `max` characters, preferring to break after a line
 * or a space near the end, so a long Jace message becomes several messages instead of being
 * cut off. Joining the parts gives the original text back.
 */
export function splitBody(body: string, max = DM_MAX): string[] {
  const chars = [...body];                       // whole characters (emoji stay in one piece)
  if (chars.length <= max) return [body];
  const parts: string[] = [];
  let i = 0;
  while (i < chars.length) {
    let end = Math.min(i + max, chars.length);
    if (end < chars.length) {
      const window = chars.slice(i, end).join("");
      const at = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
      if (at >= max / 2) end = i + [...window.slice(0, at + 1)].length;    // keep the space with this part
    }
    parts.push(chars.slice(i, end).join(""));
    i = end;
  }
  return parts;
}

/** The id Jace stores a message under when it was sent with this external_id. */
export function appMessageId(clientId: string, externalId: string): string {
  return "app-" + createHash("sha256").update(`${clientId}:${externalId}`).digest("hex").slice(0, 32);
}

/** Our external_id for a Jace Social message: js-dm-<id> or js-ch-<id>. */
export const externalIdFor = (kind: "dm" | "ch", localId: number) => `js-${kind}-${localId}`;

// --- tokens: AES-256-GCM with JACE_TOKEN_KEY (32 bytes, base64 or hex) ----------------------

export function tokenKey(raw = process.env.JACE_TOKEN_KEY): Buffer | null {
  if (!raw) return null;
  const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return k.length === 32 ? k : null;
}

export function encryptToken(token: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptToken(sealed: string, key: Buffer): string {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unknown token format");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

// --- what Jace's errors mean ----------------------------------------------------------------

export type JaceFailure = "disconnected" | "banned" | "muted" | "not_found" | "rejected" | "temporary";

/** Turn a failed Jace answer into what to do about it (see the messages API's error table). */
export function classify(status: number, body: { error?: string; error_description?: string }): JaceFailure {
  if (status === 401) return "disconnected";                        // sign in with Jace again
  if (status === 403 && body.error === "account_banned") return "banned";
  if (status === 403 && body.error === "insufficient_scope") return "disconnected";   // an old token without messages
  if (status === 403) return "muted";                               // invalid_request on POST: muted
  if (status === 404) return "not_found";
  if (status === 400 || status === 413 || status === 422) return "rejected";
  return "temporary";                                               // 429, 5xx, network: retry later
}

/** Seconds until the next try of a queued push: 1 min, 2, 4, ... up to 6 hours. */
export const backoffSeconds = (attempts: number) => Math.min(6 * 3600, 60 * 2 ** Math.max(0, attempts));
export const MAX_ATTEMPTS = 12;
