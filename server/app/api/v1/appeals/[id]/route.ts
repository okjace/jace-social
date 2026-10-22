// One Jace ban appeal (staff only - lib/appeals.ts). {id} is the appealing person's Jace user id.
// GET ?since=: {appeal: {user_id, username, status, ban_reason, ...}, messages: [{id, from_id, from_name,
//   body, created_at}]}, oldest first (theirs have from_id = their id; replies are "Jace Official").
//   Opening it marks it read.
// POST {body, reply_id}: reply as Jace Official. Send the same reply_id when retrying: Jace skips it.
import { body, handler, me } from "@/lib/server";
import { appealThread, replyToAppeal } from "@/lib/appeals";

export const GET = handler(async (req, ctx) =>
  appealThread(await me(req), (await ctx.params).id, new URL(req.url).searchParams.get("since")));

export const POST = handler(async (req, ctx) => {
  const p = await me(req);
  const b = await body<{ body?: unknown; reply_id?: unknown }>(req);
  return replyToAppeal(p, (await ctx.params).id, b.body, b.reply_id);
});
