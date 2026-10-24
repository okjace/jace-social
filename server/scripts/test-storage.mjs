// End-to-end test of uploads spread over storage services (lib/storage.ts). Needs supabase/*.sql up to
// 017, a reset test database, mock-jace.mjs, mock-s3.mjs (a stand-in for R2), and the server started
// with R2 pointed at it and a tiny R2 limit (.claude/launch.json "server-r2"), then:
//   set -a; . ./.env.local; set +a; node scripts/test-storage.mjs
import assert from "node:assert/strict";

const BASE = process.env.BASE || "http://localhost:3000";
const MOCK = process.env.MOCK || "http://localhost:4000";
const S3 = "http://localhost:4100";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(token, path, opts = {}) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method: opts.method ?? (opts.body || opts.raw ? "POST" : "GET"),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.raw ? { "Content-Type": opts.type ?? "image/png" } : {}) },
    body: opts.raw ?? (opts.body ? JSON.stringify(opts.body) : undefined),
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
const sb = (path) => fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
  headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}` } }).then((r) => r.json());
const usage = async () => Object.fromEntries((await sb("storage_usage?select=provider,bytes")).map((r) => [r.provider, Number(r.bytes)]));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const step = (s) => console.log(`\n▶ ${s}`);

/** A message file, the way the app sends one: ask where, upload there, send. */
async function sendFile(token, to, bytes, name, type = "text/plain") {
  const s = await api(token, "/uploads", { body: { name, type, size: bytes.length } });
  if (s.provider === "supabase") {
    const r = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/upload/sign/attachments/${s.path}?token=${s.token}`, {
      method: "PUT", headers: { "Content-Type": type }, body: bytes });
    assert.ok(r.ok, `supabase upload ${r.status}`);
  } else {
    const r = await fetch(s.upload_url, { method: "PUT", headers: s.headers, body: bytes });
    assert.ok(r.ok, `${s.provider} upload ${r.status}`);
  }
  await api(token, "/messages", { body: { to, body: "", attachments: [{ url: s.url, name, type, size: bytes.length }] } });
  return s;
}

const alice = await signIn("alice");
const bob = await signIn("bob");
await api(alice.token, "/me", { method: "PATCH", body: { settings: { open_dms: true } } });   // so bob can send to her

step("the first file goes to R2 (the stand-in), served from its public URL");
const one = Buffer.from("x".repeat(100));
const a = await sendFile(bob.token, alice.uuid, one, "one.txt");
assert.equal(a.provider, "r2");
assert.ok(a.url.startsWith(`${S3}/jace/attachments/${bob.uuid}/`));
assert.equal(await (await fetch(a.url)).text(), "x".repeat(100));
assert.equal((await usage()).r2, 100);

step("a profile picture fits too (R2 holds ~214 bytes in this test)");
const pic = await api(alice.token, "/me/avatar", { raw: PNG });
assert.ok(pic.avatar_url.startsWith(`${S3}/jace/avatars/`), pic.avatar_url);

step("R2 is full: the next file goes to Supabase");
const b = await sendFile(bob.token, alice.uuid, one, "two.txt");
assert.equal(b.provider, "supabase");
assert.ok(b.url.includes("/storage/v1/object/public/attachments/"));
const u = await usage();
assert.equal(u.r2, 100 + PNG.length);
assert.equal(u.supabase, 100);

step("only your own files can be sent");
assert.equal((await api(alice.token, "/messages", { body: { to: bob.uuid, body: "", attachments: [{ url: a.url, name: "x", type: "text/plain", size: 1 }] }, allowError: true })).status, 400);
assert.equal((await api(bob.token, "/messages", { body: { to: alice.uuid, body: "", attachments: [{ url: "https://evil.example/x", name: "x", type: "text/plain", size: 1 }] }, allowError: true })).status, 400);

step("deleting a sound removes it from where it is, and frees the space");
const wav = Buffer.alloc(60, 1);
const s = await api(alice.token, "/sounds?name=Tiny&kind=message", { raw: wav, type: "audio/wav" });
const where = s.sound.url.startsWith(S3) ? "r2" : "supabase";
const before = (await usage())[where];
await api(alice.token, `/sounds/${s.sound.id}`, { method: "DELETE" });
assert.equal((await usage())[where], before - 60);
if (where === "r2") assert.ok(!(await (await fetch(`${S3}/mock/state`)).json()).some((k) => k.includes(s.sound.url.split("/jace/")[1])));

console.log("\n✓ all storage checks passed");
