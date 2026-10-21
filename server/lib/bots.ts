// Bots: accounts (profiles.is_bot) with an owner. Four kinds act in chats:
//  - API bots run anywhere and use the API with their token; they get live events like anyone,
//    plus "command" events when someone uses one of their slash commands;
//  - hosted code bots (JavaScript saved here) run in a sandbox by lib/codebots.ts;
//  - block bots (made in the app's block editor) are run here by lib/blocks.ts;
//  - the official Jace bot, built in below.
// A bot never reacts to another bot, so they can't loop. Everything bots do goes in their
// activity log (lib/botlog.ts).
import { Runner, programCommands, type Env, type Handler, type Program } from "./blocks";
import { logBot, short } from "./botlog";
import { LIMITS as CODE_LIMITS, runCode, type CodeEvent } from "./codebots";
import { channelFor, postMessage, profilesById, type Channel } from "./chat";
import { has, P, serverCtx } from "./perms";
import { ApiError, db, inboxesOf, notify, publicProfile, siteUrl, token, type Profile } from "./server";

import { JACE_BOT, JACE_BOT_HANDLE } from "./server";
export { JACE_BOT };

/** The official Jace bot's profile (made the first time it's needed). */
export async function ensureJaceBot(): Promise<Profile> {
  const { data } = await db().from("profiles").select("*").eq("uuid", JACE_BOT).maybeSingle();
  if (data && data.handle !== JACE_BOT_HANDLE) {               // @jacebot (reserved, so nobody else can have it)
    const { error } = await db().from("profiles").update({ handle: JACE_BOT_HANDLE }).eq("uuid", JACE_BOT);
    if (!error) data.handle = JACE_BOT_HANDLE;
  }
  if (data) return data as Profile;
  // (its owner, @okjace, is set once by supabase/008_jace_bot.sql - never from a handle at runtime,
  //  so nobody can become the official bot's owner by taking a handle)
  const { data: made, error } = await db().from("profiles").upsert({
    uuid: JACE_BOT, name: "Jace", handle: JACE_BOT_HANDLE, inbox: token(), is_bot: true, bot_public: true, mc_linked: false,
    signed_up: new Date().toISOString(), avatar_url: `${siteUrl()}/jace-bot.png`,
    bio: "The official Jace Social bot. Ask me a question!", status: "online",
    last_seen: new Date(Date.now() + 100 * 365 * 86400_000).toISOString(),   // always shown online
  }).select("*").single();
  if (error) throw error;
  return made as Profile;
}

export const JACE_COMMANDS = [
  { name: "help", description: "What the bots here can do", options: [] },
  { name: "ping", description: "Check that I'm awake", options: [] },
  { name: "roll", description: "Roll a die", options: [{ name: "sides", description: "How many sides (default 6)" }] },
  { name: "coinflip", description: "Heads or tails", options: [] },
  { name: "8ball", description: "Ask the magic 8-ball", options: [{ name: "question", description: "Your question", required: true }] },
  { name: "choose", description: "Pick one for you", options: [{ name: "options", description: "Things to pick from, separated by commas", required: true }] },
  { name: "poll", description: "Start a poll", options: [{ name: "question", description: "The question", required: true }, { name: "options", description: "Answers, separated by commas" }] },
  { name: "mcstatus", description: "Is a Minecraft server online?", options: [{ name: "address", description: "Server address, like play.example.net", required: true }] },
  { name: "serverinfo", description: "About this server", options: [] },
  { name: "userinfo", description: "About someone", options: [{ name: "user", description: "@mention them (default: you)" }] },
];

type Ctx = { channel: Channel; members: string[]; user: Profile; message?: Record<string, unknown> };

/** Bots among these players (with what they need to run). */
async function botsAmong(uuids: string[]): Promise<Profile[]> {
  if (!uuids.length) return [];
  const { data } = await db().from("profiles").select("*").in("uuid", uuids).eq("is_bot", true);
  return (data ?? []) as Profile[];
}

/** What a block bot can do while handling one event. */
function envFor(bot: Profile, c: Ctx, text: string, args: Record<string, string>, components: unknown[]): Env {
  const serverId = c.channel.server_id;
  const where = { server_id: serverId, channel_id: c.channel.id };
  let first = true;
  const say = async (channel: Channel, members: string[], body: string) => {
    const sc = serverId ? await serverCtx(serverId, bot.uuid).catch(() => null) : null;
    await postMessage(channel, members, bot, body, "text", {
      perms: sc ? sc.base : 0, components: first ? components : [],
      reply_to: first && c.message ? Number(c.message.id) : null,
    });
    first = false;
  };
  let serverInfo: Env["server"] = null;
  return {
    text, args, bot: bot.uuid, scope: serverId ?? c.channel.id,
    author: { uuid: c.user.uuid, name: c.user.display_name || c.user.name },
    channel: { id: c.channel.id, name: c.channel.name },
    get server() { return serverInfo; },
    async hasRole(name) {
      if (!serverId) return false;
      const { data } = await db().from("server_member_roles").select("role_id, server_roles(name)").eq("server_id", serverId).eq("uuid", c.user.uuid);
      return (data ?? []).some((r) => String((r.server_roles as unknown as { name: string })?.name).toLowerCase() === name.toLowerCase());
    },
    async reply(body) { await say(c.channel, c.members, body); },
    async send(channelName, body) {
      if (!serverId) return this.reply(body);
      const { data: ch } = await db().from("channels").select("*").eq("server_id", serverId)
        .ilike("name", channelName.replace(/^#/, "")).maybeSingle();
      if (!ch) return;
      const target = await channelFor(ch.id, bot.uuid).catch(() => null);
      if (target && has(target.perms, P.SEND)) await say(target.channel, target.members, body);
    },
    async react(emoji) {
      if (!c.message || !emoji.trim()) return;
      await logBot(bot.uuid, "react", `Reacted ${emoji.trim()} to ${c.user.display_name || c.user.name}'s message`, where);
      await db().from("message_reactions").upsert({ scope: "c", message_id: Number(c.message.id), uuid: bot.uuid, emoji: emoji.trim() });
      await notify(await inboxesOf(c.members), "channel", { channel_id: c.channel.id, server_id: serverId, id: c.message.id, reacted: true });
    },
    async giveRole(name, give) {
      if (!serverId) return;
      const sc = await serverCtx(serverId, bot.uuid).catch(() => null);
      const role = sc?.roles.find((r) => !r.is_default && r.name.toLowerCase() === name.toLowerCase());
      if (!sc || !role || !has(sc.base, P.MANAGE_ROLES) || role.position >= sc.top) {     // bots follow role order too
        await logBot(bot.uuid, "error", `Couldn't ${give ? "give" : "take"} the role "${name}": ${role ? "it's above the bot's own roles, or the bot can't manage roles" : "there's no such role"}`, where);
        return;
      }
      await logBot(bot.uuid, "role", `${give ? "Gave" : "Took"} the role ${role.name} ${give ? "to" : "from"} ${c.user.display_name || c.user.name}`, where);
      if (give) await db().from("server_member_roles").upsert({ server_id: serverId, uuid: c.user.uuid, role_id: role.id });
      else await db().from("server_member_roles").delete().eq("server_id", serverId).eq("uuid", c.user.uuid).eq("role_id", role.id);
      await notify(await inboxesOf(c.members), "servers", { kind: "changed", server_id: serverId });
    },
    async deleteMessage() {
      if (!c.message || !serverId) return;
      const sc = await serverCtx(serverId, bot.uuid).catch(() => null);
      if (!sc || !has(sc.base, P.MANAGE_MESSAGES)) {
        await logBot(bot.uuid, "error", "Couldn't delete a message: the bot can't manage messages here", where);
        return;
      }
      await logBot(bot.uuid, "delete", `Deleted ${c.user.display_name || c.user.name}'s message: ${short(String(c.message.body ?? ""), 200)}`, where);
      await db().from("channel_messages").delete().eq("id", Number(c.message.id));
      await notify(await inboxesOf(c.members), "channel", { channel_id: c.channel.id, server_id: serverId, id: c.message.id, deleted: true });
    },
    ...(serverId ? { _load: (async () => {
      const [{ data: s }, { count }] = await Promise.all([
        db().from("servers").select("name").eq("id", serverId).single(),
        db().from("server_members").select("uuid", { count: "exact", head: true }).eq("server_id", serverId),
      ]);
      serverInfo = { id: serverId, name: s?.name ?? "", members: count ?? 0 };
    })() } : {}),
  } as Env;
}

async function runHandler(bot: Profile, h: Handler, c: Ctx, text: string, args: Record<string, string>, components: unknown[] = []) {
  await logBot(bot.uuid, "event", describeEvent(h.event, c, text, h.command?.name), { server_id: c.channel.server_id, channel_id: c.channel.id });
  const env = envFor(bot, c, text, args, components) as Env & { _load?: Promise<void> };
  await env._load;
  try {
    await new Runner(env).run(h.actions);
  } catch (e) {
    await logBot(bot.uuid, "error", `Blocks stopped: ${(e as Error).message}`, { server_id: c.channel.server_id, channel_id: c.channel.id });
    throw e;
  }
}

function describeEvent(kind: string, c: Ctx, text: string, command?: string) {
  const who = c.user.display_name || c.user.name;
  const where = c.channel.server_id ? `#${c.channel.name}` : "a group chat";
  if (kind === "command") return `${who} used /${command}${text ? " " + short(text, 150) : ""} in ${where}`;
  if (kind === "join") return `${who} joined the server`;
  return `${who} said in ${where}: ${short(text, 200)}`;
}

/** Run a hosted code bot for one event, then do what it asked (with its own permissions). */
async function runCodeBot(bot: Profile, kind: CodeEvent["type"], c: Ctx, text: string, command?: { name: string; args: Record<string, string> },
                          components: unknown[] = []) {
  const where = { server_id: c.channel.server_id, channel_id: c.channel.id };
  await logBot(bot.uuid, "event", describeEvent(kind, c, text, command?.name), where);
  const env = envFor(bot, c, text, command?.args ?? {}, components) as Env & { _load?: Promise<void> };
  await env._load;
  const { data: saved } = await db().from("bot_storage").select("key, value").eq("bot", bot.uuid).eq("scope", env.scope).limit(CODE_LIMITS.keys);
  const storage = Object.fromEntries((saved ?? []).map((r) => [r.key, r.value]));
  const r = await runCode(String(bot.bot_code), {
    type: kind, text, command,
    author: { id: c.user.uuid, name: c.user.display_name || c.user.name },
    channel: { id: c.channel.id, name: c.channel.name ?? "" },
    server: env.server ? { id: env.server.id, name: env.server.name } : null,
  }, storage);
  for (const line of r.logs) await logBot(bot.uuid, "log", line, where);
  if (r.error) await logBot(bot.uuid, "error", r.error, where);
  for (const [key, value] of Object.entries(r.storage)) {
    if (value === null) await db().from("bot_storage").delete().eq("bot", bot.uuid).eq("scope", env.scope).eq("key", key);
    else await db().from("bot_storage").upsert({ bot: bot.uuid, scope: env.scope, key, value });
    await logBot(bot.uuid, "storage", value === null ? `Forgot "${key}"` : `Saved "${key}" = ${short(JSON.stringify(value), 150)}`, where);
  }
  let messages = 0;
  for (const a of r.actions) {
    if ((a.t === "reply" || a.t === "send") && ++messages > CODE_LIMITS.messages) {
      await logBot(bot.uuid, "error", `Only ${CODE_LIMITS.messages} messages per event; skipped the rest`, where);
      break;
    }
    try {
      if (a.t === "reply") await env.reply(a.text);
      else if (a.t === "send") await env.send(a.channel, a.text);
      else if (a.t === "react") await env.react(a.emoji);
      else if (a.t === "give_role" || a.t === "take_role") await env.giveRole(a.role, a.t === "give_role");
      else if (a.t === "delete_message") await env.deleteMessage();
    } catch (e) {
      await logBot(bot.uuid, "error", `${a.t} failed: ${(e as Error).message}`, where);
    }
  }
}

function matches(h: Handler, text: string) {
  const m = h.match ?? { kind: "any", text: "" };
  const a = text.toLowerCase(), b = (m.text ?? "").toLowerCase().trim();
  if (m.kind === "any" || !b) return true;
  if (m.kind === "contains") return a.includes(b);
  if (m.kind === "starts") return a.startsWith(b);
  return a.trim() === b;
}

/** A message was posted in a group chat or server channel: block bots there may answer. */
export async function onChannelMessage(channel: Channel, members: string[], sender: Profile, message: Record<string, unknown>) {
  if (sender.is_bot) return;
  const text = String(message.body ?? "");
  for (const bot of await botsAmong(members)) {
    if (!bot.bot_enabled) continue;
    if (bot.bot_code) {
      await runCodeBot(bot, "message", { channel, members, user: sender, message }, text).catch((e) => console.error("code bot", bot.uuid, e));
      continue;
    }
    if (!bot.bot_program) continue;
    for (const h of (bot.bot_program as Program).handlers ?? []) {
      if (h.event === "message" && matches(h, text)) {
        await runHandler(bot, h, { channel, members, user: sender, message }, text, {}).catch((e) => console.error("block bot", bot.uuid, e));
      }
    }
  }
}

/** Someone joined a server: block bots' "when someone joins" run in the system channel. */
export async function onMemberJoin(serverId: string, who: Profile) {
  const { data: members } = await db().from("server_members").select("uuid").eq("server_id", serverId);
  const bots = (await botsAmong((members ?? []).map((m) => m.uuid))).filter((b) => b.bot_enabled && (b.bot_program || b.bot_code));
  if (!bots.length) return;
  const { data: s } = await db().from("servers").select("system_channel").eq("id", serverId).single();
  if (!s?.system_channel) return;
  for (const bot of bots) {
    const target = await channelFor(s.system_channel, bot.uuid).catch(() => null);
    if (!target) continue;
    if (bot.bot_code) {
      await runCodeBot(bot, "join", { channel: target.channel, members: target.members, user: who }, "").catch(() => {});
      continue;
    }
    for (const h of (bot.bot_program as Program).handlers ?? []) {
      if (h.event === "join") await runHandler(bot, h, { channel: target.channel, members: target.members, user: who }, "", {}).catch(() => {});
    }
  }
}

/** The slash commands available in a chat, from the bots that are in it. */
export async function commandsIn(members: string[]) {
  const out: { bot: string; bot_name: string; avatar_url: string | null; name: string; description: string; options: unknown[] }[] = [];
  for (const b of await botsAmong(members)) {
    if (!b.bot_enabled && b.uuid !== JACE_BOT) continue;
    const list = b.uuid === JACE_BOT ? JACE_COMMANDS
      : [...programCommands(b.bot_program as Program), ...((b.bot_commands ?? []) as typeof JACE_COMMANDS)];
    for (const c of list) out.push({ bot: b.uuid, bot_name: b.display_name || b.name, avatar_url: b.avatar_url ?? null, ...c, options: c.options ?? [] });
  }
  return out;
}

/** Someone used a slash command in a chat. */
export async function runCommand(c: Ctx, botId: string, name: string, args: Record<string, string>) {
  const [bot] = await botsAmong([botId]);
  if (!bot || !c.members.includes(bot.uuid)) throw new Error("That bot isn't here");
  const used = [{ type: "command", user: c.user.uuid, name }];
  const text = Object.values(args).join(" ");
  if (bot.uuid === JACE_BOT) return jaceCommand(bot, c, name, args, used);
  if (bot.bot_code && bot.bot_enabled) return runCodeBot(bot, "command", c, text, { name, args }, used);
  const h = ((bot.bot_program as Program)?.handlers ?? []).find((x) => x.event === "command" && x.command?.name === name);
  if (h && bot.bot_enabled) return runHandler(bot, h, c, text, args, used);
  // an API bot: tell it, it answers through the API
  await logBot(bot.uuid, "command", describeEvent("command", c, text, name), { server_id: c.channel.server_id, channel_id: c.channel.id });
  await notify([bot.inbox], "command", {
    channel_id: c.channel.id, server_id: c.channel.server_id, user: c.user.uuid,
    user_name: c.user.display_name || c.user.name, name, args,
  });
}

const EIGHT_BALL = ["It is certain.", "Without a doubt.", "Yes, definitely.", "Most likely.", "Signs point to yes.",
  "Ask again later.", "Better not tell you now.", "Cannot predict now.", "Don't count on it.", "My sources say no.",
  "Very doubtful.", "Outlook not so good."];
const NUMBERS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

async function jaceCommand(bot: Profile, c: Ctx, name: string, args: Record<string, string>, used: unknown[]) {
  const sc = c.channel.server_id ? await serverCtx(c.channel.server_id, bot.uuid).catch(() => null) : null;
  const say = (body: string, extra: { reactions?: string[] } = {}) => postMessage(c.channel, c.members, bot, body, "text",
    { perms: sc?.base ?? 0, components: used }).then(async (m) => {
      for (const e of extra.reactions ?? []) await db().from("message_reactions").upsert({ scope: "c", message_id: m.id, uuid: bot.uuid, emoji: e });
      if (extra.reactions?.length) await notify(await inboxesOf(c.members), "channel", { channel_id: c.channel.id, server_id: c.channel.server_id, id: m.id, reacted: true });
    });
  switch (name) {
    case "help": {
      const cmds = await commandsIn(c.members);
      return say("**Commands here**\n" + cmds.map((x) => `\`/${x.name}\` ${x.description} - ${x.bot_name}`).join("\n"));
    }
    case "ping": return say("Pong! 🏓");
    case "roll": {
      const sides = Math.max(2, Math.min(1000, Math.floor(Number(args.sides) || 6)));
      return say(`🎲 You rolled **${1 + Math.floor(Math.random() * sides)}** (1-${sides})`);
    }
    case "coinflip": return say(Math.random() < 0.5 ? "🪙 **Heads**" : "🪙 **Tails**");
    case "8ball": return say(`🎱 ${EIGHT_BALL[Math.floor(Math.random() * EIGHT_BALL.length)]}`);
    case "choose": {
      const opts = String(args.options ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      return say(opts.length ? `I pick **${opts[Math.floor(Math.random() * opts.length)]}**` : "Give me some options, separated by commas");
    }
    case "poll": {
      const q = String(args.question ?? "").trim() || "Poll";
      const opts = String(args.options ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10);
      if (!opts.length) return say(`📊 **${q}**`, { reactions: ["👍", "👎"] });
      return say(`📊 **${q}**\n` + opts.map((o, i) => `${NUMBERS[i]} ${o}`).join("\n"), { reactions: NUMBERS.slice(0, opts.length) });
    }
    case "mcstatus": {
      const addr = String(args.address ?? "").trim();
      if (!/^[a-zA-Z0-9.-]{1,253}(:\d{1,5})?$/.test(addr)) return say("That doesn't look like a server address");
      try {
        const r = await fetch(`https://api.mcsrvstat.us/3/${encodeURIComponent(addr)}`, { headers: { "User-Agent": "JaceSocialBot/1.0" }, signal: AbortSignal.timeout(6000) });
        const d = await r.json() as { online: boolean; players?: { online: number; max: number }; version?: string; motd?: { clean?: string[] } };
        if (!d.online) return say(`🔴 **${addr}** is offline`);
        return say(`🟢 **${addr}** is online\nPlayers: ${d.players?.online ?? 0}/${d.players?.max ?? "?"}\nVersion: ${d.version ?? "?"}`
          + (d.motd?.clean?.length ? `\n> ${d.motd.clean.join(" ").slice(0, 200)}` : ""));
      } catch {
        return say(`Couldn't check **${addr}** right now`);
      }
    }
    case "serverinfo": {
      if (!c.channel.server_id) return say("That only works in a server");
      const [{ data: s }, { count: members }, { count: channels }] = await Promise.all([
        db().from("servers").select("name, created_at, owner, description").eq("id", c.channel.server_id).single(),
        db().from("server_members").select("uuid", { count: "exact", head: true }).eq("server_id", c.channel.server_id),
        db().from("channels").select("id", { count: "exact", head: true }).eq("server_id", c.channel.server_id).neq("kind", "category"),
      ]);
      return say(`**${s?.name}**${s?.description ? `\n${s.description}` : ""}\nOwner: <@${s?.owner}>\nMembers: ${members}\nChannels: ${channels}\nCreated: ${String(s?.created_at).slice(0, 10)}`);
    }
    case "userinfo": {
      const id = String(args.user ?? "").match(/[0-9a-f]{32}/)?.[0] ?? c.user.uuid;
      const p = (await profilesById([id]))[id];
      if (!p) return say("I don't know them");
      let joined = "";
      if (c.channel.server_id) {
        const { data: m } = await db().from("server_members").select("joined_at").eq("server_id", c.channel.server_id).eq("uuid", id).maybeSingle();
        if (m) joined = `\nJoined this server: ${String(m.joined_at).slice(0, 10)}`;
      }
      return say(`**${p.name}**${p.minecraft_name ? `\nMinecraft: ${p.minecraft_name}` : ""}${p.handle ? `\nHandle: @${p.handle}` : ""}${p.jace_name ? `\nJace: ${p.jace_name}` : ""}${joined}`);
    }
  }
  return say(`I don't know /${name}`);
}

/** A bot as its owner sees it. */
export function ownBot(b: Profile) {
  return {
    ...publicProfile(b), bot_public: !!b.bot_public, bot_enabled: b.bot_enabled !== false,
    bot_commands: b.bot_commands ?? [], has_program: !!b.bot_program, has_code: !!b.bot_code,
  };
}

/** One of your bots (404 for anyone else's). */
export async function myBot(owner: Profile, id: string): Promise<Profile> {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new ApiError(404, "Bot not found");
  const { data } = await db().from("profiles").select("*").eq("uuid", id).eq("is_bot", true).eq("bot_owner", owner.uuid).maybeSingle();
  if (!data) throw new ApiError(404, "Bot not found");
  return data as Profile;
}
