// End-to-end test of Jace admins being admins here, and your handle and picture going to Jace
// (lib/jaceAdmin.ts). Same setup as scripts/test-jace-bot.mjs (supabase/*.sql up to 014, a reset test
// database, a fresh mock-jace.mjs - where okjace is a Jace admin - and the server), then:
//   set -a; . ./.env.local; set +a; node scripts/test-jace-profile.mjs
import assert from "node:assert/strict";

const BASE = process.env.BASE || "http://localhost:3000";
const MOCK = process.env.MOCK || "http://localhost:4000";
const JACE_BOT = "00000000000000000000000000000ace";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(token, path, opts = {}) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method: opts.method ?? (opts.body || opts.raw ? "POST" : "GET"),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.raw ? { "Content-Type": "image/png" } : {}) },
    body: opts.raw ?? (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok && !opts.allowError) throw new Error(`${path}: ${r.status} ${d.error ?? ""}`);
  return opts.allowError ? { status: r.status, ...d } : d;
}
const mock = async (path, body) => (await fetch(`${MOCK}/mock/${path}`, body ? {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {})).json();
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
async function until(what, fn, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(500); }
}
const sb = (path, opts = {}) => fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: {
  apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`, "Content-Type": "application/json" } });
const jaceUser = async (key) => (await mock("state")).users[key];
const step = (s) => console.log(`\n▶ ${s}`);
// a 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

step("Jace's admins are admins here: they run the Jace bot (even without owning it)");
const admin = await signIn("okjace");
const alice = await signIn("alice");
assert.equal((await api(admin.token, "/me")).jace_staff, true, "okjace is a Jace admin");
assert.equal((await api(alice.token, "/me")).jace_staff, false);
await api(admin.token, "/jace-bot/broadcast", { body: { body: "Hello from a Jace admin" } });
assert.equal((await api(alice.token, "/jace-bot/broadcast", { body: { body: "no" }, allowError: true })).status, 403);
const asBot = await api(admin.token, `/bots/${JACE_BOT}/session`, { body: {} });
assert.equal((await api(asBot.token, "/me")).uuid, JACE_BOT, "an admin can switch to the Jace bot");
assert.equal((await api(alice.token, `/bots/${JACE_BOT}/session`, { body: {}, allowError: true })).status, 404);

step("a new @handle becomes the Jace username");
await api(alice.token, "/me", { method: "PATCH", body: { handle: "alice_builds" } });
await until("the Jace username", async () => (await jaceUser("alice")).username === "alice_builds");
assert.equal((await api(alice.token, "/me")).jace_name, "alice_builds");

step("...unless Jace can't take it (a dot, or taken on Jace): it stays");
await sb(`profiles?uuid=eq.${alice.uuid}`, { method: "PATCH", body: JSON.stringify({ handle_changed_at: null }) });   // (once a week)
await api(alice.token, "/me", { method: "PATCH", body: { handle: "alice.b" } });
await sleep(2500);
assert.equal((await jaceUser("alice")).username, "alice_builds", "dots aren't allowed in Jace usernames");
assert.equal((await api(alice.token, "/me")).handle, "alice.b", "the handle here still changed");

step("a new picture becomes the Jace picture; removing it removes it there");
const pic = await api(alice.token, "/me/avatar", { raw: PNG });
await until("the Jace picture", async () => (await jaceUser("alice")).picture === pic.avatar_url);
await api(alice.token, "/me/avatar", { method: "DELETE" });
await until("the Jace picture removed", async () => (await jaceUser("alice")).picture === null);

console.log("\n✓ all Jace admin and profile checks passed");
