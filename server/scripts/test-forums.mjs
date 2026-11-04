// End-to-end test of forum, media and stage channels (lib/forums.ts, channels/[id]/voice) and reports on
// servers, group chats, channels, posts and bots (lib/reports.ts). Needs supabase/*.sql up to 019, a reset
// test database, a fresh mock-jace.mjs and the server, then:
//   set -a; . ./.env.local; set +a; node scripts/test-forums.mjs
import assert from "node:assert/strict";

const BASE = process.env.BASE || "http://localhost:3000";
const MOCK = process.env.MOCK || "http://localhost:4000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(token, path, opts = {}) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok && !opts.allowError) throw new Error(`${path}: ${r.status} ${d.error ?? ""}`);
  return opts.allowError ? { status: r.status, ...d } : d;
}
async function signIn(user) {
  await fetch(`${MOCK}/mock/as`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user }) });
  const { url, state, poll_key } = await api(null, "/auth/jace", { body: {} });
  const c = await fetch(url, { redirect: "manual" });
  await fetch(c.headers.get("location"), { redirect: "manual" });
  for (let i = 0; i < 20; i++) { const r = await api(null, `/auth/jace/poll?state=${state}&key=${poll_key}`); if (!r.pending) return r; await sleep(500); }
}
const step = (s) => console.log(`\n▶ ${s}`);

const owner = await signIn("alice");
const bob = await signIn("bob");
const carol = await signIn("carol");
const staff = await signIn("okjace");
await api(staff.token, "/me");
const { server } = await api(owner.token, "/servers", { body: { name: "Builders" } });
const sid = server.id;
const code = (await api(owner.token, `/servers/${sid}`)).server.invite_code;
for (const t of [bob.token, carol.token]) await api(t, `/invites/${code}`, { body: {} });

step("forum, media and stage channels; forums have tags");
const forum = (await api(owner.token, `/servers/${sid}/channels`, { body: { name: "Help", kind: "forum",
  available_tags: [{ name: "Question", emoji: "❓" }, { name: "Solved", emoji: "✅" }] } })).channel;
assert.equal(forum.kind, "forum");
assert.equal(forum.available_tags.length, 2);
const [question, solved] = forum.available_tags.map((t) => t.id);
const media = (await api(owner.token, `/servers/${sid}/channels`, { body: { name: "Screenshots", kind: "media" } })).channel;
const stage = (await api(owner.token, `/servers/${sid}/channels`, { body: { name: "Town hall", kind: "stage", topic: "Server update" } })).channel;
assert.equal(stage.name, "Town hall", "stage names keep their capitals");
assert.equal((await api(bob.token, `/channels/${forum.id}/messages`, { body: { body: "hi" }, allowError: true })).status, 400, "no messages straight in a forum");

step("posts: a title, tags and a first message; replies; listed by activity; not in the channel list");
const p1 = await api(bob.token, `/channels/${forum.id}/posts`, { body: { title: "How do I make a farm?", body: "It keeps breaking", tags: [question, "nope"] } });
assert.deepEqual(p1.post.tags, [question], "unknown tags are dropped");
const p2 = await api(carol.token, `/channels/${forum.id}/posts`, { body: { title: "Redstone clock", body: "Show yours" } });
await sleep(50);
await api(owner.token, `/channels/${p1.post.id}/messages`, { body: { body: "Use water, not lava" } });
let list = await api(bob.token, `/channels/${forum.id}/posts`);
assert.equal(list.posts.length, 2);
assert.equal(list.posts[0].id, p1.post.id, "the post with the latest reply is first");
assert.equal(list.posts[0].messages, 2);
assert.equal(list.posts[0].preview, "It keeps breaking");
assert.equal(list.posts[0].author.uuid, bob.uuid);
assert.ok(list.can_post);
assert.equal((await api(bob.token, `/channels/${forum.id}/posts?tag=${question}`)).posts.length, 1, "filter by tag");
assert.equal((await api(bob.token, `/channels/${forum.id}/posts?q=redstone`)).posts.length, 1, "search titles");
assert.equal((await api(bob.token, `/channels/${forum.id}/posts?sort=new`)).posts[0].id, p2.post.id, "newest first");
assert.ok(!(await api(bob.token, `/servers/${sid}`)).channels.some((c) => c.kind === "post"), "posts aren't channels in the list");
assert.equal((await api(bob.token, `/channels/${p1.post.id}/messages`)).messages.length, 2);

step("the author retags; moderators pin and lock; a locked post takes no replies");
await api(bob.token, `/channels/${p1.post.id}`, { method: "PATCH", body: { tags: [solved] } });
assert.equal((await api(carol.token, `/channels/${p1.post.id}`, { method: "PATCH", body: { title: "mine now" }, allowError: true })).status, 403);
assert.equal((await api(bob.token, `/channels/${p1.post.id}`, { method: "PATCH", body: { pinned: true }, allowError: true })).status, 403, "only moderators pin");
await api(owner.token, `/channels/${p2.post.id}`, { method: "PATCH", body: { pinned: true, locked: true } });
list = await api(bob.token, `/channels/${forum.id}/posts`);
assert.equal(list.posts[0].id, p2.post.id, "pinned first");
assert.deepEqual(list.posts.find((x) => x.id === p1.post.id).tags, [solved]);
assert.equal((await api(bob.token, `/channels/${p2.post.id}/messages`, { body: { body: "late reply" }, allowError: true })).status, 403, "locked");
await api(owner.token, `/channels/${p2.post.id}/messages`, { body: { body: "moderators still can" } });

step("media channels: posts start with a picture or video");
assert.equal((await api(bob.token, `/channels/${media.id}/posts`, { body: { title: "My base", body: "look" }, allowError: true })).status, 400);

step("deleting a post: its author or moderators");
assert.equal((await api(carol.token, `/channels/${p1.post.id}`, { method: "DELETE", allowError: true })).status, 403);
await api(bob.token, `/channels/${p1.post.id}`, { method: "DELETE" });
assert.equal((await api(bob.token, `/channels/${forum.id}/posts`)).posts.length, 1);

step("stages: the owner (a moderator) speaks, others listen, raise hands, get invited up, step down");
let j = await api(owner.token, `/channels/${stage.id}/voice`, { body: { action: "join" } });
assert.equal(j.stage, true);
assert.equal(j.moderator, true);
assert.equal(j.can_speak, true);
j = await api(bob.token, `/channels/${stage.id}/voice`, { body: { action: "join" } });
assert.equal(j.can_speak, false, "the audience listens");
assert.equal(j.moderator, false);
let room = (await api(owner.token, `/channels/${stage.id}/voice`)).participants;
assert.equal(room.find((x) => x.uuid === owner.uuid).speaker, true);
assert.equal(room.find((x) => x.uuid === bob.uuid).speaker, false);
await api(bob.token, `/channels/${stage.id}/voice`, { body: { action: "state", muted: false } });
room = (await api(owner.token, `/channels/${stage.id}/voice`)).participants;
assert.equal(room.find((x) => x.uuid === bob.uuid).muted, true, "the audience can't unmute");
assert.equal((await api(bob.token, `/channels/${stage.id}/voice`, { body: { action: "speaker", uuid: bob.uuid, on: true }, allowError: true })).status, 403, "can't invite yourself up");
await api(bob.token, `/channels/${stage.id}/voice`, { body: { action: "hand", raised: true } });
room = (await api(owner.token, `/channels/${stage.id}/voice`)).participants;
assert.ok(room.find((x) => x.uuid === bob.uuid).hand_at, "hand raised");
await api(owner.token, `/channels/${stage.id}/voice`, { body: { action: "speaker", uuid: bob.uuid, on: true } });
await api(bob.token, `/channels/${stage.id}/voice`, { body: { action: "state", muted: false } });
room = (await api(owner.token, `/channels/${stage.id}/voice`)).participants;
assert.equal(room.find((x) => x.uuid === bob.uuid).speaker, true);
assert.equal(room.find((x) => x.uuid === bob.uuid).muted, false, "speakers can talk");
assert.equal(room.find((x) => x.uuid === bob.uuid).hand_at, null);
await api(bob.token, `/channels/${stage.id}/voice`, { body: { action: "speaker", uuid: bob.uuid, on: false } });
room = (await api(owner.token, `/channels/${stage.id}/voice`)).participants;
assert.equal(room.find((x) => x.uuid === bob.uuid).speaker, false, "stepped down");
assert.equal(room.find((x) => x.uuid === bob.uuid).muted, true);
const detail = await api(owner.token, `/servers/${sid}`);
assert.equal(detail.voice.filter((v) => v.channel_id === stage.id).length, 2, "the stage shows who's on it");
for (const t of [owner.token, bob.token]) await api(t, `/channels/${stage.id}/voice`, { body: { action: "leave" } });

step("reports: a server, a channel, a post, a group chat and a bot");
await api(bob.token, "/friends", { body: { uuid: carol.uuid } });
await api(carol.token, "/friends", { body: { uuid: bob.uuid } });
const group = (await api(bob.token, "/groups", { body: { name: "Crew", members: [carol.uuid] } })).group;
const bot = await api(owner.token, "/bots", { body: { name: "Spammy" } });
const general = detail.channels.find((c) => c.kind === "text");
const reps = [
  await api(carol.token, "/reports", { body: { kind: "server", server_id: sid, reason: "scam" } }),
  await api(carol.token, "/reports", { body: { kind: "channel", channel_id: general.id, reason: "hate" } }),
  await api(carol.token, "/reports", { body: { kind: "post", channel_id: p2.post.id, reason: "spam", details: "ads" } }),
  await api(carol.token, "/reports", { body: { kind: "group", channel_id: group.id, reason: "harassment" } }),
  await api(carol.token, "/reports", { body: { uuid: bot.bot?.uuid ?? bot.uuid, reason: "spam" } }),
];
assert.ok(reps.every((r) => r.id));
assert.equal((await api(staff.token, "/reports", { body: { kind: "group", channel_id: group.id, reason: "spam" }, allowError: true })).status, 404, "only people in it can report a group chat");
const all = (await api(staff.token, "/reports")).reports;
const kinds = Object.fromEntries(all.map((r) => [r.id, r.kind]));
assert.deepEqual(reps.map((r) => kinds[r.id]), ["server", "channel", "post", "group", "bot"]);
assert.equal(all.find((r) => r.id === reps[2].id).excerpt, "Redstone clock: Show yours");
assert.equal(all.find((r) => r.id === reps[0].id).target, owner.uuid, "a server report points at its owner");
step("staff delete a reported post");
await api(staff.token, `/reports/${reps[2].id}`, { method: "PATCH", body: { status: "resolved", delete_target: true } });
assert.equal((await api(bob.token, `/channels/${forum.id}/posts`)).posts.length, 0, "post deleted");

console.log("\n✓ all forum, stage and report checks passed");
