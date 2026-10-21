// End-to-end test of the official Jace bot (lib/jaceBot.ts), through the server's own API.
// Same setup as scripts/test-jace-sync.mjs (TEST Supabase project with supabase/*.sql up to 008,
// scripts/reset-test-db.sh, a fresh mock-jace.mjs, `npm run dev`), then:
//   CRON_SECRET=test-cron node scripts/test-jace-bot.mjs
// Without ANTHROPIC_API_KEY the bot's AI answer is its "talk to a person" message (checked here);
// real AI answers aren't tested (they cost money).
import assert from "node:assert/strict";

const BASE = process.env.BASE || "http://localhost:3000";
const MOCK = process.env.MOCK || "http://localhost:4000";
const JACE_BOT = "00000000000000000000000000000ace";
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
const mock = async (path, body) => (await fetch(`${MOCK}/mock/${path}`, body ? {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {})).json();
/** Supabase as the server (the test project in .env.local): only to set up what a test needs. */
const sb = (path, opts = {}) => fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
  ...opts, headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json", Prefer: "return=representation", ...(opts.headers ?? {}) } }).then((r) => r.json());

async function signIn(user) {
  await mock("as", { user });
  const { url, state, poll_key } = await api(null, "/auth/jace", { body: {} });
  const toCallback = await fetch(url, { redirect: "manual" });
  await fetch(toCallback.headers.get("location"), { redirect: "manual" });
  for (let i = 0; i < 20; i++) {
    const r = await api(null, `/auth/jace/poll?state=${state}&key=${poll_key}`, { allowError: true });
    if (r.status && r.status >= 400) return r;
    if (!r.pending) return r;
    await sleep(500);
  }
  throw new Error("sign-in didn't finish");
}
const chatWithBot = async (t) => (await api(t, `/messages?with=${JACE_BOT}`)).messages;
async function until(what, fn, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(500); }
}
const step = (s) => console.log(`\n▶ ${s}`);

step("a new account gets the welcome; an older one gets the introduction");
const alice = await signIn("alice");
await api(alice.token, "/me");
await until("alice's welcome", async () => (await chatWithBot(alice.token)).length === 1);
assert.equal((await chatWithBot(alice.token))[0].body, "Welcome to Jace Social! Add your friends and make Jace Social feel like home!");
const bob = await signIn("bob");
await sb(`profiles?uuid=eq.${bob.uuid}`, { method: "PATCH", body: JSON.stringify({ jace_welcome: "existing" }) });   // as if from before
await api(bob.token, "/me");
await until("bob's introduction", async () => (await chatWithBot(bob.token)).length === 1);
assert.equal((await chatWithBot(bob.token))[0].body, "This is now the Jace bot! Ask me a question!");
await api(bob.token, "/me"); await sleep(1500);
assert.equal((await chatWithBot(bob.token)).length, 1, "only once");

step("everyone sees the Jace bot, marked OFFICIAL, and can message it without being friends");
const fr = await api(alice.token, "/friends");
assert.equal(fr.jace?.uuid, JACE_BOT);
assert.equal(fr.jace.official, true);
assert.ok(!fr.friends.some((f) => f.uuid === JACE_BOT));
await api(alice.token, "/messages", { body: { to: JACE_BOT, body: "how do I add friends?" } });
await until("an answer", async () => (await chatWithBot(alice.token)).length >= 3);
const answer = (await chatWithBot(alice.token)).at(-1);
assert.equal(answer.sender, JACE_BOT);
console.log("  answer:", answer.body.slice(0, 80));
const notFriends = await api(alice.token, "/messages", { body: { to: bob.uuid, body: "hi" }, allowError: true });
assert.equal(notFriends.status, 403, "other people still need to be friends");

step("Talk to a person: the AI stops, the bot's inbox shows it");
assert.equal((await api(alice.token, "/jace-bot/thread")).mode, "ai");
await api(alice.token, "/jace-bot/thread", { body: { human: true } });
const before = (await chatWithBot(alice.token)).length;
assert.equal((await chatWithBot(alice.token)).at(-1).body, "OK! A person from Jace will answer here soon.");
await api(alice.token, "/messages", { body: { to: JACE_BOT, body: "my friend can't hear me in calls" } });
await sleep(2500);
assert.equal((await chatWithBot(alice.token)).length, before + 1, "no AI answer while a person has the chat");

step("signing in as the bot (owner -> My bots -> Switch to this bot)");
await sb(`profiles?uuid=eq.${JACE_BOT}`, { method: "PATCH", body: JSON.stringify({ bot_owner: alice.uuid }) });   // stands in for 008's @okjace
const botSession = await api(alice.token, `/bots/${JACE_BOT}/session`, { body: {} });
const bot = botSession.token;
assert.equal((await api(bot, "/me")).jace_staff, true);
assert.equal((await api(bob.token, "/me")).jace_staff, false);
const inbox = (await api(bot, "/jace-bot/inbox")).people;
assert.equal(inbox[0].uuid, alice.uuid, "people who want a person come first");
assert.equal(inbox[0].wants_person, true);
await api(bot, "/messages", { body: { to: alice.uuid, body: "Hi! Check your microphone settings." } });
assert.equal((await chatWithBot(alice.token)).at(-1).body, "Hi! Check your microphone settings.");
await api(bot, "/messages", { body: { to: bob.uuid, body: "the bot can message anyone" } });
assert.equal((await api(bob.uuid && bob.token, `/messages?with=${JACE_BOT}`)).messages.at(-1).body, "the bot can message anyone");
assert.equal((await api(bob.token, "/jace-bot/inbox", { allowError: true })).status, 403);

step("announcements: in the tab, and to everyone as a message");
assert.equal((await api(bob.token, "/jace-bot/announcements", { body: { body: "nope" }, allowError: true })).status, 403);
await api(bot, "/jace-bot/announcements", { body: { body: "Jace Social 2.1 is out!" } });
assert.equal((await api(bob.token, "/jace-bot/announcements")).announcements[0].body, "Jace Social 2.1 is out!");
for (const t of [alice.token, bob.token])
  await until("the announcement message", async () => (await chatWithBot(t)).some((m) => m.body === "📢 Jace Social 2.1 is out!"));

step("Docs: starter ones for everyone, editable by the bot");
const docs = (await api(bob.token, "/jace-bot/docs")).docs;
assert.ok(docs.length >= 10, `${docs.length} starter docs`);
assert.equal(docs[0].title, "Getting started");
assert.equal((await api(bob.token, "/jace-bot/docs", { body: { title: "x", body: "y" }, allowError: true })).status, 403);
const made = (await api(bot, "/jace-bot/docs", { body: { title: "Test doc", body: "Hello" } })).doc;
await api(bot, "/jace-bot/docs", { method: "PATCH", body: { id: made.id, body: "Hello again" } });
assert.equal((await api(bob.token, "/jace-bot/docs")).docs.find((d) => d.id === made.id).body, "Hello again");
await api(bot, `/jace-bot/docs?id=${made.id}`, { method: "DELETE" });

step("the official bot can't be deleted or made private");
assert.equal((await api(alice.token, `/bots/${JACE_BOT}`, { method: "DELETE", allowError: true })).status, 400);
assert.equal((await api(alice.token, `/bots/${JACE_BOT}`, { method: "PATCH", body: { bot_public: false }, allowError: true })).status, 400);

step("bans: from Jace Social, and the Jace account");
assert.equal((await api(bob.token, "/jace-bot/ban", { body: { uuid: alice.uuid }, allowError: true })).status, 403);
assert.equal((await api(bot, "/jace-bot/ban", { body: { uuid: alice.uuid }, allowError: true })).status, 400, "not the bot's owner");
const banned = await api(bot, "/jace-bot/ban", { body: { uuid: bob.uuid, reason: "spam", jace: true } });
assert.equal(banned.banned, true);
assert.equal(banned.jace_banned, true);
assert.deepEqual((await mock("state")).banned, ["bob"]);
assert.equal((await api(bob.token, "/me", { allowError: true })).status, 401, "signed out everywhere");
const again = await signIn("bob");
assert.ok(again.status === 400 || /banned/i.test(again.error ?? ""), "can't sign in again");
assert.equal((await api(alice.token, `/users/${bob.uuid}`)).banned, true);
await api(bot, `/jace-bot/ban?uuid=${bob.uuid}&jace=1`, { method: "DELETE" });
assert.deepEqual((await mock("state")).banned, []);
const back = await signIn("bob");
assert.ok(back.token, "can sign in after the unban");

console.log("\n✓ all Jace bot checks passed");
