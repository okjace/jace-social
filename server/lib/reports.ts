// Reports: anyone can report a message, a person, a bot, a server, a group chat, a channel or a forum
// post to Jace Social's staff (Jace's admins and the
// Jace bot's owner - lib/jaceBot.ts isJaceStaff). Staff see them in Reports (components/Reports.tsx),
// then mute or ban (lib/moderation.ts), delete the message, or dismiss. The message is copied as it
// was when reported, so editing or deleting it doesn't hide what was reported.
// Table: reports (supabase/018_moderation.sql).
import { ApiError, cleanUuid, db, inboxesOf, JACE_BOT, notify, type Profile } from "./server";
import { channelFor, cleanId, loadChannelMessage, notifyChanged } from "./chat";

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

/** Report a message ({scope: d | c, message_id}), a person or bot (uuid), or {kind: server, server_id} /
 *  {kind: group | channel | post, channel_id}. */
export async function report(req: Request, p: Profile, b: { uuid?: string; scope?: string; message_id?: number; reason?: string; details?: string;
  kind?: string; server_id?: string; channel_id?: string }) {
  const reason = String(b.reason ?? "") as Reason;
  if (!REASONS.includes(reason)) throw new ApiError(400, "Pick a reason");
  const details = String(b.details ?? "").trim().slice(0, 1000) || null;
  // a few an hour is plenty (stops one person flooding staff)
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await db().from("reports").select("id", { count: "exact", head: true }).eq("reporter", p.uuid).gt("created_at", hourAgo);
  if ((count ?? 0) >= 10) throw new ApiError(429, "You've sent a lot of reports - try again in a while");

  const row: Record<string, unknown> = { reporter: p.uuid, reason, details, kind: "message" };
  if (b.kind === "server" && b.server_id) {
    const id = cleanId(b.server_id);
    const { data: s } = await db().from("servers").select("id, name, description, owner").eq("id", id).maybeSingle();
    if (!s) throw new ApiError(404, "Server not found");
    Object.assign(row, { kind: "server", server_id: s.id, target: s.owner, excerpt: [s.name, s.description].filter(Boolean).join(" - ") });
  } else if ((b.kind === "group" || b.kind === "channel" || b.kind === "post") && b.channel_id) {
    const { channel: ch } = await channelFor(b.channel_id, p.uuid);           // (checks they can see it)
    const kind = ch.kind === "post" ? "post" : ch.server_id ? "channel" : "group";
    let excerpt = ch.kind === "post" ? `${ch.name}${ch.topic ? `: ${ch.topic}` : ""}` : ch.server_id ? `#${ch.name}${ch.topic ? ` - ${ch.topic}` : ""}` : (ch.name ?? "a group chat");
    if (kind === "group") excerpt = `Group chat: ${excerpt}`;
    Object.assign(row, { kind, channel_id: ch.id, server_id: ch.server_id, target: kind === "channel" ? null : ch.owner, excerpt });
  } else if (b.scope === "d" && b.message_id) {
    const { data: m } = await db().from("messages").select("id, sender, recipient, body, attachments").eq("id", Number(b.message_id)).maybeSingle();
    if (!m || ![m.sender, m.recipient].includes(p.uuid)) throw new ApiError(404, "Message not found");
    Object.assign(row, { target: m.sender, scope: "d", message_id: m.id, excerpt: excerptOf(m) });
  } else if (b.scope === "c" && b.message_id) {
    const { m, channel } = await loadChannelMessage(req, String(b.message_id));     // (checks they can see it)
    if (!m.sender) throw new ApiError(400, "That message can't be reported");
    Object.assign(row, { target: m.sender, scope: "c", message_id: m.id, channel_id: channel.id, server_id: channel.server_id, excerpt: excerptOf(m) });
  } else if (b.uuid) {
    const uuid = cleanUuid(b.uuid);
    const { data: t } = await db().from("profiles").select("uuid, is_bot, bot_owner, bio").eq("uuid", uuid).maybeSingle();
    if (!t) throw new ApiError(404, "Player not found");
    Object.assign(row, { target: uuid, kind: t.is_bot ? "bot" : "person", excerpt: t.bio ?? null });
  } else {
    throw new ApiError(400, "What are you reporting?");
  }
  if (row.target === p.uuid && (row.kind === "person" || row.kind === "message")) throw new ApiError(400, "That's you");
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

/** Staff: close a report (resolved / dismissed), maybe deleting the reported message, or the reported
 *  post, channel, group chat or server (delete_target). */
export async function closeReport(by: Profile, id: number, b: { status?: string; resolution?: string; delete_message?: boolean; delete_target?: boolean }) {
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
  if (b.delete_target) {
    resolution = [resolution, await deleteReported(r)].filter(Boolean).join("; ");
  }
  await db().from("reports").update({
    status, resolution, resolved_by: status === "open" ? null : by.uuid, resolved_at: status === "open" ? null : new Date().toISOString(),
  }).eq("id", id);
  return { ok: true };
}

/** Staff deleting what a report is about. -> what was done */
async function deleteReported(r: { kind?: string | null; server_id?: string | null; channel_id?: string | null }): Promise<string> {
  if (r.kind === "server" && r.server_id) {
    const { data: members } = await db().from("server_members").select("uuid").eq("server_id", r.server_id);
    await db().from("servers").delete().eq("id", r.server_id);
    await notifyChanged((members ?? []).map((m) => m.uuid), "servers", { kind: "deleted", server_id: r.server_id });
    return "server deleted";
  }
  if ((r.kind === "group" || r.kind === "channel" || r.kind === "post") && r.channel_id) {
    const { data: ch } = await db().from("channels").select("id, server_id, parent_id, kind").eq("id", r.channel_id).maybeSingle();
    if (!ch) return "already gone";
    let who: string[] = [];
    if (ch.server_id) {
      const { data: sm } = await db().from("server_members").select("uuid").eq("server_id", ch.server_id);
      who = (sm ?? []).map((x) => x.uuid as string);
    } else {
      const { data: cm } = await db().from("channel_members").select("uuid").eq("channel_id", ch.id);
      who = (cm ?? []).map((x) => x.uuid as string);
    }
    if (ch.kind !== "post") await db().from("channels").update({ parent_id: null }).eq("parent_id", ch.id).neq("kind", "post");
    await db().from("channels").delete().eq("id", ch.id);
    if (ch.kind === "post") await notifyChanged(who, "channel", { channel_id: ch.parent_id, server_id: ch.server_id, post_id: ch.id, deleted: true });
    else if (ch.server_id) await notifyChanged(who, "servers", { kind: "changed", server_id: ch.server_id });
    else await notifyChanged(who, "groups", { kind: "deleted", id: ch.id });
    return `${r.kind} deleted`;
  }
  return "";
}
