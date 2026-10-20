// A local stand-in for Jace (jaceo.vercel.app): OAuth plus the messages API, for testing the
// Jace message sync (lib/jaceSync.ts). Never used in production.
//
//   node scripts/mock-jace.mjs                 # http://localhost:4000
//   JACE_URL=http://localhost:4000 npm run dev  # the server talks to it instead of Jace
//
// Two Jace users already talk: alice and bob have a direct message thread (with one 4000-character
// message), and both are in "Build crew" with carol, who never uses Jace Social. /oauth/authorize
// signs in as alice right away; POST /mock/as {"user":"bob"} switches who signs in next.
//
// Test controls (no auth):
//   POST /mock/as {user}                              who the next sign-in is
//   POST /mock/say {from, to?|group?, body, at?}      a message written on Jace
//   POST /mock/mode {user, mode: ok|banned|muted|revoked}
//   POST /mock/fail {times}                           the next POSTs answer 503 (to test retries)
//   GET  /mock/state                                  everything stored, and the external ids seen
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 4000);
const users = {
  alice: { sub: "u-alice", username: "alice", picture: null, banned: false, muted: false, revoked: false },
  bob: { sub: "u-bob", username: "bob", picture: null, banned: false, muted: false, revoked: false },
  carol: { sub: "u-carol", username: "carol", picture: null, banned: false, muted: false, revoked: false },
};
const bySub = (sub) => Object.values(users).find((u) => u.sub === sub);
let signInAs = process.env.MOCK_USER || "alice";
let failPosts = 0;

const t = (iso) => new Date(iso).toISOString();
const long = ("A very long message from the old Jace site. ".repeat(100)).slice(0, 4000);
/** direct messages: {id, from_id, from_name, to_id, body, created_at} */
const dms = [
  { id: "m-1", from_id: "u-alice", from_name: "alice", to_id: "u-bob", body: "hey bob, want to build a castle?", created_at: t("2025-03-01T10:00:00Z") },
  { id: "m-2", from_id: "u-bob", from_name: "bob", to_id: "u-alice", body: "yes! after dinner", created_at: t("2025-03-01T10:05:00Z") },
  { id: "m-3", from_id: "u-alice", from_name: "alice", to_id: "u-bob", body: long, created_at: t("2025-03-02T09:00:00Z") },
];
const groups = [{ id: "g-1", name: "Build crew", member_ids: ["u-alice", "u-bob", "u-carol"], created_at: t("2025-02-01T12:00:00Z") }];
/** group messages: {id, group_id, from_id, from_name, body, created_at} */
const gms = [
  { id: "gm-1", group_id: "g-1", from_id: "u-carol", from_name: "carol", body: "welcome to the build crew", created_at: t("2025-02-01T12:01:00Z") },
  { id: "gm-2", group_id: "g-1", from_id: "u-bob", from_name: "bob", body: "thanks carol", created_at: t("2025-02-01T12:02:00Z") },
];
const externalIds = new Map();        // client_id:external_id -> stored id
const codes = new Map();              // code -> {user, client_id}
const tokens = new Map();             // token -> {user, client_id, scope}

const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => ok(d)); });
const appId = (clientId, ext) => "app-" + createHash("sha256").update(`${clientId}:${ext}`).digest("hex").slice(0, 32);
const after = (list, since) => (since ? list.filter((m) => new Date(m.created_at) > new Date(since)) : list);
const visible = (m) => { const u = bySub(m.from_id); return !u || (!u.banned && !u.muted); };   // Jace hides banned and muted people's messages
const byTime = (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

/** Validate and store a POSTed message or batch, as `who`. -> [status, body] */
function importMessages(who, clientId, body, store) {
  const list = Array.isArray(body.messages) ? body.messages : body.body !== undefined ? [body] : null;
  if (!list || list.length < 1 || list.length > 500) return [400, { error: "invalid_request", error_description: "Send 1 to 500 messages" }];
  for (const m of list) {
    const text = String(m.body ?? "").trim();
    if (text.length < 1 || text.length > 4000) return [400, { error: "invalid_request", error_description: "body must be 1-4000 characters" }];
    if (m.created_at && new Date(m.created_at) > new Date(Date.now() + 1000)) return [400, { error: "invalid_request", error_description: "created_at is in the future" }];
    if (m.external_id && String(m.external_id).length > 200) return [400, { error: "invalid_request", error_description: "external_id is too long" }];
  }
  let imported = 0, skipped = 0;
  for (const m of list) {
    const key = m.external_id ? `${clientId}:${m.external_id}` : null;
    if (key && externalIds.has(key)) { skipped++; continue; }
    const id = m.external_id ? appId(clientId, m.external_id) : `m-${randomUUID()}`;
    if (key) externalIds.set(key, id);
    store(id, String(m.body).trim(), m.created_at ? t(m.created_at) : new Date().toISOString());
    imported++;
  }
  return [200, { imported, skipped }];
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  console.log(req.method, path + url.search);

  // --- test controls
  if (path.startsWith("/mock/")) {
    const b = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
    if (path === "/mock/as") { signInAs = b.user; return json(res, 200, { ok: true }); }
    if (path === "/mock/fail") { failPosts = Number(b.times) || 0; return json(res, 200, { ok: true }); }
    if (path === "/mock/mode") {
      const u = users[b.user];
      u.banned = b.mode === "banned"; u.muted = b.mode === "muted"; u.revoked = b.mode === "revoked";
      return json(res, 200, { ok: true });
    }
    if (path === "/mock/say") {
      const u = users[b.from];
      const at = b.at ? t(b.at) : new Date().toISOString();
      if (b.group) gms.push({ id: `gm-${randomUUID()}`, group_id: b.group, from_id: u.sub, from_name: u.username, body: b.body, created_at: at });
      else dms.push({ id: `m-${randomUUID()}`, from_id: u.sub, from_name: u.username, to_id: users[b.to].sub, body: b.body, created_at: at });
      return json(res, 200, { ok: true });
    }
    if (path === "/mock/state") return json(res, 200, { dms, gms, groups, external_ids: Object.fromEntries(externalIds) });
    return json(res, 404, { error: "not_found" });
  }

  // --- OAuth
  if (path === "/oauth/authorize") {
    const code = randomUUID();
    codes.set(code, { user: signInAs, client_id: url.searchParams.get("client_id"), scope: url.searchParams.get("scope") || "profile" });
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  if (path === "/api/oauth/token" && req.method === "POST") {
    const form = new URLSearchParams(await readBody(req));
    const c = codes.get(form.get("code"));
    if (!c) return json(res, 400, { error: "invalid_grant" });
    codes.delete(form.get("code"));
    const token = `tok-${c.user}-${randomUUID()}`;
    users[c.user].revoked = false;                   // signing in again gives a working token
    tokens.set(token, c);
    return json(res, 200, { access_token: token, token_type: "Bearer", expires_in: 365 * 86400, scope: c.scope });
  }

  // --- everything else needs a token
  const h = req.headers.authorization;
  if (!h) return json(res, 401, { error: "invalid_request", error_description: "No Authorization header" });
  const session = tokens.get(h.replace(/^Bearer /, ""));
  const me = session && users[session.user];
  if (!me || me.revoked) return json(res, 401, { error: "invalid_token" });
  if (path === "/api/oauth/userinfo") {
    return json(res, 200, { sub: me.sub, preferred_username: me.username, picture: me.picture, banned: me.banned, muted: me.muted });
  }
  if (!path.startsWith("/api/oauth/messages")) return json(res, 404, { error: "not_found" });
  if (!/\bmessages\b/.test(session.scope)) return json(res, 403, { error: "insufficient_scope" });
  if (me.banned) return json(res, 403, { error: "account_banned" });
  if (req.method === "POST") {
    if (me.muted) return json(res, 403, { error: "invalid_request", error_description: "Your account is muted" });
    if (failPosts > 0) { failPosts--; return json(res, 503, { error: "temporarily_unavailable" }); }
  }

  if (path === "/api/oauth/messages" && req.method === "GET") {
    const partners = new Map();
    for (const m of dms.filter(visible).sort(byTime)) {
      if (m.from_id !== me.sub && m.to_id !== me.sub) continue;
      const other = m.from_id === me.sub ? m.to_id : m.from_id;
      partners.set(other, m);                        // the newest wins (sorted oldest first)
    }
    return json(res, 200, {
      direct: [...partners].map(([user_id, last]) => ({ user_id, username: bySub(user_id)?.username ?? "?", last_message: last })),
      groups: groups.filter((g) => g.member_ids.includes(me.sub)),
    });
  }
  const dm = path.match(/^\/api\/oauth\/messages\/dm\/([^/]+)$/);
  if (dm) {
    const other = bySub(decodeURIComponent(dm[1]));
    if (!other || other.sub === me.sub) return json(res, 404, { error: "not_found" });
    if (req.method === "GET") {
      const msgs = after(dms.filter(visible).filter((m) => (m.from_id === me.sub && m.to_id === other.sub) || (m.from_id === other.sub && m.to_id === me.sub)),
        url.searchParams.get("since")).sort(byTime);
      return json(res, 200, { messages: msgs });
    }
    const [status, out] = importMessages(me, session.client_id, JSON.parse((await readBody(req)) || "{}"),
      (id, body, created_at) => dms.push({ id, from_id: me.sub, from_name: me.username, to_id: other.sub, body, created_at }));
    return json(res, status, out);
  }
  const gm = path.match(/^\/api\/oauth\/messages\/groups\/([^/]+)$/);
  if (gm) {
    const g = groups.find((x) => x.id === decodeURIComponent(gm[1]));
    if (!g || !g.member_ids.includes(me.sub)) return json(res, 404, { error: "not_found" });
    if (req.method === "GET") {
      const msgs = after(gms.filter(visible).filter((m) => m.group_id === g.id), url.searchParams.get("since")).sort(byTime)
        .map(({ group_id, ...m }) => m);
      return json(res, 200, { messages: msgs });
    }
    const [status, out] = importMessages(me, session.client_id, JSON.parse((await readBody(req)) || "{}"),
      (id, body, created_at) => gms.push({ id, group_id: g.id, from_id: me.sub, from_name: me.username, body, created_at }));
    return json(res, status, out);
  }
  json(res, 404, { error: "not_found" });
}).listen(PORT, () => console.log(`Mock Jace on http://localhost:${PORT} (next sign-in: ${signInAs})`));
