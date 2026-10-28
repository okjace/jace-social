// Moderation of accounts on all of Jace Social, by its staff (Jace's admins, the Jace bot's owner):
// lib/moderation.ts. Server bans and timeouts are separate (servers/[id]/bans, members).
// GET ?uuid=: their ban / mute right now, and how many times Jace's auto moderation blocked them
// POST {uuid, action: ban | unban | mute | unmute, duration?: "10m"|"1h"|"6h"|"1d"|"3d"|"1w"|"30d"|"forever"|minutes,
//       reason?, jace?: boolean (do the same to their Jace account)}
import { ApiError, body, cleanUuid, db, handler, me } from "@/lib/server";
import { ban, muteAccount, requireJaceStaff, unban, unmuteAccount } from "@/lib/jaceBot";
import { duration, isBanned, isMuted } from "@/lib/moderation";

export const GET = handler(async (req) => {
  await requireJaceStaff(await me(req));
  const uuid = cleanUuid(new URL(req.url).searchParams.get("uuid"));
  const { data: t } = await db().from("profiles")
    .select("uuid, jace_sub, banned_at, ban_until, ban_reason, ban_from, muted_at, mute_until, mute_reason, mute_from").eq("uuid", uuid).maybeSingle();
  if (!t) throw new ApiError(404, "Player not found");
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const [{ count: blocked }, { count: reports }] = await Promise.all([
    db().from("automod_log").select("id", { count: "exact", head: true }).eq("uuid", uuid).gt("created_at", since),
    db().from("reports").select("id", { count: "exact", head: true }).eq("target", uuid),
  ]);
  return {
    jace_linked: !!t.jace_sub,
    banned: isBanned(t), ban_until: t.ban_until, ban_reason: t.ban_reason, ban_from: t.ban_from,
    muted: isMuted(t), mute_until: t.mute_until, mute_reason: t.mute_reason, mute_from: t.mute_from,
    automod_blocks_30d: blocked ?? 0, reports: reports ?? 0,
  };
});

export const POST = handler(async (req) => {
  const p = await me(req);
  await requireJaceStaff(p);
  const b = await body<{ uuid?: string; action?: string; duration?: unknown; reason?: string; jace?: boolean }>(req);
  const uuid = cleanUuid(b.uuid);
  const minutes = duration(b.duration);
  const reason = String(b.reason ?? "");
  const jace = b.jace === true;
  switch (b.action) {
    case "ban": return ban(p, uuid, reason, jace, minutes);
    case "unban": return unban(uuid, jace);
    case "mute": return muteAccount(p, uuid, reason, jace, minutes);
    case "unmute": return unmuteAccount(uuid, jace);
    default: throw new ApiError(400, "action must be ban, unban, mute or unmute");
  }
});
