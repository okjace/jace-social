// A forum's (or media channel's) posts (lib/forums.ts).
// GET ?sort=active|new&tag=<id>&q=<words>: the posts -> {forum, can_post, can_moderate, posts}
// POST {title, body, tags?: [tag id], attachments?}: start a post (send messages; media: a picture or video)
//   -> {post, message}. Replies go to the post like any channel: POST /channels/{post id}/messages
import { body, handler, me } from "@/lib/server";
import { createPost, listPosts } from "@/lib/forums";

export const GET = handler(async (req, ctx) => {
  const p = await me(req);
  const sp = new URL(req.url).searchParams;
  return listPosts((await ctx.params).id, p, { sort: sp.get("sort") ?? undefined, tag: sp.get("tag") ?? undefined, q: sp.get("q") ?? undefined });
});

export const POST = handler(async (req, ctx) => {
  const p = await me(req);
  return createPost((await ctx.params).id, p, await body(req));
});
