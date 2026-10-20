// POST: link a Jace account to the signed-in (Minecraft) player -> {url, state, poll_key}.
//       Open url in a browser, then poll /api/v1/auth/jace/poll. Also "Connect / Reconnect your
//       Jace messages" for people already linked: it keeps a fresh token (lib/jaceSync.ts).
// DELETE: unlink Jace (only when Minecraft can still sign in).
import { ApiError, db, handler, me } from "@/lib/server";
import { startJace } from "@/lib/oauthFlow";
import { disconnect } from "@/lib/jaceSync";

export const POST = handler(async (req) => {
  const p = await me(req);
  return startJace("link", { linkUuid: p.uuid, poll: true });
});

export const DELETE = handler(async (req) => {
  const p = await me(req);
  if (p.mc_linked === false) throw new ApiError(400, "Jace is how you sign in - link Minecraft first");
  await disconnect(p.uuid);                          // the Jace token goes too
  await db().from("profiles").update({ jace_sub: null, jace_name: null }).eq("uuid", p.uuid);
  return { ok: true };
});
