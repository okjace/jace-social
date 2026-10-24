// End-to-end test of turning previews on or off after sending, by editing the message (lib/uploads.ts
// editChanges). Same setup as scripts/test-privacy.mjs (a reset test database, a fresh mock-jace.mjs,
// the server), then:
//   set -a; . ./.env.local; set +a; node scripts/test-edit-previews.mjs
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
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const alice = await signIn("alice");
const bob = await signIn("bob");
await api(bob.token, "/me", { method: "PATCH", body: { settings: { open_dms: true } } });
const last = async () => (await api(alice.token, `/messages?with=${bob.uuid}`)).messages.at(-1);

step("sent with the picture shown as a file, and no link preview");
const s = await api(alice.token, "/uploads", { body: { name: "dot.png", type: "image/png", size: PNG.length } });
const up = s.provider === "supabase"
  ? await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/upload/sign/attachments/${s.path}?token=${s.token}`, { method: "PUT", headers: { "Content-Type": "image/png" }, body: PNG })
  : await fetch(s.upload_url, { method: "PUT", headers: s.headers, body: PNG });
assert.ok(up.ok);
const sent = (await api(alice.token, "/messages", { body: { to: bob.uuid, body: "look https://example.com",
  attachments: [{ url: s.url, name: "dot.png", type: "image/png", size: PNG.length, no_preview: true }], no_embed: true } })).message;
await sleep(1500);
let m = await last();
assert.equal(m.attachments[0].no_preview, true);
assert.equal((m.embeds ?? []).length, 0);

step("edit: file preview on - only the previews change, so no '(edited)'");
await api(alice.token, `/messages/direct/${sent.id}`, { method: "PATCH", body: { body: m.body, link_preview: false, file_previews: true } });
m = await last();
assert.equal(m.attachments[0].no_preview, undefined, "shows as a picture now");
assert.equal(m.edited_at, null);

step("edit: a new text keeps the link preview off when the app says so");
await api(alice.token, `/messages/direct/${sent.id}`, { method: "PATCH", body: { body: "look at https://example.com", link_preview: false, file_previews: true } });
await sleep(1500);
m = await last();
assert.equal(m.body, "look at https://example.com");
assert.ok(m.edited_at);
assert.equal((m.embeds ?? []).length, 0);

step("edit: file preview off again");
await api(alice.token, `/messages/direct/${sent.id}`, { method: "PATCH", body: { body: m.body, file_previews: false } });
assert.equal((await last()).attachments[0].no_preview, true);

step("someone else can't change them");
assert.equal((await api(bob.token, `/messages/direct/${sent.id}`, { method: "PATCH", body: { body: m.body, file_previews: true }, allowError: true })).status, 404);

console.log("\n✓ all edit-preview checks passed");
