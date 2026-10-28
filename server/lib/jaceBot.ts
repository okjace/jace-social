// The official Jace bot (its slash commands are in lib/bots.ts). It's owned by @okjace, and whoever
// is signed in as it (My bots -> Switch to this bot) runs it:
//   - anyone can message it without being friends, and it can message anyone
//   - it answers questions with AI (Cloudflare Workers AI, from the Docs; the best-matching Doc
//     without it), until someone asks for a person:
//     then the people signed in as the bot answer from its inbox
//   - Announcements go in its Announcements tab and to everyone as a message
//   - Docs are its help articles (and what the AI knows)
//   - it can ban people from Jace Social, and their linked Jace account too
//   - everyone gets one message from it: a welcome for new accounts, an introduction for others
import { after } from "next/server";
import { jaceModeration } from "./jace";
import { DM_MAX, splitBody } from "./jaceSyncCore";
import { ApiError, db, inboxesOf, JACE_BOT, notify, type Profile } from "./server";
import { ensureJaceBot } from "./bots";
import { isJaceAdmin } from "./jaceAdmin";
import { banHere, mute, unbanHere, unmute } from "./moderation";
import { asksToDelete, asksToDeleteNow, DELETE_MARK, DELETE_NOW_MARK, findRecoveryId, recoverAccount, RECOVER_DAYS } from "./accountDeletion";

export const WELCOME_NEW = "Welcome to Jace Social! Add your friends and make Jace Social feel like home!";
export const WELCOME_EXISTING = "This is now the Jace bot! Ask me a question!";
const TO_PERSON = "OK! A person from Jace will answer here soon.";
const TO_AI = "You're talking to the Jace AI again. Ask me a question!";
const AI_LIMIT_PER_HOUR = 30;

/** People who run the Jace bot: anyone signed in as it, and its owner. */
export async function isJaceStaff(p: Profile) {
  if (p.uuid === JACE_BOT) return true;
  if (p.is_bot) return false;
  const { data } = await db().from("profiles").select("bot_owner").eq("uuid", JACE_BOT).maybeSingle();
  if (!!data?.bot_owner && data.bot_owner === p.uuid) return true;
  return isJaceAdmin(p);                                                  // Jace's admins (lib/jaceAdmin.ts)
}

export async function requireJaceStaff(p: Profile) {
  if (!(await isJaceStaff(p))) throw new ApiError(403, "Only the Jace bot can do that");
}

/** Messages from the Jace bot (split to fit), with the usual live notification. -> their ids */
export async function botSay(to: { uuid: string; inbox: string }, body: string): Promise<number[]> {
  await ensureJaceBot();                             // made the first time it's needed
  const { data, error } = await db().from("messages")
    .insert(splitBody(body, DM_MAX).map((part) => ({ sender: JACE_BOT, recipient: to.uuid, body: part }))).select("id");
  if (error) throw error;
  const ids = (data ?? []).map((r) => r.id as number).sort((a, b) => a - b);
  if (ids.length) await notify([to.inbox], "message", { from: JACE_BOT, name: "Jace", id: ids[0] });
  return ids;
}

/** Everyone's first message from the Jace bot, sent once (from GET /me). */
export async function welcomeOnce(p: Profile) {
  if (p.is_bot || !p.signed_up || p.jace_welcome === "done" || !("jace_welcome" in p)) return;   // before 008_jace_bot.sql: nothing
  // claim it, so two requests at once don't both send it
  const { data } = await db().from("profiles").update({ jace_welcome: "done" })
    .eq("uuid", p.uuid).or("jace_welcome.is.null,jace_welcome.eq.existing").select("uuid");
  if (!data?.length) return;
  after(async () => {
    await botSay(p, p.jace_welcome === "existing" ? WELCOME_EXISTING : WELCOME_NEW).catch((e) => console.error("jace welcome", e));
  });
}

// --- the chat: AI or a person ---------------------------------------------------------------------

export async function threadMode(uuid: string): Promise<"ai" | "human"> {
  const { data } = await db().from("jace_bot_threads").select("mode").eq("uuid", uuid).maybeSingle();
  return (data?.mode as "ai" | "human" | undefined) ?? "ai";
}

/** "Talk to a person" (human: true) or "Back to the AI" (false). */
export async function setThreadMode(p: Profile, human: boolean) {
  await db().from("jace_bot_threads").upsert({
    uuid: p.uuid, mode: human ? "human" : "ai", updated_at: new Date().toISOString(),
    ...(human ? { human_requested_at: new Date().toISOString() } : {}),
  });
  await botSay(p, human ? TO_PERSON : TO_AI);
  if (human) {                                       // tell the people running the bot
    const { data: bot } = await db().from("profiles").select("inbox, bot_owner").eq("uuid", JACE_BOT).single();
    const inboxes = [bot?.inbox, ...(bot?.bot_owner ? await inboxesOf([bot.bot_owner]) : [])].filter(Boolean) as string[];
    await notify(inboxes, "jace_support", { from: p.uuid, name: p.display_name || p.name });
  }
}

/** Someone wrote to the Jace bot: answer with AI after replying to them (unless a person has it). */
export function answerLater(p: Profile, text = "") {
  if (p.is_bot) return;
  after(async () => {
    // deleting and recovering your account work whoever has the chat (lib/accountDeletion.ts)
    const recovery = findRecoveryId(text);
    if (recovery) { await botSay(p, await recoverAccount(p, recovery)); return; }
    if (asksToDeleteNow(text)) {
      await botSay(p, `I can delete your account **right away and for good**. First you'll sign in again to show it's you, then I'll ask if you're sure.

There's **no recovery ID** this way: your friends, messages, servers you own, profile and settings are deleted at once and can't come back.
${DELETE_NOW_MARK}`);
      return;
    }
    if (asksToDelete(text)) {
      await botSay(p, `I can delete your account. First you'll sign in again to show it's you, then I'll ask if you're sure.

You'll get a **recovery ID**: for ${RECOVER_DAYS} days, pasting it here from a new account brings everything back. After that it's gone for good.
${DELETE_MARK}`);
      return;
    }
    if ((await threadMode(p.uuid)) !== "ai") return;
    await aiAnswer(p).catch((e) => console.error("jace ai", e));
  });
}

type Doc = { title: string; body: string };

/** Cloudflare Workers AI (Cloudflare doesn't train on what's sent to it; the free tier is 10,000
 *  Neurons a day). CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AI_TOKEN; JACE_AI_MODEL picks the model. */
const AI_MODEL = () => process.env.JACE_AI_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8-fast";
const aiConfigured = () => !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_AI_TOKEN);

async function aiAnswer(p: Profile) {
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await db().from("messages").select("id", { count: "exact", head: true })
    .eq("sender", p.uuid).eq("recipient", JACE_BOT).gt("created_at", hourAgo);
  if ((count ?? 0) > AI_LIMIT_PER_HOUR) {
    await botSay(p, "That's a lot of questions for one hour! Try again a bit later, or press **Talk to a person**.");
    return;
  }
  await notify([p.inbox], "typing", { from: JACE_BOT, name: "Jace", dm: true });

  const [{ data: docs }, { data: history }] = await Promise.all([
    db().from("jace_bot_docs").select("title, body").order("position").order("title"),
    db().from("messages").select("sender, body, created_at, id")
      .or(`and(sender.eq.${p.uuid},recipient.eq.${JACE_BOT}),and(sender.eq.${JACE_BOT},recipient.eq.${p.uuid})`)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(20),
  ]);
  // the conversation, oldest first, as alternating turns starting with theirs
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of (history ?? []).reverse()) {
    const role = m.sender === JACE_BOT ? "assistant" : "user";
    const text = String(m.body ?? "").trim().slice(0, 2000);
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${text}`;
    else turns.push({ role, content: text });
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") return;     // nothing new to answer
  const question = turns[turns.length - 1].content;

  let reply = aiConfigured() ? await askCloudflare(p, (docs ?? []) as Doc[], turns) : null;
  if (!reply) reply = bestDoc(question, (docs ?? []) as Doc[]);           // no AI, over today's limit, or down
  await botSay(p, reply);
}

async function askCloudflare(p: Profile, docs: Doc[], turns: { role: string; content: string }[]): Promise<string | null> {
  // Small models guess when the Docs don't say: the rules come last (closest to the question), with
  // the exact words to use when the answer isn't there, and little randomness (temperature).
  const system = `You are Jace, the official help bot of Jace Social (friends, chats, servers and voice, with Minecraft built in).
You're chatting with ${p.display_name || p.name}.

# Docs (everything you know about Jace Social)
${docs.map((d) => `## ${d.title}\n${d.body}`).join("\n\n")}

# Rules
- Answer ONLY with facts written in the Docs above. Never invent buttons, menus, settings or features.
- If the Docs don't answer the question, reply with exactly: "${NOT_IN_DOCS}"
- Questions that aren't about Jace Social: say you can only help with Jace Social.
- Account problems, bans, reports or bugs: suggest pressing "Talk to a person".
- Keep it short and friendly: one to four sentences, plain words. Name menus the way the Docs do (like Settings → Accounts).`;
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${AI_MODEL()}`, {
      method: "POST", signal: AbortSignal.timeout(25_000),
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_AI_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "system", content: system }, ...turns], max_tokens: 400, max_completion_tokens: 400, temperature: 0.2 }),
    });
    const d = await r.json().catch(() => ({})) as {
      success?: boolean; errors?: { message?: string }[];
      result?: { response?: string; choices?: { message?: { content?: string } }[] };
    };
    if (!r.ok || d.success === false) {
      console.error("jace ai", r.status, d.errors?.map((e) => e.message).join("; "));   // e.g. over the free daily Neurons
      return null;
    }
    const text = d.result?.response ?? d.result?.choices?.[0]?.message?.content ?? "";
    return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || null;      // models that think out loud
  } catch (e) {
    console.error("jace ai", e);
    return null;
  }
}

/** Without AI: the Doc whose words best match the question, or "talk to a person". */
export function bestDoc(question: string, docs: Doc[]): string {
  const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, ""));
  const q = new Set(words(question));
  if (!q.size) return NO_MATCH;
  let best: { doc: Doc; score: number } | null = null;
  for (const doc of docs) {
    const title = new Set(words(doc.title)), body = words(doc.body);
    let score = 0;
    for (const w of q) score += (title.has(w) ? 3 : 0) + Math.min(3, body.filter((b) => b === w).length);
    if (!best || score > best.score) best = { doc, score };
  }
  if (!best || best.score < 2) return NO_MATCH;
  return `This might help - **${best.doc.title}**:\n\n${best.doc.body.trim()}`.slice(0, 1990);
}
const NOT_IN_DOCS = "I'm not sure about that one - it isn't in my Docs. Press **Talk to a person** and someone from Jace will reply here.";
const NO_MATCH = "I'm not sure about that one. Have a look in the **Docs** tab, or press **Talk to a person** and someone from Jace will reply here.";
const STOP = new Set(["the", "and", "how", "what", "can", "you", "your", "for", "are", "does", "with", "this", "that", "who", "why",
  "where", "when", "which", "there", "their", "about", "have", "has", "get", "make", "want", "jace", "social", "please", "help"]);

// --- the people running it: their inbox -------------------------------------------------------------

/** Everyone who has a chat with the Jace bot, newest first, with who asked for a person. */
export async function inbox() {
  const { data: msgs } = await db().from("messages").select("sender, recipient, body, created_at, read_at")
    .or(`sender.eq.${JACE_BOT},recipient.eq.${JACE_BOT}`).order("created_at", { ascending: false }).limit(2000);
  const byPerson = new Map<string, { last_at: string; last: string; unread: number }>();
  for (const m of msgs ?? []) {
    const other = m.sender === JACE_BOT ? m.recipient : m.sender;
    const row = byPerson.get(other) ?? { last_at: m.created_at, last: m.body, unread: 0 };
    if (m.recipient === JACE_BOT && !m.read_at) row.unread++;
    byPerson.set(other, row);
  }
  // only chats where they wrote something (not just the welcome)
  const wrote = new Set((msgs ?? []).filter((m) => m.recipient === JACE_BOT).map((m) => m.sender));
  const ids = [...byPerson.keys()].filter((u) => wrote.has(u));
  if (!ids.length) return [];
  const [{ data: people }, { data: threads }] = await Promise.all([
    db().from("profiles").select("uuid, name, display_name, avatar_url, handle, banned_at").in("uuid", ids),
    db().from("jace_bot_threads").select("uuid, mode, human_requested_at").in("uuid", ids),
  ]);
  return ids.map((u) => {
    const p = (people ?? []).find((x) => x.uuid === u);
    const t = (threads ?? []).find((x) => x.uuid === u);
    return { uuid: u, name: p?.display_name || p?.name || "Someone", handle: p?.handle ?? null, avatar_url: p?.avatar_url ?? null,
      banned: !!p?.banned_at, wants_person: t?.mode === "human", ...byPerson.get(u)! };
  }).sort((a, b) => Number(b.wants_person) - Number(a.wants_person) || b.last_at.localeCompare(a.last_at));
}

// --- announcements ------------------------------------------------------------------------------

/** Post an announcement: it's in the tab at once, and goes to everyone as a message after answering. */
export async function announce(body: string) {
  const text = body.trim();
  if (!text || text.length > 4000) throw new ApiError(400, "Announcements are 1 to 4000 characters");
  const { data: a, error } = await db().from("jace_bot_announcements").insert({ body: text }).select("*").single();
  if (error) throw error;
  after(async () => {
    const sent = await toEveryone(`📢 ${text}`, true);
    await db().from("jace_bot_announcements").update({ sent_to: sent }).eq("id", a.id);
  });
  return a;
}

/** Broadcast (its own tab, staff only): a normal message from the Jace bot to everyone - not listed
 *  in Announcements. Sent after answering; the sender gets "broadcast_sent" with the count. */
export function broadcast(by: Profile, body: string) {
  const text = body.trim();
  if (!text || text.length > 4000) throw new ApiError(400, "Messages are 1 to 4000 characters");
  after(async () => {
    const sent = await toEveryone(text, false);
    await notify([by.inbox], "broadcast_sent", { sent });
  });
  return { sending: true };
}

/** A message from the Jace bot to everyone signed up (not bots, banned or deleted accounts). -> how many */
async function toEveryone(text: string, announcement: boolean) {
  let sent = 0;
  for (let from = 0; ; from += 500) {
    const { data: people } = await db().from("profiles").select("uuid, inbox, deleted_at").not("signed_up", "is", null)
      .eq("is_bot", false).is("banned_at", null).order("uuid").range(from, from + 499);
    if (!people?.length) break;
    const live = people.filter((p) => !p.deleted_at);
    const rows = live.flatMap((p) => splitBody(text, DM_MAX).map((part) => ({ sender: JACE_BOT, recipient: p.uuid, body: part })));
    if (rows.length) {
      const { error: e } = await db().from("messages").insert(rows);
      if (e) { console.error("jace bot to everyone", e.message); break; }
      await notify(live.map((p) => p.inbox), "message", { from: JACE_BOT, name: "Jace", announcement });
    }
    sent += live.length;
    if (people.length < 500) break;
  }
  return sent;
}

// --- bans --------------------------------------------------------------------------------------

/** Jace's moderation API, as Jace Social (an official Jace app, signed with its client id and secret). */
async function jaceModerate(action: "ban" | "unban" | "mute" | "unmute", jaceUserId: string, reason: string, minutes: number | null = null) {
  const r = await jaceModeration(action, jaceUserId, reason, minutes);
  return r.ok ? null : r.error;
}

async function targetOf(by: Profile, uuid: string, what: string) {
  const { data: t } = await db().from("profiles").select("*").eq("uuid", uuid).maybeSingle();
  if (!t) throw new ApiError(404, "Player not found");
  const target = t as Profile;
  const { data: bot } = await db().from("profiles").select("bot_owner").eq("uuid", JACE_BOT).single();
  if (target.is_bot || target.uuid === bot?.bot_owner || target.uuid === by.uuid || (await isJaceAdmin(target)))
    throw new ApiError(400, `You can't ${what} that account`);
  return target;
}

/** Ban someone from Jace Social for `minutes` (null: for good) - and, if asked and they have one, their Jace account. */
export async function ban(by: Profile, uuid: string, reason: string, alsoJace: boolean, minutes: number | null = null) {
  const target = await targetOf(by, uuid, "ban");
  const why = reason.trim().slice(0, 400) || null;
  await banHere(uuid, minutes, why, "staff");
  let jace: string | null = null;
  if (alsoJace && target.jace_sub) jace = await jaceModerate("ban", target.jace_sub, why ?? "Banned from Jace Social", minutes);
  return { banned: true, jace_banned: alsoJace && !!target.jace_sub && !jace, jace_error: jace };
}

export async function unban(uuid: string, alsoJace: boolean) {
  const { data: t } = await db().from("profiles").select("jace_sub").eq("uuid", uuid).maybeSingle();
  if (!t) throw new ApiError(404, "Player not found");
  await unbanHere(uuid);
  let jace: string | null = null;
  if (alsoJace && t.jace_sub) jace = await jaceModerate("unban", t.jace_sub as string, "Unbanned on Jace Social");
  return { banned: false, jace_unbanned: alsoJace && !!t.jace_sub && !jace, jace_error: jace };
}

/** Mute someone on Jace Social (they can read, not post) for `minutes` (null: for good) - on Jace too, if asked. */
export async function muteAccount(by: Profile, uuid: string, reason: string, alsoJace: boolean, minutes: number | null) {
  const target = await targetOf(by, uuid, "mute");
  const why = reason.trim().slice(0, 400);
  await mute(uuid, minutes, why, "staff");
  let jace: string | null = null;
  if (alsoJace && target.jace_sub) jace = await jaceModerate("mute", target.jace_sub, why || "Muted on Jace Social", minutes);
  return { muted: true, jace_muted: alsoJace && !!target.jace_sub && !jace, jace_error: jace };
}

export async function unmuteAccount(uuid: string, alsoJace: boolean) {
  const { data: t } = await db().from("profiles").select("jace_sub").eq("uuid", uuid).maybeSingle();
  if (!t) throw new ApiError(404, "Player not found");
  await unmute(uuid);
  let jace: string | null = null;
  if (alsoJace && t.jace_sub) jace = await jaceModerate("unmute", t.jace_sub as string, "Unmuted on Jace Social");
  return { muted: false, jace_unmuted: alsoJace && !!t.jace_sub && !jace, jace_error: jace };
}
