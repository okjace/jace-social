// Decide a Jace ban appeal (staff only, checked with Jace again right now - lib/appeals.ts).
// POST {action: "unban", reason?}: lifts the ban on Jace (its moderation API, as Jace Social) -> {result}
// POST {action: "keep", body, reply_id}: keeps it - just a reply as Jace Official.
// Mutes can't be lifted from here (Jace's API can't), only answered.
import { body, handler, me } from "@/lib/server";
import { decideAppeal } from "@/lib/appeals";

export const POST = handler(async (req, ctx) =>
  decideAppeal(await me(req), (await ctx.params).id, await body(req)));
