// Reports: anyone can report a message, or a person, to Jace Social's staff (Jace's admins and the
// Jace bot's owner - lib/jaceBot.ts isJaceStaff). Staff see them in Reports (components/Reports.tsx),
// then mute or ban (lib/moderation.ts), delete the message, or dismiss. The message is copied as it
// was when reported, so editing or deleting it doesn't hide what was reported.
// Table: reports (supabase/018_moderation.sql).
import { ApiError, cleanUuid, db, inboxesOf, JACE_BOT, notify, type Profile } from "./server";
import { loadChannelMessage } from "./chat";

export const REASONS = ["spam", "harassment", "hate", "sexual", "violence", "scam", "other"] as const;
export type Reason = (typeof REASONS)[number];
export const REASON_NAMES: Record<Reason, string> = {
  spam: "Spam", harassment: "Harassment or bullying", hate: "Hate", sexual: "Sexual content",
  violence: "Violence or threats", scam: "Scam or phishing", other: "Something else",
};

/** Everyone who answers reports: the Jace bot's owner and Jace's admins (as last checked), their inboxes. */
async function staffInboxes(): Promise<string[]> {
  const ids = new Set<string>();
  const { data: bot } = await db().from("profiles").select("bot_owner").eq("uuid", JACE_BOT).maybeSingle();
  if (bot?.bot_owner) ids.add(bot.bot_owner);
  const { data: admins } = await db().from("jace_admins").select("uuid").eq("is_admin", true);
  for (const a of admins ?? []) ids.add(a.uuid);
  return ids.size ? inboxesOf([...ids]) : [];
}

/** Report a message ({scope: d | c, id}) or a person (uuid). */
export async function report(req: Request, p: Profile, b: { uuid?: string; scope?: string; message_id?: number; reason?: string; details?: string }) {
  const reason = String(b.reason ?? "") as Reason;
  if (!REASONS.includes(reason)) throw new ApiError(400, "Pick a reason");
  const details = String(b.details ?? "").trim().slice(0, 1000) || null;
  // a few an hour is plenty (stops one person flooding staff)
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await db().from("reports").select("id", { count: "exact", head: true }).eq("reporter", p.uuid).gt("created_at", hourAgo);
  if ((count ?? 0) >= 10) throw new ApiError(429, "You've sent a lot of reports - try again in a while");

  const row: Record<string, unknown> = { reporter: p.uuid, reason, details };
  if (b.scope === "d" && b.message_id) {
    const { data: m } = await db().from("messages").select("id, sender, recipient, body, attachments").eq("id", Number(b.message_id)).maybeSingle();
    if (!m || ![m.sender, m.recipient].includes(p.uuid)) throw new ApiError(404, "Message not found");
    Object.assign(row, { target: m.sender, scope: "d", message_id: m.id, excerpt: excerptOf(m) });
  } else if (b.scope === "c" && b.message_id) {
    const { m, channel } = await loadChannelMessage(req, String(b.message_id));     // (checks they can see it)
    if (!m.sender) throw new ApiError(400, "That message can't be reported");
    Object.assign(row, { target: m.sender, scope: "c", message_id: m.id, channel_id: channel.id, server_id: channel.server_id, excerpt: excerptOf(m) });
  } else if (b.uuid) {
    const uuid = cleanUuid(b.uuid);
    const { data: t } = await db().from("profiles").select("uuid").eq("uuid", uuid).maybeSingle();
    if (!t) throw new ApiError(404, "Player not found");
    row.target = uuid;
  } else {
    throw new ApiError(400, "What are you reporting?");
  }
  if (row.target === p.uuid) throw new ApiError(400, "That's you");
  if (row.target === JACE_BOT) throw new ApiError(400, "The Jace bot can't be reported - tell it what went wrong instead");
  const { data, error } = await db().from("reports").insert(row).select("id").single();
  if (error) throw new ApiError(503, "Reports aren't set up yet - run supabase/018_moderation.sql");
  const inboxes = await staffInboxes();
  if (inboxes.length) await notify(inboxes, "report", { id: data.id, reason });
  return { ok: true, id: data.id };
}

function excerptOf(m: { body?: string | null; attachments?: { name?: string }[] | null }) {
  const files = (m.attachments ?? []).map((a) => `[file: ${a.name ?? "file"}]`).join(" ");
  return [m.body ?? "", files].filter(Boolean).join(" ").slice(0, 2000);
}

/** Staff: the reports (open ones first), with who reported whom. */
export async function listReports(status: "open" | "all") {
  let q = db().from("reports").select("*").order("created_at", { ascending: false }).limit(100);
  if (status === "open") q = q.eq("status", "open");
  const { data, error } = await q;
  if (error) throw new ApiError(503, "Reports aren't set up yet - run supabase/018_moderation.sql");
  const ids = [...new Set((data ?? []).flatMap((r) => [r.reporter, r.target, r.resolved_by]).filter(Boolean))] as string[];
  const { data: people } = ids.length
    ? await db().from("profiles").select("uuid, name, display_name, handle, avatar_url, banned_at, ban_until, muted_at, mute_until").in("uuid", ids)
    : { data: [] };
  const { count: open } = await db().from("reports").select("id", { count: "exact", head: true }).eq("status", "open");
  return { reports: data ?? [], people: Object.fromEntries((people ?? []).map((x) => [x.uuid, x])), open: open ?? 0 };
}

/** Staff: close a report (resolved / dismissed), maybe deleting the reported message. */
export async function closeReport(by: Profile, id: number, b: { status?: string; resolution?: string; delete_message?: boolean }) {
  const { data: r } = await db().from("reports").select("*").eq("id", id).maybeSingle();
  if (!r) throw new ApiError(404, "Report not found");
  const status = b.status === "dismissed" ? "dismissed" : b.status === "open" ? "open" : "resolved";
  let resolution = String(b.resolution ?? "").trim().slice(0, 300) || null;
  if (b.delete_message && r.message_id) {
    if (r.scope === "d") {
      const { data: m } = await db().from("messages").select("sender, recipient").eq("id", r.message_id).maybeSingle();
      await db().from("messages").delete().eq("id", r.message_id);
      await db().from("message_reactions").delete().eq("scope", "d").eq("message_id", r.message_id);
      if (m) await notify(await inboxesOf([m.sender, m.recipient]), "dm_update", { from: m.sender, with: m.recipient, id: r.message_id, deleted: true });
    } else {
      const { data: m } = await db().from("channel_messages").select("channel_id").eq("id", r.message_id).maybeSingle();
      await db().from("channel_messages").delete().eq("id", r.message_id);
      await db().from("message_reactions").delete().eq("scope", "c").eq("message_id", r.message_id);
      if (m) {
        const { data: members } = await db().from("channel_members").select("uuid").eq("channel_id", m.channel_id);
        const { data: ch } = await db().from("channels").select("server_id").eq("id", m.channel_id).maybeSingle();
        let who = (members ?? []).map((x) => x.uuid as string);
        if (ch?.server_id) {
          const { data: sm } = await db().from("server_members").select("uuid").eq("server_id", ch.server_id);
          who = (sm ?? []).map((x) => x.uuid as string);
        }
        await notify(await inboxesOf(who), "channel", { channel_id: m.channel_id, server_id: ch?.server_id ?? null, id: r.message_id, deleted: true });
      }
    }
    resolution = [resolution, "message deleted"].filter(Boolean).join("; ");
  }
  await db().from("reports").update({
    status, resolution, resolved_by: status === "open" ? null : by.uuid, resolved_at: status === "open" ? null : new Date().toISOString(),
  }).eq("id", id);
  return { ok: true };
}
