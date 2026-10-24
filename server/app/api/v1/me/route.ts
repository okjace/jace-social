// GET: your own profile (everything friends see, plus account details)
// PATCH {display_name?, handle?, bio?, pronouns?, accent_color?, links?, status?, custom_status?, status_emoji?}
//   handle: your unique @name (3-20: letters, numbers, _ and .), changeable once every 7 days
// DELETE: delete your account (ask the Jace bot). Only with a session from signing in again in the last
//   10 minutes. -> {recovery_id, expires_at}: pasting the recovery ID to the Jace bot from a new account
//   within 10 days brings it all back (lib/accountDeletion.ts)
// DELETE ?now=1: the same, but deleted right away and for good -> {deleted_for_good: true}
import { connectionInfo } from "@/lib/jaceSync";
import { deleteAccount } from "@/lib/accountDeletion";
import { appealsFlag } from "@/lib/appeals";
import { MAX_LINKS, socialOf } from "@/lib/socialLinks";
import { pushProfileToJace } from "@/lib/jaceAdmin";
import { isJaceStaff, welcomeOnce } from "@/lib/jaceBot";
import { ApiError, body, checkHandle, db, friendsOf, handler, HANDLE_COOLDOWN_DAYS, me, notify, publicProfile, supabaseUrl,
  type Profile } from "@/lib/server";

function own(p: Profile) {
  return {
    ...publicProfile({ ...p, status: p.status === "invisible" ? "online" : p.status }),
    status: p.status ?? "online",                   // your real choice, even when invisible
    display_name: p.display_name ?? null,
    minecraft_linked: p.mc_linked !== false, jace_linked: !!p.jace_sub, jace_name: p.jace_name ?? null,
    inbox: p.inbox, realtime: { url: supabaseUrl(), key: process.env.SUPABASE_PUBLISHABLE_KEY },
    settings: p.settings ?? {}, onboarded: !!p.onboarded_at || !!p.is_bot,
    handle_change_at: handleChangeAt(p),             // when you can change your handle again (null: now)
  };
}

function handleChangeAt(p: Profile): string | null {
  if (!p.handle_changed_at) return null;
  const next = new Date(p.handle_changed_at).getTime() + HANDLE_COOLDOWN_DAYS * 86400_000;
  return next > Date.now() ? new Date(next).toISOString() : null;
}

const soundChoice = (v: unknown) => (typeof v === "string" && (/^builtin:[a-z]{2,20}$/.test(v)
  || v.startsWith(`${supabaseUrl()}/storage/v1/object/public/sounds/`)) ? v : null);

// Private settings that follow you to every device. Unknown keys are dropped.
const SETTINGS: Record<string, (v: unknown) => unknown> = {
  theme: (v) => (["dark", "light", "midnight", "forest", "system"].includes(String(v)) ? v : "dark"),
  accent: (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v)) ? v : null),
  font_scale: (v) => Math.max(0.8, Math.min(1.4, Number(v) || 1)),
  compact: (v) => Boolean(v),
  reduce_motion: (v) => Boolean(v),
  show_embeds: (v) => v !== false,
  show_avatars: (v) => v !== false,
  sounds: (v) => v !== false,
  desktop_notifications: (v) => v !== false,
  notify: (v) => (["all", "mentions", "none"].includes(String(v)) ? v : "all"),
  link_warning: (v) => v !== false,
  trusted_domains: (v) => (Array.isArray(v) ? v.map((d) => String(d).toLowerCase().trim()).filter((d) => /^[a-z0-9.-]{1,253}$/.test(d)).slice(0, 100) : []),
  muted: (v) => (Array.isArray(v) ? v.map(String).filter((x) => /^[0-9a-f-]{32,36}$/.test(x)).slice(0, 500) : []),
  time_format: (v) => (["12h", "24h"].includes(String(v)) ? v : "12h"),
  send_on_enter: (v) => v !== false,
  developer: (v) => Boolean(v),
  // Appearance: a background picture (only one uploaded to /me/background), how solid the panels
  // stay over it, and your own CSS (applied only in your own app)
  background: (v) => (typeof v === "string" && v.startsWith(`${supabaseUrl()}/storage/v1/object/public/avatars/backgrounds/`) ? v : null),
  background_opacity: (v) => Math.max(0.2, Math.min(1, Number(v) || 0.8)),
  custom_css: (v) => String(v ?? "").slice(0, 20_000),
  // call sounds (lib/sounds.ts): a built-in one, or a sound file uploaded to Jace Social
  ringtone: (v) => soundChoice(v),
  calling_sound: (v) => soundChoice(v),
  message_sound: (v) => soundChoice(v),
  // privacy: anyone can find you (Find people) and message you without being friends; your profile
  // page (jace-social.vercel.app/u/<handle>) can be seen by anyone with the link
  open_dms: (v) => v === true,
  public_profile: (v) => v === true,
  message_sound_when: (v) => (["always", "other_chats", "away", "never"].includes(String(v)) ? v : "always"),
};

export const GET = handler(async (req) => {
  const p = await me(req);
  await welcomeOnce(p);                              // the Jace bot's first message to them (lib/jaceBot.ts)
  // Jace-linked people: whether their Jace messages are connected (Settings -> Accounts)
  // these may ask Jace (when not remembered): at the same time, not one after another
  const [jace_messages, jace_staff, appeals] = await Promise.all([
    p.jace_sub ? connectionInfo(p.uuid) : null, isJaceStaff(p),
    appealsFlag(p),                                  // Jace ban appeals inbox: staff | reconnect | none (lib/appeals.ts)
  ]);
  return { ...own(p), jace_messages, jace_staff, appeals };
});

const STATUSES = ["online", "idle", "dnd", "invisible"];
const text = (v: unknown, max: number, field: string) => {
  if (v === null || v === "") return null;
  if (typeof v !== "string") throw new ApiError(400, `${field} must be text`);
  const t = v.trim();
  if (t.length > max) throw new ApiError(400, `${field} can be up to ${max} characters`);
  return t || null;
};

export const PATCH = handler(async (req) => {
  const p = await me(req);
  const b = await body<Record<string, unknown>>(req);
  const patch: Partial<Profile> = {};
  if ("display_name" in b) patch.display_name = text(b.display_name, 32, "Display name");
  if ("handle" in b) {
    const h = checkHandle(b.handle);
    if (h !== p.handle) {
      if (!("handle" in p)) throw new ApiError(503, "Handles aren't set up yet - run supabase/006_handles.sql first");
      const wait = handleChangeAt(p);
      if (wait) throw new ApiError(429, `You can change your handle again on ${new Date(wait).toUTCString().slice(0, 16)}`);
      const { data: taken } = await db().from("profiles").select("uuid").eq("handle", h).neq("uuid", p.uuid).limit(1).maybeSingle();
      if (taken) throw new ApiError(409, `@${h} is taken`);
      patch.handle = h;
      patch.handle_changed_at = new Date().toISOString();
    }
  }
  if ("bio" in b) patch.bio = text(b.bio, 300, "Bio");
  if ("pronouns" in b) patch.pronouns = text(b.pronouns, 24, "Pronouns");
  if ("custom_status" in b) patch.custom_status = text(b.custom_status, 80, "Custom status");
  if ("status_emoji" in b) patch.status_emoji = text(b.status_emoji, 16, "Status emoji");
  if ("accent_color" in b) {
    const c = text(b.accent_color, 7, "Color");
    if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) throw new ApiError(400, "Color must look like #3ddc84");
    patch.accent_color = c;
  }
  if ("status" in b) {
    if (!STATUSES.includes(String(b.status))) throw new ApiError(400, "Status must be online, idle, dnd or invisible");
    patch.status = b.status as Profile["status"];
  }
  if ("links" in b) {
    if (!Array.isArray(b.links) || b.links.length > MAX_LINKS) throw new ApiError(400, `Up to ${MAX_LINKS} profile links`);
    patch.links = b.links.map((l) => {
      const label = text((l as { label?: unknown })?.label, 32, "Link name") ?? "";
      const url = text((l as { url?: unknown })?.url, 300, "Link") ?? "";
      if (!/^https?:\/\/[^\s]+\.[^\s]+$/i.test(url)) throw new ApiError(400, `"${url}" isn't a web link (https://...)`);
      const site = socialOf(url);                  // no name given: the site's (YouTube...), or the address
      return { label: label || (site.id !== "website" ? site.name : new URL(url).hostname.replace(/^www\./, "")), url };
    });
  }
  if ("settings" in b) {
    const incoming = (b.settings ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...(p.settings ?? {}) };
    for (const [k, v] of Object.entries(incoming)) if (SETTINGS[k]) merged[k] = SETTINGS[k](v);
    if (JSON.stringify(merged).length > 40_000) throw new ApiError(400, "Too many settings");
    patch.settings = merged;
  }
  if (b.onboarded === true) patch.onboarded_at = p.onboarded_at ?? new Date().toISOString();
  if (!Object.keys(patch).length) {
    if ("handle" in b) return own(p);               // the handle you already have
    throw new ApiError(400, "Nothing to change");
  }
  const { data, error } = await db().from("profiles").update(patch).eq("uuid", p.uuid).select("*").single();
  if (error?.code === "23505") throw new ApiError(409, `@${patch.handle} is taken`);    // someone got it a moment ago
  if (error) throw error;
  const friends = await friendsOf(p.uuid);
  await notify(friends.map((f) => f.inbox), "presence", { uuid: p.uuid });
  if (patch.handle) pushProfileToJace(p, { handle: patch.handle as string });   // your Jace username follows (lib/jaceAdmin.ts)
  return own(data as Profile);
});

export const DELETE = handler(async (req) => deleteAccount(await me(req), req, new URL(req.url).searchParams.get("now") === "1"));
