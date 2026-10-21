// The official Jace bot (its slash commands are in lib/bots.ts). It's owned by @okjace, and whoever
// is signed in as it (My bots -> Switch to this bot) runs it:
//   - anyone can message it without being friends, and it can message anyone
//   - it answers questions with AI (Claude, from the Docs), until someone asks for a person:
//     then the people signed in as the bot answer from its inbox
//   - Announcements go in its Announcements tab and to everyone as a message
//   - Docs are its help articles (and what the AI knows)
//   - it can ban people from Jace Social, and their linked Jace account too
//   - everyone gets one message from it: a welcome for new accounts, an introduction for others
import Anthropic from "@anthropic-ai/sdk";
import { after } from "next/server";
import { JACE } from "./jace";
import { DM_MAX, splitBody } from "./jaceSyncCore";
import { ApiError, db, inboxesOf, JACE_BOT, notify, type Profile } from "./server";

export const WELCOME_NEW = "Welcome to Jace Social! Add your friends and make Jace Social feel like home!";
export const WELCOME_EXISTING = "This is now the Jace bot! Ask me a question!";
const TO_PERSON = "OK! A person from Jace will answer here soon.";
const TO_AI = "You're talking to the Jace AI again. Ask me a question!";
const NO_AI = "I can't answer by myself right now. Press **Talk to a person** and someone from Jace will reply here.";
const AI_LIMIT_PER_HOUR = 30;

/** People who run the Jace bot: anyone signed in as it, and its owner. */
export async function isJaceStaff(p: Profile) {
  if (p.uuid === JACE_BOT) return true;
  const { data } = await db().from("profiles").select("bot_owner").eq("uuid", JACE_BOT).maybeSingle();
  return !!data?.bot_owner && data.bot_owner === p.uuid;
}

export async function requireJaceStaff(p: Profile) {
  if (!(await isJaceStaff(p))) throw new ApiError(403, "Only the Jace bot can do that");
}

/** Messages from the Jace bot (split to fit), with the usual live notification. -> their ids */
export async function botSay(to: { uuid: string; inbox: string }, body: string): Promise<number[]> {
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
export function answerLater(p: Profile) {
  if (p.is_bot) return;
  after(async () => {
    if ((await threadMode(p.uuid)) !== "ai") return;
    await aiAnswer(p).catch((e) => console.error("jace ai", e));
  });
}

let client: Anthropic | null = null;

async function aiAnswer(p: Profile) {
  if (!process.env.ANTHROPIC_API_KEY) { await botSay(p, NO_AI); return; }
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
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(30),
  ]);
  // the conversation, oldest first, as alternating turns starting with theirs
  const turns: Anthropic.MessageParam[] = [];
  for (const m of (history ?? []).reverse()) {
    const role = m.sender === JACE_BOT ? "assistant" : "user";
    const text = String(m.body ?? "").trim();
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${text}`;
    else turns.push({ role, content: text });
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") return;     // nothing new to answer

  const system = `You are Jace, the official bot of Jace Social: a place for friends, chats, servers and voice, with Minecraft built in (web, desktop, phones, Jace Launcher and a Minecraft mod).
You're chatting with ${p.display_name || p.name} in their direct messages with you. Answer questions about Jace Social briefly and kindly, like a helpful friend - a few sentences, plain language, light Markdown at most.
Use the Docs below as your source. If they don't cover something, say you're not sure rather than guessing, and suggest pressing "Talk to a person" so someone from Jace can help. For problems with someone's account, bans, reports or anything you can't do from a chat, also suggest "Talk to a person".

# Docs
${(docs ?? []).map((d) => `## ${d.title}\n${d.body}`).join("\n\n")}`;

  client ??= new Anthropic();
  let reply = "";
  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 2000,
      output_config: { effort: "low" },          // short chat answers
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",                      // a declined request is answered by the fallback model
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],   // the Docs are the same for everyone
      messages: turns,
    });
    if (response.stop_reason === "refusal") reply = "I can't help with that one here. Press **Talk to a person** if you need someone from Jace.";
    else reply = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) reply = "I'm a bit busy right now - ask me again in a minute, or press **Talk to a person**.";
    else if (e instanceof Anthropic.APIError) { console.error("jace ai", e.status, e.message); reply = NO_AI; }
    else throw e;
  }
  await botSay(p, reply || NO_AI);
}

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
    let sent = 0;
    for (let from = 0; ; from += 500) {
      const { data: people } = await db().from("profiles").select("uuid, inbox").not("signed_up", "is", null)
        .eq("is_bot", false).is("banned_at", null).order("uuid").range(from, from + 499);
      if (!people?.length) break;
      const rows = people.flatMap((p) => splitBody(`📢 ${text}`, DM_MAX).map((part) => ({ sender: JACE_BOT, recipient: p.uuid, body: part })));
      const { error: e } = await db().from("messages").insert(rows);
      if (e) { console.error("announce", e.message); break; }
      await notify(people.map((p) => p.inbox), "message", { from: JACE_BOT, name: "Jace", announcement: true });
      sent += people.length;
      if (people.length < 500) break;
    }
    await db().from("jace_bot_announcements").update({ sent_to: sent }).eq("id", a.id);
  });
  return a;
}

// --- bans --------------------------------------------------------------------------------------

/** Jace's moderation API, as Jace Social (an official Jace app, signed with its client id and secret). */
async function jaceModerate(action: "ban" | "unban", jaceUserId: string, reason: string) {
  const id = process.env.JACE_OAUTH_CLIENT_ID, secret = process.env.JACE_OAUTH_CLIENT_SECRET;
  if (!id || !secret) return "Jace sign-in isn't set up on this server";
  try {
    const r = await fetch(`${JACE}/api/oauth/moderation`, {
      method: "POST", signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` },
      body: JSON.stringify({ action, user_id: jaceUserId, reason }),
    });
    if (r.ok) return null;
    const d = await r.json().catch(() => ({})) as { error_description?: string; error?: string };
    return d.error_description || d.error || `Jace answered ${r.status}`;
  } catch {
    return "Couldn't reach Jace";
  }
}

/** Ban someone from Jace Social (and, if asked and they have one, their Jace account). */
export async function ban(by: Profile, uuid: string, reason: string, alsoJace: boolean) {
  const { data: t } = await db().from("profiles").select("*").eq("uuid", uuid).maybeSingle();
  if (!t) throw new ApiError(404, "Player not found");
  const target = t as Profile;
  const { data: bot } = await db().from("profiles").select("bot_owner").eq("uuid", JACE_BOT).single();
  if (target.is_bot || target.uuid === bot?.bot_owner || target.uuid === by.uuid) throw new ApiError(400, "You can't ban that account");
  const why = reason.trim().slice(0, 400) || null;
  await db().from("profiles").update({ banned_at: new Date().toISOString(), ban_reason: why }).eq("uuid", uuid);
  await db().from("sessions").delete().eq("uuid", uuid);                 // signed out everywhere
  await db().from("voice_states").delete().eq("uuid", uuid).then(() => {}, () => {});
  let jace: string | null = null;
  if (alsoJace && target.jace_sub) jace = await jaceModerate("ban", target.jace_sub, why ?? "Banned from Jace Social");
  return { banned: true, jace_banned: alsoJace && !!target.jace_sub && !jace, jace_error: jace };
}

export async function unban(uuid: string, alsoJace: boolean) {
  const { data: t } = await db().from("profiles").select("jace_sub").eq("uuid", uuid).maybeSingle();
  if (!t) throw new ApiError(404, "Player not found");
  await db().from("profiles").update({ banned_at: null, ban_reason: null }).eq("uuid", uuid);
  let jace: string | null = null;
  if (alsoJace && t.jace_sub) jace = await jaceModerate("unban", t.jace_sub as string, "Unbanned on Jace Social");
  return { banned: false, jace_unbanned: alsoJace && !!t.jace_sub && !jace, jace_error: jace };
}
