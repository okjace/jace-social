// End-to-end test of Jace ban appeals (lib/appeals.ts), through the server's own API. Same setup as
// scripts/test-jace-bot.mjs (TEST Supabase project with supabase/*.sql up to 013, scripts/reset-test-db.sh,
// a fresh mock-jace.mjs, the server running), then:
//   set -a; . ./.env.local; set +a; node scripts/test-appeals.mjs
// In the mock, okjace owns Jace Official; dave (banned) and erin (muted) have appealed; alice isn't staff.
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
  const text = await r.text();
  let d = {};
  try { d = JSON.parse(text); } catch { /* */ }
  if (!r.ok && !opts.allowError) throw new Error(`${path}: ${r.status} ${d.error ?? ""}`);
  return opts.allowError ? { status: r.status, text, ...d } : d;
}
const mock = async (path, body) => (await fetch(`${MOCK}/mock/${path}`, body ? {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {})).json();
const sb = (path) => fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
  headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}` } }).then((r) => r.json());
const cron = () => fetch(`${BASE}/api/v1/jace/cron`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } }).then((r) => r.json());

async function signIn(user) {
  await mock("as", { user });
  const { url, state, poll_key } = await api(null, "/auth/jace", { body: {} });
  const toCallback = await fetch(url, { redirect: "manual" });
  await fetch(toCallback.headers.get("location"), { redirect: "manual" });
  for (let i = 0; i < 20; i++) {
    const r = await api(null, `/auth/jace/poll?state=${state}&key=${poll_key}`);
    if (!r.pending) return r;
    await sleep(500);
  }
  throw new Error("sign-in didn't finish");
}
async function until(what, fn, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(500); }
}
const step = (s) => console.log(`\n▶ ${s}`);

step("staff (okjace) sees the Appeals inbox; alice doesn't, and gets no appeal data");
const staff = await signIn("okjace");
const alice = await signIn("alice");
assert.equal((await api(staff.token, "/me")).appeals, "staff");
assert.equal((await api(alice.token, "/me")).appeals, "none");
const refused = await api(alice.token, "/appeals", { allowError: true });
assert.equal(refused.status, 404);
assert.ok(!/dave|erin|banned|Spamming/i.test(refused.text), "nothing about appeals reaches alice");
assert.equal((await api(alice.token, "/appeals/u-dave", { allowError: true })).status, 404);

step("both appeals, with the right badges, newest first, waiting for a reply");
let list = (await api(staff.token, "/appeals")).appeals;
assert.deepEqual(list.map((a) => [a.username, a.status]), [["erin", "muted"], ["dave", "banned"]]);
assert.equal(list[1].ban_reason, "Spamming links");
assert.equal(list[0].mute_reason, "Rude in comments");
assert.ok(list.every((a) => a.waiting), "both wrote last");

step("a reply arrives on Jace as Jace Official exactly once, even after a forced retry");
await mock("fail", { times: 1 });
const replyId = "11111111-2222-3333-4444-555555555555";
const first = await api(staff.token, "/appeals/u-dave", { body: { body: "We're looking at it.", reply_id: replyId }, allowError: true });
assert.equal(first.status, 502, "Jace was down the first time");
assert.equal((await api(staff.token, "/appeals/u-dave", { body: { body: "We're looking at it.", reply_id: replyId } })).imported, 1);
assert.equal((await api(staff.token, "/appeals/u-dave", { body: { body: "We're looking at it.", reply_id: replyId } })).skipped, 1);
const sent = (await mock("state")).appeals.filter((m) => m.body === "We're looking at it.");
assert.equal(sent.length, 1);
assert.equal(sent[0].from_name, "Jace Official");
const thread = await api(staff.token, "/appeals/u-dave");
assert.equal(thread.messages.at(-1).from_name, "Jace Official");
assert.equal(thread.appeal.status, "banned");

step("unban: refused for alice before it reaches Jace; for staff the badge flips to Active");
assert.equal((await api(alice.token, "/appeals/u-dave/decision", { body: { action: "unban" }, allowError: true })).status, 404);
assert.equal((await mock("state")).moderation.length, 0, "Jace's moderation API was never called");
const un = await api(staff.token, "/appeals/u-dave/decision", { body: { action: "unban" } });
assert.equal(un.result.banned, false);
assert.deepEqual((await mock("state")).moderation.map((m) => [m.action, m.user]), [["unban", "dave"]]);
list = (await api(staff.token, "/appeals")).appeals;
assert.equal(list.find((a) => a.username === "dave").status, "active");

step("keep banned just replies");
await mock("mode", { user: "dave", mode: "banned" });
const kept = await api(staff.token, "/appeals/u-dave/decision", { body: { action: "keep", body: "The ban stays.", reply_id: "keep-0000-0001" } });
assert.equal(kept.kept, true);
assert.equal((await mock("state")).moderation.length, 1, "no moderation call");

step("a new message from an appealing account: one notification, not one per poll");
await cron();                                         // the first poll only takes note
await mock("appeal", { from: "erin", body: "Please, I said sorry" });
assert.equal((await cron()).appeals.notified, 1);
assert.equal((await cron()).appeals.notified, 0);
list = (await api(staff.token, "/appeals")).appeals;
assert.equal(list[0].username, "erin");
assert.equal(list[0].unread, true);
await api(staff.token, "/appeals/u-erin");            // opening it marks it read
assert.equal((await api(staff.token, "/appeals")).appeals.find((a) => a.username === "erin").unread, false);

step("the message sync never imports the Jace Official thread");
const erin = await signIn("erin");
await api(erin.token, "/jace/messages", { method: "PATCH", body: { sync: true } });
await until("erin's Jace import", async () => (await api(erin.token, "/jace/messages")).imported);
assert.equal((await sb("profiles?jace_name=ilike.jace%20official&select=uuid")).length, 0, "no placeholder for Jace Official");
assert.equal((await api(erin.token, "/friends")).friends.length, 0, "no chat with it");
assert.equal((await api(erin.token, "/me")).appeals, "none", "erin isn't staff");

step("an expired Jace token: Reconnect Jace, not an error page");
await mock("mode", { user: "okjace", mode: "revoked" });
const expired = await api(staff.token, "/appeals");
assert.equal(expired.reconnect, true);
assert.equal((await api(staff.token, "/me")).appeals, "reconnect");
await signIn("okjace");                               // "Reconnect Jace" signs in with Jace again
assert.equal((await api(staff.token, "/appeals")).appeals.length, 2);

console.log("\n✓ all appeals checks passed");
