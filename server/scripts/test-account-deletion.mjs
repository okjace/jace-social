// End-to-end test of deleting your account through the Jace bot and recovering it
// (lib/accountDeletion.ts, supabase/010_account_deletion.sql). Same setup as scripts/test-jace-bot.mjs
// (TEST Supabase project with supabase/*.sql up to 010, scripts/reset-test-db.sh, a fresh
// mock-jace.mjs, the server running), then:
//   set -a; . ./.env.local; set +a; node scripts/test-account-deletion.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const BASE = process.env.BASE || "http://localhost:3000";
const MOCK = process.env.MOCK || "http://localhost:4000";
const JACE_BOT = "00000000000000000000000000000ace";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

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
async function askBot(token, text) {
  const before = (await chatWithBot(token)).length;
  await api(token, "/messages", { body: { to: JACE_BOT, body: text } });
  return until(`the bot's answer to "${text}"`, async () => {
    const msgs = await chatWithBot(token);
    return msgs.length >= before + 2 && msgs.at(-1).sender === JACE_BOT && msgs.at(-1);
  });
}
const step = (s) => console.log(`\n▶ ${s}`);

step("carol and alice are friends; alice has a profile and a chat with carol");
const carol = await signIn("carol");
await api(carol.token, "/me", { method: "PATCH", body: { handle: "carol_test" } });
const alice = await signIn("alice");
await api(alice.token, "/me", { method: "PATCH", body: { bio: "I build castles", settings: { accent: "#e0605a" } } });
assert.equal((await api(alice.token, "/me")).handle, "alice", "her handle, from her Jace name");
await api(alice.token, "/friends", { body: { name: "@carol_test" } });
await api(carol.token, "/friends", { body: { uuid: alice.uuid } });
await api(alice.token, "/messages", { body: { to: carol.uuid, body: "before I deleted it" } });
assert.ok((await api(carol.token, "/friends")).friends.some((f) => f.uuid === alice.uuid));
await api(alice.token, "/jace/messages", { method: "PATCH", body: { sync: true } });   // she syncs her Jace messages
await until("alice's Jace import", async () => (await api(alice.token, "/jace/messages")).imported, 60_000);
const [bob] = await sb("profiles?jace_name=eq.bob&select=uuid");
// bob syncs too: his Jace chat with alice and their "Build crew" group
const bobS = await signIn("bob");
await api(bobS.token, "/jace/messages", { method: "PATCH", body: { sync: true } });
await until("bob's Jace import", async () => (await api(bobS.token, "/jace/messages")).imported, 60_000);
assert.ok((await api(alice.token, "/groups")).groups.some((g) => g.name === "Build crew"), "alice is in Build crew");
const withBobBefore = (await api(alice.token, `/messages?with=${bob.uuid}`)).messages.length;
assert.ok(withBobBefore > 0, "alice's Jace chat with bob came in");

step("asking the Jace bot: it answers with the delete button");
const answer = await askBot(alice.token, "how do I delete my account?");
assert.match(answer.body, /\[\[delete-account\]\]/);

step("deleting needs a fresh sign-in");
await sb(`sessions?token_hash=eq.${sha256(alice.token)}`, { method: "PATCH", body: JSON.stringify({ created_at: new Date(Date.now() - 3600_000).toISOString() }) });
assert.equal((await api(alice.token, "/me", { method: "DELETE", allowError: true })).status, 401, "an hour-old session can't delete");
const fresh = await signIn("alice");
assert.equal(fresh.uuid, alice.uuid);
const deleted = await api(fresh.token, "/me", { method: "DELETE" });
assert.match(deleted.recovery_id, /^JSR(-[2-9A-HJ-NP-Z]{4}){4}$/);
const days = (new Date(deleted.expires_at) - Date.now()) / 86400_000;
assert.ok(days > 9.9 && days <= 10, `expires in 10 days (${days.toFixed(2)})`);
console.log("  recovery ID:", deleted.recovery_id);

step("deleted: signed out everywhere, gone for carol");
assert.equal((await api(alice.token, "/me", { allowError: true })).status, 401);
assert.equal((await api(fresh.token, "/me", { allowError: true })).status, 401);
assert.ok(!(await api(carol.token, "/friends")).friends.some((f) => f.name === "alice"), "not in carol's friends");
assert.equal((await api(carol.token, "/friends", { body: { name: "@alice" }, allowError: true })).status, 404, "handle not findable");
assert.equal((await api(carol.token, `/messages?with=${alice.uuid}`)).messages.length, 0, "the old id has nothing now");

step("signing in again makes a new, empty account");
const again = await signIn("alice");
assert.notEqual(again.uuid, alice.uuid);
const newMe = await api(again.token, "/me");
assert.equal(newMe.handle, "alice", "the handle was freed: the new account gets it (not alice2)");
assert.equal(newMe.bio, null);
assert.equal((await api(again.token, "/jace/messages")).sync_enabled, false, "signing in doesn't sync");
// other people's syncs (bob's, the regular cron run) don't pull the new account into old chats either
const cron = () => fetch(`${BASE}/api/v1/jace/cron`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } }).then((r) => r.json());
await api(bobS.token, "/jace/messages/sync", { body: {} });
await cron();
assert.equal((await api(again.token, "/groups")).groups.length, 0, "not put back in Build crew by bob's sync");
assert.deepEqual((await api(again.token, "/friends")).friends.map((f) => f.name), [], "no friends back from bob's sync");
// even turning syncing on doesn't bring back the deleted account's Jace chats (only newer ones)
await api(again.token, "/jace/messages", { method: "PATCH", body: { sync: true } });
await until("the new account's Jace import", async () => (await api(again.token, "/jace/messages")).imported, 60_000);
const newFriends = (await api(again.token, "/friends")).friends;
assert.deepEqual(newFriends.map((f) => f.name), [], "no friends come back from the old Jace chats");
assert.equal((await api(again.token, "/groups")).groups.length, 0, "no old group chats either");
assert.equal((await api(again.token, `/messages?with=${bob.uuid}`)).messages.length, 0, "and no old messages");

step("a wrong recovery ID doesn't work");
assert.match((await askBot(again.token, "JSR-2222-3333-4444-5555")).body, /doesn't work/);

step("the right one turns this account back into the old one");
assert.match((await askBot(again.token, `here it is: ${deleted.recovery_id.toLowerCase()}`)).body, /Welcome back/);
const back = await api(again.token, "/me");                  // same session, same id as the new account
assert.equal(back.uuid, again.uuid);
assert.equal(back.handle, "alice");
assert.equal(back.bio, "I build castles");
assert.equal(back.settings.accent, "#e0605a");
assert.ok((await api(again.token, "/friends")).friends.some((f) => f.uuid === carol.uuid), "friends with carol again");
const withCarol = (await api(again.token, `/messages?with=${carol.uuid}`)).messages;
assert.ok(withCarol.some((m) => m.body === "before I deleted it" && m.sender === again.uuid), "the chat with carol is back");
assert.ok((await api(carol.token, "/friends")).friends.some((f) => f.uuid === again.uuid), "carol sees alice again");
await sleep(3000);                                           // any Jace import from the new sign-in
assert.equal((await api(again.token, `/messages?with=${bob.uuid}`)).messages.length, withBobBefore, "the Jace chat with bob isn't doubled");
const signedInAgain = await signIn("alice");
assert.equal(signedInAgain.uuid, again.uuid, "signing in with Jace finds the recovered account");

step("a recovery ID works only once");
assert.match((await askBot(again.token, deleted.recovery_id)).body, /doesn't work/);

step("Settings -> Delete account with a recovery ID does the same");
const viaSettings = await signIn("alice");
const del3 = await api(viaSettings.token, "/me", { method: "DELETE" });
const again3 = await signIn("alice");
assert.equal((await api(again3.token, "/me/recover", { body: { recovery_id: "JSR-2222-3333-4444-5555" } })).ok, false);
const rec3 = await api(again3.token, "/me/recover", { body: { recovery_id: del3.recovery_id } });
assert.equal(rec3.ok, true, rec3.message);
assert.equal((await api(again3.token, "/me")).bio, "I build castles");

step("after 10 days it's gone for good");
const fresh2 = await signIn("alice");
const deleted2 = await api(fresh2.token, "/me", { method: "DELETE" });
const [parked] = await sb(`profiles?recover_hash=eq.${sha256(deleted2.recovery_id.replace(/-/g, ""))}&select=uuid`);
assert.ok(parked, "set aside");
await sb(`profiles?uuid=eq.${parked.uuid}`, { method: "PATCH", body: JSON.stringify({ recover_expires_at: new Date(Date.now() - 1000).toISOString() }) });
const purgeRun = () => fetch(`${BASE}/api/v1/jace/cron`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } }).then((r) => r.json());
const purge = await purgeRun();
assert.equal(purge.purged, 1);
assert.equal((await sb(`profiles?uuid=eq.${parked.uuid}&select=uuid`)).length, 0);
const third = await signIn("alice");
assert.match((await askBot(third.token, deleted2.recovery_id)).body, /doesn't work/);

step("([DELETE-NOW]): deleted right away and for good");
const carolNow = await askBot(carol.token, "delete my account ([DELETE-NOW])");
assert.match(carolNow.body, /\[\[delete-account-now\]\]/);
const carolFresh = await signIn("carol");
const gone = await api(carolFresh.token, "/me?now=1", { method: "DELETE" });
assert.equal(gone.deleted_for_good, true);
assert.equal(gone.recovery_id, undefined, "no recovery ID");
assert.equal((await api(carolFresh.token, "/me", { allowError: true })).status, 401);
assert.equal((await sb(`profiles?or=(uuid.eq.${carol.uuid},deleted_handle.eq.carol_test,handle.eq.carol_test)&select=uuid`)).length, 0, "nothing left of it");
assert.equal((await sb(`messages?or=(sender.eq.${carol.uuid},recipient.eq.${carol.uuid})&select=id`)).length, 0, "its messages are gone");
const carolAgain = await signIn("carol");
assert.equal((await api(carolAgain.token, "/me")).handle, "carol", "her handle is free");
await api(bobS.token, "/jace/messages/sync", { body: {} });
await purgeRun();
assert.equal((await api(carolAgain.token, "/groups")).groups.length, 0, "other syncs don't bring Build crew back (remembered for good)");
assert.deepEqual((await api(carolAgain.token, "/friends")).friends.map((f) => f.name), []);

console.log("\n✓ all account deletion checks passed");
