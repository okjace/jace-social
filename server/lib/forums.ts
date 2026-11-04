// Forums (and media channels) in servers: a channel of posts, like Discord's. Each post is its own
// little channel (kind "post", parent_id = the forum) with a title, tags from the forum's list, and its
// conversation; it uses the forum's permissions (lib/chat.ts channelFor). A media channel is a forum
// where every post starts with a picture or video. The post keeps a preview of its first message
// (topic = the start of the text, icon_url = its first picture) so the forum lists posts without
// reading every conversation. supabase/019_channel_types.sql.
import { guardPost } from "./automod";
import { cleanAttachments } from "./uploads";
import { checkUploads } from "./storage";
import { channelFor, cleanName, FORUM_KINDS, postMessage, profilesById, type Attachment, type Channel } from "./chat";
import { has, P } from "./perms";
import { ApiError, db, inboxesOf, notify, type Profile } from "./server";

export const MAX_TAGS = 20;          // a forum's tags
export const POST_TAGS = 5;          // on one post

export type Tag = { id: string; name: string; emoji?: string | null };

/** A forum's tags, cleaned: [{id, name, emoji}] (ids stay the same when renamed, so posts keep them). */
export function cleanTags(v: unknown): Tag[] {
  if (!Array.isArray(v)) throw new ApiError(400, "Tags must be a list");
  if (v.length > MAX_TAGS) throw new ApiError(400, `Up to ${MAX_TAGS} tags`);
  const seen = new Set<string>();
  return v.map((t, i) => {
    const o = (t ?? {}) as { id?: unknown; name?: unknown; emoji?: unknown };
    const name = cleanName(o.name, "Tag name", 24);
    const id = typeof o.id === "string" && /^[a-z0-9]{1,12}$/.test(o.id) ? o.id : `t${Date.now().toString(36)}${i}`;
    if (seen.has(id)) throw new ApiError(400, "Two tags have the same id");
    seen.add(id);
    const emoji = typeof o.emoji === "string" && o.emoji.trim() ? o.emoji.trim().slice(0, 16) : null;
    return { id, name, emoji };
  });
}

async function forumFor(id: string, uuid: string) {
  const f = await channelFor(id, uuid);
  if (!FORUM_KINDS.includes(f.channel.kind)) throw new ApiError(400, "That isn't a forum");
  return f;
}

/** A forum's posts: pinned first, then by latest activity (or newest first), maybe one tag only. */
export async function listPosts(forumId: string, p: Profile, opts: { sort?: string; tag?: string; q?: string }) {
  const { channel: forum, perms } = await forumFor(forumId, p.uuid);
  let q = db().from("channels").select("*").eq("parent_id", forum.id).eq("kind", "post");
  if (opts.tag) q = q.contains("tags", [opts.tag]);
  if (opts.q?.trim()) q = q.ilike("name", `%${opts.q.trim().replace(/[%_]/g, "")}%`);
  q = opts.sort === "new" ? q.order("created_at", { ascending: false }) : q.order("last_activity", { ascending: false, nullsFirst: false });
  const { data } = await q.limit(100);
  const posts = ((data ?? []) as Channel[]).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  const people = await profilesById([...new Set(posts.map((x) => x.owner).filter(Boolean))] as string[]);
  // unread: posts with messages since you last read them
  const { data: reads } = posts.length
    ? await db().from("channel_reads").select("channel_id, last_read").eq("uuid", p.uuid).in("channel_id", posts.map((x) => x.id))
    : { data: [] };
  const readSet = new Set((reads ?? []).map((r) => r.channel_id));
  return {
    forum: { id: forum.id, name: forum.name, kind: forum.kind, topic: forum.topic, available_tags: forum.available_tags ?? [], server_id: forum.server_id },
    can_post: has(perms, P.SEND), can_moderate: has(perms, P.MANAGE_MESSAGES),
    posts: posts.map((x) => ({
      id: x.id, title: x.name, tags: x.tags ?? [], author: x.owner ? people[x.owner] ?? null : null,
      preview: x.topic, image: x.icon_url, locked: !!x.locked, pinned: !!x.pinned,
      messages: x.message_count ?? 0, created_at: x.created_at, last_activity: x.last_activity ?? x.created_at,
      new: !readSet.has(x.id),
    })),
  };
}

/** Start a post: its title, tags, and first message (a media channel's needs a picture or video). */
export async function createPost(forumId: string, p: Profile,
  b: { title?: string; body?: string; tags?: unknown; attachments?: unknown }) {
  const { channel: forum, members, perms } = await forumFor(forumId, p.uuid);
  if (!has(perms, P.SEND)) throw new ApiError(403, "You can't post in this forum");
  const title = cleanName(b.title, "Title", 100);
  const text = String(b.body ?? "").trim();
  if (text.length > 2000) throw new ApiError(400, "Messages can be up to 2000 characters");
  const attachments = cleanAttachments(b.attachments, p.uuid) as Attachment[];
  await checkUploads(attachments.map((x) => x.url));
  if (attachments.length && !has(perms, P.ATTACH)) throw new ApiError(403, "You can't attach files here");
  const visual = attachments.find((a) => /^(image|video)\//.test(a.type) && !a.no_preview);
  if (forum.kind === "media" && !visual) throw new ApiError(400, "Posts here start with a picture or video");
  if (!text && !attachments.length) throw new ApiError(400, "Write something to start the post");
  await guardPost(p, "a forum post", `${title}\n${text}`, attachments);       // muted? Jace's auto moderation
  const known = new Set((forum.available_tags ?? []).map((t) => t.id));
  const tags = Array.isArray(b.tags) ? [...new Set(b.tags.map(String))].filter((t) => known.has(t)) : [];
  if (tags.length > POST_TAGS) throw new ApiError(400, `Up to ${POST_TAGS} tags on a post`);
  // a few posts a minute at most
  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  const { count } = await db().from("channels").select("id", { count: "exact", head: true })
    .eq("owner", p.uuid).eq("kind", "post").gt("created_at", minuteAgo);
  if ((count ?? 0) >= 3) throw new ApiError(429, "Slow down a little - try again in a minute");
  const { data: post, error } = await db().from("channels").insert({
    server_id: forum.server_id, kind: "post", parent_id: forum.id, owner: p.uuid, name: title, position: 0, tags,
    topic: text.slice(0, 200) || null, icon_url: visual && visual.type.startsWith("image/") ? visual.url : null,
    last_activity: new Date().toISOString(),
  }).select("*").single();
  if (error) throw error;
  const message = await postMessage(post as Channel, members, p, text, "text", { attachments, perms });
  await notify(await inboxesOf(members.filter((m) => m !== p.uuid)), "channel",
    { channel_id: forum.id, server_id: forum.server_id, post_id: post.id, new_post: true });
  return { post: { id: post.id, title, tags }, message };
}

/** Change a post: its author renames it or changes its tags; moderators also lock and pin it. */
export async function updatePost(post: Channel, perms: number, p: Profile, b: { title?: string; tags?: unknown; locked?: boolean; pinned?: boolean }) {
  const mine = post.owner === p.uuid, mod = has(perms, P.MANAGE_MESSAGES);
  if (!mine && !mod) throw new ApiError(403, "Only its author or moderators can change this post");
  const patch: Record<string, unknown> = {};
  if (b.title !== undefined) { patch.name = cleanName(b.title, "Title", 100); await guardPost(p, "a post's title", patch.name as string); }
  if (b.tags !== undefined) {
    const { data: forum } = await db().from("channels").select("available_tags").eq("id", post.parent_id).maybeSingle();
    const known = new Set(((forum?.available_tags ?? []) as Tag[]).map((t) => t.id));
    const tags = Array.isArray(b.tags) ? [...new Set(b.tags.map(String))].filter((t) => known.has(t)) : [];
    if (tags.length > POST_TAGS) throw new ApiError(400, `Up to ${POST_TAGS} tags on a post`);
    patch.tags = tags;
  }
  if (b.locked !== undefined || b.pinned !== undefined) {
    if (!mod) throw new ApiError(403, "Only moderators can lock or pin posts");
    if (b.locked !== undefined) patch.locked = !!b.locked;
    if (b.pinned !== undefined) patch.pinned = !!b.pinned;
  }
  await db().from("channels").update(patch).eq("id", post.id);
  return { ok: true };
}
