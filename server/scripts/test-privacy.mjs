// End-to-end test of "Anyone can find me and message me", Find people, profile links (/u/<handle>)
// and website/social links. Same setup as scripts/test-jace-bot.mjs (a reset test database, a fresh
// mock-jace.mjs, the server), then:
//   set -a; . ./.env.local; set +a; node scripts/test-privacy.mjs
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
const settings = (t, s) => api(t, "/me", { method: "PATCH", body: { settings: s } });

const alice = await signIn("alice");
const bob = await signIn("bob");
const carol = await signIn("carol");
const aliceMe = await api(alice.token, "/me");
const handle = aliceMe.handle;

step("by default: strangers can't message you or find you by searching");
assert.equal((await api(bob.token, "/messages", { body: { to: alice.uuid, body: "hi" }, allowError: true })).status, 403);
assert.ok(!(await api(carol.token, `/users?q=${handle.slice(0, 3)}`)).users.some((u) => u.uuid === alice.uuid), "not in search");
assert.ok((await api(carol.token, `/users?q=${handle}`)).users.some((u) => u.uuid === alice.uuid), "but her exact @handle finds her");
assert.equal((await api(bob.token, `/users/${alice.uuid}`)).can_message, false);

step("'Anyone can find me and message me' on: found, and anyone can message");
await settings(alice.token, { open_dms: true });
assert.ok((await api(carol.token, `/users?q=${handle.slice(0, 3)}`)).users.some((u) => u.uuid === alice.uuid), "in search now");
assert.equal((await api(bob.token, `/users/${alice.uuid}`)).can_message, true);
await api(bob.token, "/messages", { body: { to: alice.uuid, body: "hi alice, found you in Find people" } });
const others = (await api(alice.token, "/friends")).others;
assert.equal(others[0].uuid, bob.uuid, "the chat shows in her sidebar");
assert.equal(others[0].status, "offline", "no presence for people who aren't friends");
assert.equal(others[0].unread, 1);
assert.equal((await api(alice.token, `/messages?with=${bob.uuid}`)).messages.at(-1).body, "hi alice, found you in Find people");
await api(alice.token, "/messages", { body: { to: bob.uuid, body: "hi bob!" } });   // she can answer
assert.equal((await api(carol.token, "/messages", { body: { to: bob.uuid, body: "hey" }, allowError: true })).status, 403, "bob still only takes friends");

step("off again: no new people can message her (a chat she answered goes on)");
await settings(alice.token, { open_dms: false });
assert.equal((await api(carol.token, "/messages", { body: { to: alice.uuid, body: "hello?" }, allowError: true })).status, 403);
await api(bob.token, "/messages", { body: { to: alice.uuid, body: "thanks for answering" } });

step("removing a friend stops their messages, even old chats");
await api(carol.token, "/friends", { body: { name: `@${handle}` } });
await api(alice.token, "/friends", { body: { uuid: carol.uuid } });
await api(carol.token, "/messages", { body: { to: alice.uuid, body: "friends now" } });
await api(alice.token, `/friends?uuid=${carol.uuid}`, { method: "DELETE" });
assert.equal((await api(carol.token, "/messages", { body: { to: alice.uuid, body: "still there?" }, allowError: true })).status, 403);
await api(alice.token, `/friends?uuid=${bob.uuid}`, { method: "DELETE" });     // (bob wasn't a friend: this ends their chat too)
assert.equal((await api(bob.token, "/messages", { body: { to: alice.uuid, body: "hello again" }, allowError: true })).status, 403);

step("website and social links");
await api(alice.token, "/me", { method: "PATCH", body: { links: [{ label: "", url: "https://youtube.com/@alicebuilds" }, { label: "My site", url: "https://alice.example" }] } });
const links = (await api(alice.token, "/me")).links;
assert.deepEqual(links.map((l) => l.label), ["YouTube", "My site"], "a YouTube link is named for you");
const eleven = Array.from({ length: 11 }, (_, i) => ({ label: `L${i}`, url: `https://example.com/${i}` }));
assert.equal((await api(alice.token, "/me", { method: "PATCH", body: { links: eleven }, allowError: true })).status, 400, "up to 10");
await api(alice.token, "/me", { method: "PATCH", body: { bio: "I build castles" } });

step("profile link: private until turned on");
let page = await (await fetch(`${BASE}/u/${handle}`)).text();
assert.match(page, /This profile is private/);
assert.ok(!page.includes("I build castles"), "nothing from the profile");
await settings(alice.token, { public_profile: true });
page = await (await fetch(`${BASE}/u/${handle}`)).text();
assert.ok(page.includes("I build castles"));
assert.ok(page.includes("youtube.com/@alicebuilds"));
assert.ok(page.includes(`/app#profile=${alice.uuid}`), "Open in Jace Social");
assert.equal((await fetch(`${BASE}/u/nobody_has_this`)).status, 404);

console.log("\n✓ all privacy and profile checks passed");
