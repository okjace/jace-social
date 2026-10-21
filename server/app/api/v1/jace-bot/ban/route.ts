// Bans from the whole of Jace Social, by the official Jace bot (lib/jaceBot.ts).
// POST {uuid, reason?, jace?: boolean}: ban them: signed out everywhere, can't sign in again;
//   jace: also ban their linked Jace account (Jace's moderation API)
//   -> {banned, jace_banned, jace_error}
// DELETE ?uuid=&jace=1: unban (jace=1: on Jace too)
import { ApiError, body, cleanUuid, handler, me } from "@/lib/server";
import { ban, requireJaceStaff, unban } from "@/lib/jaceBot";

export const POST = handler(async (req) => {
  const p = await me(req);
  await requireJaceStaff(p);
  const b = await body<{ uuid?: string; reason?: string; jace?: boolean }>(req);
  if (!b.uuid) throw new ApiError(400, "Who?");
  return ban(p, cleanUuid(b.uuid), String(b.reason ?? ""), b.jace !== false);
});

export const DELETE = handler(async (req) => {
  await requireJaceStaff(await me(req));
  const sp = new URL(req.url).searchParams;
  return unban(cleanUuid(sp.get("uuid")), sp.get("jace") === "1");
});
