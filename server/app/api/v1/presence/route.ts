// POST {activity} every ~2 minutes while the launcher or game is open.
// activity: {type: launcher|playing|hosting|app, instance?, version?, loader?, modpack?, server?, world?,
//            address?, details?, state?, started_at?, app?} or null to go offline.
import { ApiError, body, db, friendsOf, handler, isOnline, me, notify, type Activity } from "@/lib/server";
import { freshGamesActivity } from "@/lib/gamesIntegration";

const clip = (v: unknown, n = 80) => (typeof v === "string" ? v.slice(0, n) : undefined);

export const POST = handler(async (req) => {
  const p = await me(req);
  const b = await body<{ activity?: Activity | null; offline?: boolean; app?: boolean }>(req);
  // The Jace Social app (web/desktop) is the "weakest" presence: while the launcher or the
  // game is reporting something richer (or Jace Games says what you're playing), the app only
  // keeps you online and never overrides it.
  const fromApp = b.app === true || b.activity?.type === "app";
  if (fromApp && isOnline(p) && p.activity && (p.activity.type !== "app" || freshGamesActivity(p.activity))) {
    if (!b.offline) await db().from("profiles").update({ last_seen: new Date().toISOString() }).eq("uuid", p.uuid);
    return { ok: true };
  }
  let activity: Activity | null = null;
  if (!b.offline && b.activity) {
    if (!["launcher", "playing", "hosting", "app"].includes(b.activity.type)) throw new ApiError(400, "Bad activity type");
    const a = b.activity;
    const started = typeof a.started_at === "string" && !isNaN(Date.parse(a.started_at)) ? new Date(a.started_at).toISOString() : undefined;
    activity = {
      type: a.type, instance: clip(a.instance), version: clip(a.version, 32), loader: clip(a.loader, 24),
      modpack: clip(a.modpack), server: clip(a.server, 255), world: clip(a.world), address: clip(a.address, 255),
      details: clip(a.details, 128), state: clip(a.state, 128), started_at: started, app: clip(a.app, 24),
    };
    // drop empty fields so clients can tell "not set" from ""
    for (const k of Object.keys(activity) as (keyof Activity)[]) if (activity[k] === undefined || activity[k] === "") delete activity[k];
  }
  const wasOnline = isOnline(p);
  const last_seen = b.offline ? null : new Date().toISOString();
  await db().from("profiles").update({ activity, last_seen }).eq("uuid", p.uuid);
  // tell friends only when something visible changed (keeps notifications low)
  if (wasOnline === !!b.offline || JSON.stringify(p.activity) !== JSON.stringify(activity)) {
    const friends = await friendsOf(p.uuid);
    await notify(friends.map((f) => f.inbox), "presence", { uuid: p.uuid });
  }
  return { ok: true };
});
