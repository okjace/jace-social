// End-to-end test of moderation (lib/moderation.ts, lib/automod.ts, lib/reports.ts): Jace's auto
// moderation rules, mutes and timed bans by staff, Jace's bans and mutes carried over, and reports.
// Needs supabase/*.sql up to 018, a reset test database, a fresh mock-jace.mjs and the server, then:
//   set -a; . ./.env.local; set +a; node scripts/test-moderation.mjs
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
const mock = (path, body) => fetch(`${MOCK}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
async function signIn(user, allowError = false) {
  await mock("/mock/as", { user });
  const { url, state, poll_key } = await api(null, "/auth/jace", { body: {} });
  const c = await fetch(url, { redirect: "manual" });
  await fetch(c.headers.get("location"), { redirect: "manual" });
  for (let i = 0; i < 20; i++) {
    const r = await api(null, `/auth/jace/poll?state=${state}&key=${poll_key}`, { allowError });
    if (!r.pending) { if (r.error && !allowError) throw new Error(r.error); return r; }
    await sleep(500);
  }
}
const step = (s) => console.log(`\n▶ ${s}`);
const dm = (t, to, body, allowError = true) => api(t, "/messages", { body: { to, body }, allowError });

const staff = await signIn("okjace");            // a Jace admin: Jace Social staff
const alice = await signIn("alice");
const bob = await signIn("bob");
await api(bob.token, "/me", { method: "PATCH", body: { settings: { open_dms: true } } });     // so alice can write to bob
await api(staff.token, "/me");                    // (staff is checked with Jace)

step("Jace's auto moderation rules apply: blocked words (even disguised), too many links");
await mock("/mock/automod", { rules: { blocked_terms: ["badword", "two words"], max_links: 1, auto_mute_after: 3, auto_mute_minutes: 60 } });
await sleep(1200);                                // (the server keeps the rules for a second)
assert.equal((await dm(alice.token, bob.uuid, "hello bob")).message?.body, "hello bob");
let r = await dm(alice.token, bob.uuid, "you are a B4DW0RD");
assert.equal(r.status, 400, "l33t spelling is still caught");
assert.match(r.error, /aren't allowed/);
r = await dm(alice.token, bob.uuid, "b.a.d.w.o.r.d");
assert.equal(r.status, 400, "spaced out too");
assert.equal((await dm(alice.token, bob.uuid, "badwordsmith is fine")).error, undefined, "only whole words");
r = await dm(alice.token, bob.uuid, "https://a.example and https://b.example");
assert.equal(r.status, 403, "more than one link - and that's the third blocked post: muted");
assert.match(r.error, /too many links.*muted/);
step("third blocked post in a day: muted automatically");
let me = await api(alice.token, "/me");
assert.equal(me.moderation.muted, true, "muted after 3 blocked posts");
assert.equal((await dm(alice.token, bob.uuid, "still here?")).status, 403);
assert.equal((await api(alice.token, "/reactions", { body: { scope: "d", message_id: 1, emoji: "👍" }, allowError: true })).status, 403);
assert.equal((await api(alice.token, "/me", { method: "PATCH", body: { bio: "hi" }, allowError: true })).status, 403, "no profile text either");
assert.equal((await api(alice.token, "/me", { method: "PATCH", body: { status: "idle" }, allowError: true })).error, undefined, "but a status is fine");
const mod = await api(staff.token, `/moderation?uuid=${alice.uuid}`);
assert.equal(mod.muted, true);
assert.equal(mod.mute_from, "automod");
assert.ok(mod.automod_blocks_30d >= 3);
await mock("/mock/automod", { rules: { blocked_terms: [], max_links: 0, auto_mute_after: 0 } });

step("staff unmute; names are checked too");
await api(staff.token, "/moderation", { body: { uuid: alice.uuid, action: "unmute" } });
assert.equal((await api(alice.token, "/me")).moderation.muted, false);
await mock("/mock/automod", { rules: { blocked_usernames: ["official"] } });
await sleep(1200);
assert.equal((await api(alice.token, "/me", { method: "PATCH", body: { display_name: "The Official One" }, allowError: true })).status, 400);
await mock("/mock/automod", { rules: { blocked_usernames: [] } });

step("staff mute for a while: refused, then it runs out by itself");
await api(staff.token, "/moderation", { body: { uuid: alice.uuid, action: "mute", duration: 1, reason: "cool off" } });
me = await api(alice.token, "/me");
assert.equal(me.moderation.muted, true);
assert.equal(me.moderation.mute_reason, "cool off");
r = await dm(alice.token, bob.uuid, "hi");
assert.equal(r.status, 403);
assert.match(r.error, /muted on Jace Social until .*cool off/);
const sb = (path, init = {}) => fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
  ...init, headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
await sb(`profiles?uuid=eq.${alice.uuid}`, { method: "PATCH", body: JSON.stringify({ mute_until: new Date(Date.now() - 1000).toISOString() }) });   // (pretend the minute passed)
assert.equal((await api(alice.token, "/me")).moderation.muted, false, "ran out");
assert.equal((await dm(alice.token, bob.uuid, "back")).message?.body, "back");

step("staff timed ban: signed out, can't sign in, then it runs out");
await api(staff.token, "/moderation", { body: { uuid: bob.uuid, action: "ban", duration: "1h", reason: "spam" } });
assert.equal((await api(bob.token, "/me", { allowError: true })).status, 401, "signed out everywhere");
const again = await signIn("bob", true);
assert.match(again.error ?? "", /banned from Jace Social until .*spam/);
await sb(`profiles?uuid=eq.${bob.uuid}`, { method: "PATCH", body: JSON.stringify({ ban_until: new Date(Date.now() - 1000).toISOString() }) });
const bob2 = await signIn("bob");
assert.ok(bob2.token, "the ban ran out: signing in works again");

step("Jace's bans and mutes carry over, with their end times, and lift with Jace");
const carol = await signIn("carol");
const until = new Date(Date.now() + 2 * 3600_000).toISOString();
await mock("/mock/moderate", { user: "carol", muted: true, mute_until: until, mute_reason: "rude" });
me = await api(carol.token, "/me");               // (asks Jace in the background)
await sleep(1500);
me = await api(carol.token, "/me");
assert.equal(me.moderation.muted, true, "muted on Jace: muted here");
assert.match(me.moderation.mute_reason, /Muted on Jace: rude/);
assert.equal(new Date(me.moderation.mute_until).getTime(), new Date(until).getTime(), "until the same time");
await mock("/mock/moderate", { user: "carol", muted: false, mute_until: null });
await api(carol.token, "/me");
await sleep(1500);
assert.equal((await api(carol.token, "/me")).moderation.muted, false, "unmuted on Jace: unmuted here");
await mock("/mock/moderate", { user: "carol", banned: true, ban_until: until, ban_reason: "alt account" });
await api(carol.token, "/me");
await sleep(1500);
assert.equal((await api(carol.token, "/me", { allowError: true })).status, 401, "banned on Jace: signed out here");
assert.ok((await signIn("carol", true)).error, "banned on Jace: can't sign in here");
await mock("/mock/moderate", { user: "carol", banned: false, ban_until: null });
assert.ok((await signIn("carol")).token, "unbanned on Jace: can sign in again");

step("staff can mute on Jace too");
await api(staff.token, "/moderation", { body: { uuid: alice.uuid, action: "mute", duration: "1d", reason: "both places", jace: true } });
const state = await (await fetch(`${MOCK}/mock/state`)).json();
assert.ok(state.moderation.some((x) => x.action === "mute" && x.user === "alice" && x.minutes === 1440), "Jace was asked, for a day");
await api(staff.token, "/moderation", { body: { uuid: alice.uuid, action: "unmute", jace: true } });

step("reports: a message and a person, staff see them, delete the message, resolve");
const sent = (await dm(bob2.token, alice.uuid, "buy cheap gold at scam.example")).message ?? (await dm(alice.token, bob2.uuid, "x")).message;
const msgs = (await api(alice.token, `/messages?with=${bob2.uuid}`)).messages;
const bad = msgs.find((m) => m.sender === bob2.uuid) ?? sent;
const rep = await api(alice.token, "/reports", { body: { scope: "d", message_id: bad.id, reason: "scam", details: "selling stuff" } });
assert.ok(rep.id);
await api(alice.token, "/reports", { body: { uuid: bob2.uuid, reason: "spam" } });
assert.equal((await api(alice.token, "/reports", { body: { uuid: alice.uuid, reason: "spam" }, allowError: true })).status, 400, "not yourself");
assert.equal((await api(alice.token, "/reports", { allowError: true })).status, 403, "only staff see reports");
const list = await api(staff.token, "/reports");
assert.equal(list.open, 2);
const msgReport = list.reports.find((x) => x.id === rep.id);
assert.equal(msgReport.excerpt, bad.body, "the message as it was");
assert.equal(msgReport.target, bob2.uuid);
assert.ok(list.people[bob2.uuid]);
await api(staff.token, `/reports/${rep.id}`, { method: "PATCH", body: { status: "resolved", delete_message: true, resolution: "warned" } });
assert.ok(!(await api(alice.token, `/messages?with=${bob2.uuid}`)).messages.some((m) => m.id === bad.id), "message deleted");
const after = await api(staff.token, "/reports?status=all");
assert.equal(after.open, 1);
assert.match(after.reports.find((x) => x.id === rep.id).resolution, /warned; message deleted/);

console.log("\n✓ all moderation checks passed");
