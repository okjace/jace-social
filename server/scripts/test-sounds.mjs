// End-to-end test of custom call sounds and the community library (app/api/v1/sounds, lib/sounds.ts).
// Same setup as scripts/test-jace-bot.mjs (supabase/*.sql up to 015, a reset test database, a fresh
// mock-jace.mjs, the server), then:
//   set -a; . ./.env.local; set +a; node scripts/test-sounds.mjs
import assert from "node:assert/strict";

const BASE = process.env.BASE || "http://localhost:3000";
const MOCK = process.env.MOCK || "http://localhost:4000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(token, path, opts = {}) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method: opts.method ?? (opts.body || opts.raw ? "POST" : "GET"),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.raw ? { "Content-Type": opts.type ?? "audio/wav" } : {}) },
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
/** A short beep as a WAV file. */
function wav(seconds = 0.3, rate = 8000) {
  const n = Math.floor(seconds * rate), b = Buffer.alloc(44 + n);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(60 * Math.sin((2 * Math.PI * 880 * i) / rate));
  return b;
}
const step = (s) => console.log(`\n▶ ${s}`);

const alice = await signIn("alice");
const bob = await signIn("bob");

step("upload a ringtone, private at first");
const up = await api(alice.token, "/sounds?name=Beep%20beep&kind=ringtone", { raw: wav() });
assert.equal(up.sound.name, "Beep beep");
assert.equal(up.sound.public, false);
assert.equal((await fetch(up.sound.url)).status, 200, "the file can be played");
assert.equal((await api(alice.token, "/sounds?mine=1")).sounds.length, 1);
assert.equal((await api(bob.token, "/sounds?kind=ringtone")).sounds.length, 0, "not in the library yet");

step("bad uploads are refused");
assert.equal((await api(alice.token, "/sounds?name=x&kind=ringtone", { raw: Buffer.from("hi"), type: "text/plain", allowError: true })).status, 400);
assert.equal((await api(alice.token, "/sounds?name=x&kind=song", { raw: wav(), allowError: true })).status, 400);
assert.equal((await api(alice.token, "/sounds?name=big&kind=ringtone", { raw: wav(140, 8000), allowError: true })).status, 413, "over 1 MB");

step("shared: bob finds it in the library and uses it as his ringtone");
await api(alice.token, `/sounds/${up.sound.id}`, { method: "PATCH", body: { public: true } });
const lib = (await api(bob.token, "/sounds?kind=ringtone&q=beep")).sounds;
assert.equal(lib.length, 1);
assert.match(lib[0].by, /^@/);
const used = await api(bob.token, `/sounds/${up.sound.id}`, { body: { action: "use" } });
await api(bob.token, "/me", { method: "PATCH", body: { settings: { ringtone: used.url, calling_sound: "builtin:chime" } } });
const s = (await api(bob.token, "/me")).settings;
assert.equal(s.ringtone, up.sound.url);
assert.equal(s.calling_sound, "builtin:chime");
assert.equal((await api(bob.token, "/sounds?kind=ringtone")).sounds[0].uses, 1);

step("only real sounds can be chosen");
await api(bob.token, "/me", { method: "PATCH", body: { settings: { ringtone: "https://evil.example/x.mp3" } } });
assert.equal((await api(bob.token, "/me")).settings.ringtone, null);

step("only its owner can change or delete it");
assert.equal((await api(bob.token, `/sounds/${up.sound.id}`, { method: "PATCH", body: { name: "mine now" }, allowError: true })).status, 403);
assert.equal((await api(bob.token, `/sounds/${up.sound.id}`, { method: "DELETE", allowError: true })).status, 403);
await api(alice.token, `/sounds/${up.sound.id}`, { method: "DELETE" });
assert.equal((await api(bob.token, "/sounds?kind=ringtone")).sounds.length, 0);
const left = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/list/sounds`, { method: "POST",   // (its public link can stay cached a while)
  headers: { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ prefix: up.sound.url.split("/public/sounds/")[1].split("/")[0], limit: 10 }) }).then((r) => r.json());
assert.equal(left.length, 0, "the file is gone from storage too");

console.log("\n✓ all sound checks passed");
