// GET: a bot's public page (anyone): profile, owner, commands, and whether you can add it
// PATCH {name?, bio?, bot_public?, bot_enabled?, bot_commands?}: edit your bot
// DELETE: delete your bot (it leaves every server)
import { ApiError, body, db, handler, me, publicProfile, type Profile } from "@/lib/server";
import { cleanName, profilesById } from "@/lib/chat";
import { JACE_BOT, JACE_COMMANDS, ensureJaceBot, myBot, ownBot } from "@/lib/bots";
import { programCommands, type Program } from "@/lib/blocks";

export const GET = handler(async (req, ctx) => {
  const p = await me(req);
  const id = (await ctx.params).id;
  if (id === JACE_BOT) await ensureJaceBot();
  const { data } = await db().from("profiles").select("*").eq("uuid", id).eq("is_bot", true).maybeSingle();
  if (!data) throw new ApiError(404, "Bot not found");
  const b = data as Profile;
  if (!b.bot_public && b.bot_owner !== p.uuid) throw new ApiError(404, "Bot not found");
  const owner = b.bot_owner ? (await profilesById([b.bot_owner]))[b.bot_owner] : null;
  const commands = b.uuid === JACE_BOT ? JACE_COMMANDS : [...programCommands(b.bot_program as Program), ...((b.bot_commands ?? []) as typeof JACE_COMMANDS)];
  return {
    bot: b.bot_owner === p.uuid ? ownBot(b) : publicProfile(b), owner, commands, official: b.uuid === JACE_BOT,
    program: b.bot_owner === p.uuid ? b.bot_program ?? null : null,
    code: b.bot_owner === p.uuid ? b.bot_code ?? null : null,
  };
});

export const PATCH = handler(async (req, ctx) => {
  const p = await me(req);
  const bot = await myBot(p, (await ctx.params).id);
  const b = await body<{ name?: string; bio?: string | null; bot_public?: boolean; bot_enabled?: boolean; bot_commands?: unknown[] }>(req);
  if (bot.uuid === JACE_BOT && (b.bot_public === false || b.bot_enabled === false))
    throw new ApiError(400, "The official Jace bot stays public and on");
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) patch.name = cleanName(b.name, "Bot name", 32);
  if (b.bio !== undefined) {
    const t = String(b.bio ?? "").trim();
    if (t.length > 300) throw new ApiError(400, "Descriptions can be up to 300 characters");
    patch.bio = t || null;
  }
  if (b.bot_public !== undefined) patch.bot_public = Boolean(b.bot_public);
  if (b.bot_enabled !== undefined) patch.bot_enabled = Boolean(b.bot_enabled);
  if (b.bot_commands !== undefined) {
    if (!Array.isArray(b.bot_commands) || b.bot_commands.length > 50) throw new ApiError(400, "Up to 50 commands");
    patch.bot_commands = b.bot_commands.map((c) => {
      const x = c as { name?: string; description?: string; options?: { name?: string; description?: string; required?: boolean }[] };
      if (!/^[a-z0-9_-]{1,32}$/.test(String(x.name))) throw new ApiError(400, "Command names use lowercase letters, numbers, - and _");
      return {
        name: x.name, description: String(x.description ?? "").slice(0, 100),
        options: (x.options ?? []).slice(0, 10).map((o) => ({ name: String(o.name ?? "").slice(0, 32), description: String(o.description ?? "").slice(0, 100), required: !!o.required })),
      };
    });
  }
  const { data } = await db().from("profiles").update(patch).eq("uuid", bot.uuid).select("*").single();
  return { bot: ownBot(data as Profile) };
});

export const DELETE = handler(async (req, ctx) => {
  const p = await me(req);
  const bot = await myBot(p, (await ctx.params).id);
  if (bot.uuid === JACE_BOT) throw new ApiError(400, "The official Jace bot can't be deleted");
  await db().from("profiles").delete().eq("uuid", bot.uuid);
  return { ok: true };
});
