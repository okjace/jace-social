// End-to-end test of the Jace message sync (lib/jaceSync.ts), through the server's own API.
// Needs a TEST Supabase project (never production) with supabase/*.sql run, and:
//
//   node scripts/mock-jace.mjs                                    # terminal 1
//   JACE_URL=http://localhost:4000 JACE_OAUTH_CLIENT_ID=test JACE_OAUTH_CLIENT_SECRET=test \
//     JACE_TOKEN_KEY=$(openssl rand -base64 32) CRON_SECRET=test-cron npm run dev   # terminal 2
//   CRON_SECRET=test-cron node scripts/test-jace-sync.mjs         # terminal 3
//
// Start each run with a fresh mock and an empty test database (scripts/reset-test-db.sh): it checks
// exact counts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const BASE = process.env.BASE || "http://localhost:3000";
const MOCK = process.env.MOCK || "http://localhost:4000";
const CLIENT_ID = process.env.JACE_OAUTH_CLIENT_ID || "test";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const appId = (ext) => "app-" + createHash("sha256").update(`${CLIENT_ID}:${ext}`).digest("hex").slice(0, 32);

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
const cron = () => fetch(`${BASE}/api/v1/jace/cron`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } }).then((r) => r.json());

/** Sign in with Jace as `user` the way the apps do: start, follow the browser part, poll. */
async function signIn(user) {
  await mock("as", { user });
  const { url, state, poll_key } = await api(null, "/auth/jace", { body: {} });
  const toCallback = await fetch(url, { redirect: "manual" });           // the mock signs in at once
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
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

const dmWith = async (token, uuid) => (await api(token, `/messages?with=${uuid}`)).messages;
const step = (s) => console.log(`\n▶ ${s}`);

// 1. First connect imports the old history once, with original times
step("signing in with Jace imports nothing: syncing starts off");
const alice = await signIn("alice");
await sleep(2500);
let info = await api(alice.token, "/jace/messages");
assert.equal(info.state, "ok", "the token is kept");
assert.equal(info.sync_enabled, false);
assert.equal(info.imported, false);
assert.equal((await api(alice.token, "/friends")).friends.length, 0, "no friends from Jace chats yet");

step("alice turns on Sync messages with Jace: her Jace history comes in");
await api(alice.token, "/jace/messages", { method: "PATCH", body: { sync: true } });
await until("alice's import", async () => (await api(alice.token, "/jace/messages")).imported);
const friends = (await api(alice.token, "/friends")).friends;
const bob0 = friends.find((f) => f.jace_name === "bob");
assert.ok(bob0, "bob (a placeholder, never signed in) is alice's friend now");
let dm = await dmWith(alice.token, bob0.uuid);
assert.equal(dm[0].created_at.slice(0, 19), "2025-03-01T10:00:00", "original time kept");
assert.equal(dm[1].body, "yes! after dinner");
const long = dm.slice(2).map((m) => m.body).join("");
assert.equal(long.length, 4000, "the 4000-character message arrived whole");
assert.ok(dm.slice(2).every((m) => m.body.length <= 2000) && dm.length >= 4, "...split into parts of at most 2000");
const dmCount = dm.length;
const group = (await api(alice.token, "/groups")).groups.find((g) => g.name === "Build crew");
assert.ok(group, "the Jace group became a group chat");
assert.deepEqual(group.members.map((m) => m.name).sort(), ["alice", "bob", "carol"]);
let gmsgs = (await api(alice.token, `/channels/${group.id}/messages`)).messages.filter((m) => m.kind === "text");
assert.deepEqual(gmsgs.map((m) => m.body), ["welcome to the build crew", "thanks carol"]);

step("connecting again imports nothing new");
const again = await api(alice.token, "/jace/messages/sync", { body: {} });
assert.equal(again.imported, 0);
assert.equal((await dmWith(alice.token, bob0.uuid)).length, dmCount);

step("bob signs in: the placeholder becomes his account, and nothing is imported twice");
const bob = await signIn("bob");
assert.equal(bob.uuid, bob0.uuid);
await api(bob.token, "/jace/messages", { method: "PATCH", body: { sync: true } });
await until("bob's import", async () => (await api(bob.token, "/jace/messages")).imported);
assert.equal((await dmWith(bob.token, alice.uuid)).length, dmCount);

// 2. Sending here goes to Jace exactly once, even after a forced retry
step("alice sends to bob here: it reaches Jace once, even with a failure and retries");
await mock("fail", { times: 1 });                                       // the first push fails (503)
const sent = (await api(alice.token, "/messages", { body: { to: bob.uuid, body: "sent from Jace Social" } })).message;
await sleep(1500);
await mock("fail", { times: 0 });
await api(alice.token, "/jace/messages/sync", { body: {} });            // resends what's waiting
await cron();                                                           // a second retry pass
let state = await mock("state");
let copies = state.dms.filter((m) => m.body === "sent from Jace Social");
assert.equal(copies.length, 1, "exactly one copy on Jace");
assert.equal(copies[0].id, appId(`js-dm-${sent.id}`));

step("...and it never comes back as a duplicate");
await api(alice.token, "/jace/messages/sync", { body: {} });
await api(bob.token, "/jace/messages/sync", { body: {} });
for (const t of [alice.token, bob.token]) {
  const here = (await dmWith(t, t === alice.token ? bob.uuid : alice.uuid)).filter((m) => m.body === "sent from Jace Social");
  assert.equal(here.length, 1);
}

step("a group chat message goes to the Jace group once");
await api(alice.token, `/channels/${group.id}/messages`, { body: { body: "group hello from Jace Social" } });
await until("the group push", async () => (await mock("state")).gms.filter((m) => m.body === "group hello from Jace Social").length === 1);
await cron();
state = await mock("state");
assert.equal(state.gms.filter((m) => m.body === "group hello from Jace Social").length, 1);
gmsgs = (await api(bob.token, `/channels/${group.id}/messages`)).messages;
assert.equal(gmsgs.filter((m) => m.body === "group hello from Jace Social").length, 1, "not imported back for bob");

// 3. Written on Jace: arrives on the next pull
step("bob writes on Jace: alice gets it on the next pull");
await mock("say", { from: "bob", to: "alice", body: "written on Jace" });
await mock("say", { from: "carol", group: "g-1", body: "carol on Jace" });
await cron();
assert.equal((await dmWith(alice.token, bob.uuid)).filter((m) => m.body === "written on Jace").length, 1);
assert.equal((await api(alice.token, `/channels/${group.id}/messages`)).messages.filter((m) => m.body === "carol on Jace").length, 1);
await cron();
assert.equal((await dmWith(alice.token, bob.uuid)).filter((m) => m.body === "written on Jace").length, 1, "still once");

// 4. Moderation and expired tokens
step("muted on Jace: the message stays here, isn't on Jace, and isn't retried forever");
await mock("mode", { user: "alice", mode: "muted" });
await api(alice.token, "/messages", { body: { to: bob.uuid, body: "said while muted" } });
await sleep(1500);
await cron(); await cron();
assert.equal((await dmWith(alice.token, bob.uuid)).filter((m) => m.body === "said while muted").length, 1);
assert.equal((await mock("state")).dms.filter((m) => m.body === "said while muted").length, 0);
await mock("mode", { user: "alice", mode: "ok" });
await cron();
assert.equal((await mock("state")).dms.filter((m) => m.body === "said while muted").length, 0, "not resent after unmuting");

step("401: the token stops working -> Reconnect Jace");
await mock("mode", { user: "alice", mode: "revoked" });
await api(alice.token, "/jace/messages/sync", { body: {} }, ).catch(() => {});
assert.equal((await api(alice.token, "/jace/messages")).state, "disconnected");
await signIn("alice");                                                  // "Reconnect Jace" signs in with Jace again
assert.equal((await api(alice.token, "/jace/messages")).state, "ok");

step("banned on Jace: syncing stops");
await mock("mode", { user: "bob", mode: "banned" });
await api(bob.token, "/jace/messages/sync", { body: {}, allowError: true });
assert.equal((await api(bob.token, "/jace/messages")).state, "banned");
await mock("mode", { user: "bob", mode: "ok" });

step("the switch and disconnecting");
await api(alice.token, "/jace/messages", { method: "PATCH", body: { sync: false } });
await api(alice.token, "/messages", { body: { to: bob.uuid, body: "while sync is off" } });
await sleep(1500);
assert.equal((await mock("state")).dms.filter((m) => m.body === "while sync is off").length, 0);
await api(alice.token, "/jace/messages", { method: "PATCH", body: { sync: true } });
const gone = await api(alice.token, "/jace/messages", { method: "DELETE" });
assert.equal(gone.state, "disconnected");

console.log("\n✓ all Jace sync checks passed");
console.log("(Not covered here: Minecraft-only people - signing in with Minecraft needs Mojang. See the notes in the README.)");
