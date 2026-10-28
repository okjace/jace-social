// GET: a server with its channels (the ones you can see, with unread counts and your permissions
//      in each), roles, members, voice rooms, and your own permissions
// PATCH {name?, description?, vanity?, banner?, accent_color?, rules?, welcome?, onboarding?,
//        system_channel?, invites_paused?}: server settings (manage server)
// DELETE: delete the server (owner)
import { checkName } from "@/lib/automod";
import { ApiError, body, db, handler, me } from "@/lib/server";
import { cleanId, cleanName, notifyChanged, profilesById, unreadCounts, type Channel } from "@/lib/chat";
import { channelPerms, has, legacyRole, need, overridesFor, P, serverCtx } from "@/lib/perms";

export const GET = handler(async (req, ctx) => {
  const p = await me(req);
  const id = cleanId((await ctx.params).id);
  const sc = await serverCtx(id, p.uuid);
  const [{ data: chans }, { data: members }, { data: memberRoles }] = await Promise.all([
    db().from("channels").select("*").eq("server_id", id).order("position").order("created_at"),
    db().from("server_members").select("uuid, role, joined_at, nickname, timeout_until, onboarded").eq("server_id", id),
    db().from("server_member_roles").select("uuid, role_id").eq("server_id", id),
  ]);
  const voiceIds = (chans ?? []).filter((c) => c.kind === "voice").map((c) => c.id);
  const { data: voice } = voiceIds.length
    ? await db().from("voice_states").select("channel_id, uuid, muted, deafened, streaming, last_seen").in("channel_id", voiceIds)
    : { data: [] as { channel_id: string; uuid: string; muted: boolean; deafened: boolean; streaming: boolean; last_seen: string }[] };
  const all = (chans ?? []) as Channel[];
  const overrides = await overridesFor(all.map((c) => c.id));
  const visible = all.map((c) => ({ ...c, perms: channelPerms(sc, c, overrides) }))
    .filter((c) => has(c.perms, P.VIEW) || (c.kind === "category" && all.some((x) => x.parent_id === c.id && has(channelPerms(sc, x, overrides), P.VIEW))));
  const people = await profilesById((members ?? []).map((m) => m.uuid));
  const unread = await unreadCounts(p.uuid, visible.filter((c) => c.kind !== "category" && c.kind !== "voice").map((c) => c.id));
  const fresh = Date.now() - 45_000;
  const mine = (memberRoles ?? []);
  const canManage = has(sc.base, P.MANAGE_SERVER);
  return {
    server: {
      ...sc.server,
      invite_code: has(sc.base, P.INVITE) ? sc.server.invite_code : null,
    },
    role: legacyRole(sc),                     // for older clients
    perms: sc.base,
    owner: sc.owner,
    top: sc.top === Infinity ? 1e9 : sc.top,
    roles: sc.roles,
    channels: visible.map((c) => ({ ...c, unread: unread[c.id] ?? 0 })),
    overrides: canManage || has(sc.base, P.MANAGE_ROLES) ? overrides : [],
    members: (members ?? []).map((m) => ({
      ...people[m.uuid], role: m.role, joined_at: m.joined_at, nickname: m.nickname,
      timeout_until: m.timeout_until, roles: mine.filter((r) => r.uuid === m.uuid).map((r) => r.role_id),
    })),
    voice: (voice ?? []).filter((v) => visible.some((c) => c.id === v.channel_id) && new Date(v.last_seen).getTime() > fresh),
    onboarded: (members ?? []).find((m) => m.uuid === p.uuid)?.onboarded ?? true,
  };
});

const VANITY = /^[a-z0-9-]{3,32}$/;
// paths the site itself uses can't be server links
const RESERVED = new Set(["app", "api", "invite", "demo", "login", "admin", "settings", "bots", "jace", "about", "help",
  "download", "terms", "privacy", "static", "public", "favicon-ico", "robots-txt", "_next", "i", "s", "u"]);

function text(v: unknown, max: number, what: string): string | null {
  const s = String(v ?? "").trim();
  if (s.length > max) throw new ApiError(400, `${what} can be up to ${max} characters`);
  return s || null;
}

export const PATCH = handler(async (req, ctx) => {
  const p = await me(req);
  const id = cleanId((await ctx.params).id);
  const sc = await serverCtx(id, p.uuid);
  need(sc.base, P.MANAGE_SERVER);
  const b = await body<Record<string, unknown>>(req);
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) { patch.name = cleanName(b.name, "Server name"); await checkName(p, "a server's name", patch.name as string); }
  if (b.description !== undefined) patch.description = text(b.description, 300, "Descriptions");
  if (b.rules !== undefined) patch.rules = text(b.rules, 2000, "Rules");
  if (b.accent_color !== undefined) {
    if (b.accent_color !== null && !/^#[0-9a-fA-F]{6}$/.test(String(b.accent_color))) throw new ApiError(400, "Pick a color like #3ddc84");
    patch.accent_color = b.accent_color;
  }
  if (b.vanity !== undefined) {
    const v = String(b.vanity ?? "").trim().toLowerCase();
    if (v && (!VANITY.test(v) || RESERVED.has(v))) throw new ApiError(400, "Server links use 3-32 lowercase letters, numbers and dashes");
    if (v) {
      const { data: taken } = await db().from("servers").select("id").eq("vanity", v).neq("id", id).maybeSingle();
      if (taken) throw new ApiError(409, "That link is taken");
    }
    patch.vanity = v || null;
  }
  if (b.invites_paused !== undefined) patch.invites_paused = Boolean(b.invites_paused);
  if (b.system_channel !== undefined) {
    if (b.system_channel) {
      const { data: c } = await db().from("channels").select("id").eq("id", cleanId(b.system_channel)).eq("server_id", id).maybeSingle();
      if (!c) throw new ApiError(400, "Pick a channel in this server");
    }
    patch.system_channel = b.system_channel || null;
  }
  if (b.welcome !== undefined) {
    const w = (b.welcome ?? {}) as { message?: string; channels?: { id: string; description?: string; emoji?: string }[] };
    patch.welcome = {
      message: text(w.message, 300, "The welcome message"),
      channels: (w.channels ?? []).slice(0, 5).map((c) => ({ id: cleanId(c.id), description: text(c.description, 60, "Descriptions"), emoji: text(c.emoji, 16, "Emojis") })),
    };
  }
  if (b.onboarding !== undefined) {
    const qs = (b.onboarding ?? []) as { question?: string; multiple?: boolean; options?: { label?: string; emoji?: string; role_ids?: string[]; channel_ids?: string[] }[] }[];
    if (!Array.isArray(qs) || qs.length > 5) throw new ApiError(400, "Up to 5 onboarding questions");
    const roleIds = new Set(sc.roles.filter((r) => !r.is_default).map((r) => r.id));
    patch.onboarding = qs.map((q) => ({
      question: cleanName(q.question, "Question", 100),
      multiple: Boolean(q.multiple),
      options: (q.options ?? []).slice(0, 10).map((o) => ({
        label: cleanName(o.label, "Answer", 50), emoji: text(o.emoji, 16, "Emojis"),
        role_ids: (o.role_ids ?? []).filter((r) => roleIds.has(r)).slice(0, 5),
      })),
    }));
  }
  if (Object.keys(patch).length) {
    const { error } = await db().from("servers").update(patch).eq("id", id);
    if (error) throw new ApiError(400, error.message.includes("vanity") ? "That link is taken" : error.message);
  }
  const { data: members } = await db().from("server_members").select("uuid").eq("server_id", id);
  await notifyChanged((members ?? []).map((m) => m.uuid), "servers", { kind: "changed", server_id: id });
  return { ok: true };
});

export const DELETE = handler(async (req, ctx) => {
  const p = await me(req);
  const id = cleanId((await ctx.params).id);
  const sc = await serverCtx(id, p.uuid);
  if (!sc.owner) throw new ApiError(403, "Only the owner can delete the server");
  const { data: members } = await db().from("server_members").select("uuid").eq("server_id", id);
  await db().from("servers").delete().eq("id", id);
  await notifyChanged((members ?? []).map((m) => m.uuid), "servers", { kind: "deleted", server_id: id });
  return { ok: true };
});
