// POST: sign in as your bot (for the account switcher) -> {token, uuid, name}. The official Jace bot:
// its owner and the people running it (Jace's admins too - lib/jaceBot.ts isJaceStaff).
import { createSession, handler, JACE_BOT, me } from "@/lib/server";
import { ensureJaceBot, myBot } from "@/lib/bots";
import { isJaceStaff } from "@/lib/jaceBot";

export const POST = handler(async (req, ctx) => {
  const p = await me(req);
  const id = (await ctx.params).id;
  const bot = id === JACE_BOT && !p.is_bot && (await isJaceStaff(p)) ? await ensureJaceBot() : await myBot(p, id);
  const s = await createSession(bot.uuid);
  return { ...s, uuid: bot.uuid, name: bot.name, avatar_url: bot.avatar_url ?? null };
});
