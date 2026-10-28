// Jace's auto moderation, on Jace Social too: the same rules (Jace's admins set them on Jace, in
// Manage account -> Moderation; Jace Social reads them from Jace's /api/oauth/automod as an official
// Jace app) and the same matching as Jace's lib/automod.ts:
//   - blocked words and phrases, as whole words, also through disguises (l33t letters,
//     s.p.a.c.e.d letters, reeepeated letters)
//   - at most N links in a message
//   - optionally no pictures in messages, or no new profile pictures / banners / backgrounds
//   - names (display name, @handle, group and server names) also against Jace's blocked usernames
//   - auto-mute: after N blocked posts in 24 hours, muted here for a while (lib/moderation.ts)
// Blocked posts are logged here (automod_log, supabase/018_moderation.sql). Jace's and Jace
// Social's staff and the official Jace bot are never blocked or auto-muted.
import { ApiError, db, JACE_BOT, type Profile } from "./server";
import { JACE } from "./jace";
import { assertCanPost, mute } from "./moderation";

export type AutomodRules = {
  enabled: boolean; blocked_terms: string[]; blocked_usernames: string[];
  block_post_images: boolean; block_profile_images: boolean;
  max_links: number; auto_mute_after: number; auto_mute_minutes: number;
};

const OFF: AutomodRules = {
  enabled: false, blocked_terms: [], blocked_usernames: [], block_post_images: false, block_profile_images: false,
  max_links: 0, auto_mute_after: 0, auto_mute_minutes: 1440,
};

let cache: { at: number; rules: AutomodRules } | null = null;
const TTL = process.env.NODE_ENV === "production" ? 60_000 : 1_000;     // (local tests change them right away)

/** Jace's rules (asked at most once a minute; if Jace can't be reached, the last ones we had). */
export async function automodRules(): Promise<AutomodRules> {
  if (cache && Date.now() - cache.at < TTL) return cache.rules;
  const id = process.env.JACE_OAUTH_CLIENT_ID, secret = process.env.JACE_OAUTH_CLIENT_SECRET;
  if (!id || !secret) return OFF;
  try {
    const r = await fetch(`${JACE}/api/oauth/automod`, {
      cache: "no-store", signal: AbortSignal.timeout(4000),
      headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` },
    });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json() as Partial<AutomodRules>;
    const rules: AutomodRules = {
      enabled: d.enabled !== false,
      blocked_terms: Array.isArray(d.blocked_terms) ? d.blocked_terms.map(String) : [],
      blocked_usernames: Array.isArray(d.blocked_usernames) ? d.blocked_usernames.map(String) : [],
      block_post_images: d.block_post_images === true, block_profile_images: d.block_profile_images === true,
      max_links: Number(d.max_links) || 0, auto_mute_after: Number(d.auto_mute_after) || 0,
      auto_mute_minutes: Number(d.auto_mute_minutes) || 0,
    };
    cache = { at: Date.now(), rules };
    return rules;
  } catch {
    if (cache) { cache.at = Date.now() - 30_000; return cache.rules; }    // try again in half a minute
    return OFF;
  }
}

// --- matching (the same as Jace's lib/automod.ts) -------------------------------------------------

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "i" };

function normalize(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[0134578@$!|]/g, (c) => LEET[c] ?? c)
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const squeezeRepeats = (text: string) => text.replace(/(\p{L})\1{2,}/gu, "$1");

function spacedOutRuns(normalizedText: string): string[] {
  const runs: string[] = [];
  let run = "";
  for (const token of normalizedText.split(" ")) {
    if ([...token].length === 1) run += token;
    else { if (run.length > 1) runs.push(run); run = ""; }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

function matchesTerm(normalizedText: string, runs: string[], term: string): boolean {
  const t = normalize(term);
  if (!t) return false;
  if (` ${normalizedText} `.includes(` ${t} `)) return true;
  if (` ${squeezeRepeats(normalizedText)} `.includes(` ${t} `)) return true;
  const squashed = t.replace(/ /g, "");
  return runs.some((run) => run === squashed || squeezeRepeats(run) === squashed || (run.includes(squashed) && squashed.length >= 4));
}

const countLinks = (text: string) => (text.match(/\bhttps?:\/\/|\bwww\.[^\s]/gi) ?? []).length;

/** What's wrong with this text under these rules, or null. */
export function textProblem(rules: AutomodRules, text: string): { matched: string; message: string } | null {
  if (!rules.enabled || !text) return null;
  if (rules.max_links > 0 && countLinks(text) > rules.max_links)
    return { matched: `more than ${rules.max_links} link${rules.max_links === 1 ? "" : "s"}`, message: `That has too many links (at most ${rules.max_links}).` };
  if (!rules.blocked_terms.length) return null;
  const normalized = normalize(text), runs = spacedOutRuns(normalized);
  for (const term of rules.blocked_terms)
    if (matchesTerm(normalized, runs, term)) return { matched: term, message: "That contains words that aren't allowed on Jace Social." };
  return null;
}

/** A name (display name, @handle, group / server name): the blocked words, and Jace's blocked usernames inside it. */
export function nameProblem(rules: AutomodRules, name: string): { matched: string; message: string } | null {
  if (!rules.enabled || !name) return null;
  const words = textProblem({ ...rules, max_links: 0 }, name.replace(/[_.]/g, " "));
  if (words) return { matched: words.matched, message: "That name isn't allowed on Jace Social." };
  const squashed = normalize(name.replace(/[_.]/g, " ")).replace(/ /g, "");
  for (const term of rules.blocked_usernames) {
    const t = normalize(term).replace(/ /g, "");
    if (t && squashed.includes(t)) return { matched: term, message: "That name isn't allowed on Jace Social." };
  }
  return null;
}

// --- checking what people post --------------------------------------------------------------------

/** Never checked: the official Jace bot and staff (Jace's admins, the Jace bot's owner). */
async function exempt(p: Profile): Promise<boolean> {
  if (p.uuid === JACE_BOT) return true;
  const { isJaceStaff } = await import("./jaceBot");
  return isJaceStaff(p);
}

/** Log a blocked post, maybe auto-mute, and refuse it (throws the message to show). */
async function block(p: Profile, area: string, excerpt: string, problem: { matched: string; message: string }, rules: AutomodRules): Promise<never> {
  await db().from("automod_log").insert({ uuid: p.uuid, area, matched: problem.matched, excerpt: excerpt.slice(0, 300) })
    .then(() => {}, () => {});                                           // (before 018_moderation.sql: no log)
  if (rules.auto_mute_after > 0 && !p.is_bot) {
    const since = new Date(Date.now() - 86400_000).toISOString();
    const { count } = await db().from("automod_log").select("id", { count: "exact", head: true }).eq("uuid", p.uuid).gt("created_at", since);
    if ((count ?? 0) >= rules.auto_mute_after) {
      await mute(p.uuid, rules.auto_mute_minutes || null, `Automatic: ${count} blocked posts in 24 hours`, "automod");
      throw new ApiError(403, `${problem.message} You've been muted for a while for repeatedly posting things that aren't allowed.`);
    }
  }
  throw new ApiError(400, problem.message);
}

/** Text someone posts (a message, a bio, a status): refused if Jace's rules block it. */
export async function checkText(p: Profile, area: string, ...texts: (string | null | undefined)[]) {
  const text = texts.filter(Boolean).join("\n");
  if (!text) return;
  const rules = await automodRules();
  const problem = textProblem(rules, text);
  if (problem && !(await exempt(p))) await block(p, area, text, problem, rules);
}

/** A name someone picks: refused if it's not allowed. */
export async function checkName(p: Profile, area: string, name: string | null | undefined) {
  if (!name) return;
  const rules = await automodRules();
  const problem = nameProblem(rules, name);
  if (problem && !(await exempt(p))) await block(p, area, name, problem, rules);
}

/** Pictures: in messages ("post") or as a profile picture / banner / background ("profile"), when Jace blocks them. */
export async function checkPicture(p: Profile, area: string, kind: "post" | "profile") {
  const rules = await automodRules();
  if (!rules.enabled || (kind === "post" ? !rules.block_post_images : !rules.block_profile_images)) return;
  if (await exempt(p)) return;
  await block(p, area, "(a picture)", {
    matched: "picture",
    message: kind === "post" ? "Pictures aren't allowed in messages on Jace Social right now."
      : "New profile pictures, banners and backgrounds aren't allowed on Jace Social right now.",
  }, rules);
}

/** Everything that posts asks this first: not muted, and allowed by Jace's rules (text, pictures). */
export async function guardPost(p: Profile, area: string, text: string | null | undefined, attachments: { type?: string }[] = []) {
  assertCanPost(p);
  await checkText(p, area, text);
  if (attachments.some((a) => String(a.type ?? "").startsWith("image/"))) await checkPicture(p, area, "post");
}
