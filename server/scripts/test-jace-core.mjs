// Tests for the database-free parts of the Jace message sync (lib/jaceSyncCore.ts).
//   node scripts/test-jace-core.mjs        (Node 23.6+ runs the .ts file directly)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  appMessageId, backoffSeconds, classify, decryptToken, encryptToken, externalIdFor, splitBody, tokenKey,
} from "../lib/jaceSyncCore.ts";

test("short messages stay one part", () => {
  assert.deepEqual(splitBody("hello", 2000), ["hello"]);
  assert.deepEqual(splitBody("x".repeat(2000), 2000), ["x".repeat(2000)]);
});

test("a 4000-character Jace message becomes several direct messages, nothing lost", () => {
  const long = ("A very long message from the old Jace site. ".repeat(100)).slice(0, 4000);
  const parts = splitBody(long, 2000);
  assert.ok(parts.length >= 2 && parts.length <= 3, `${parts.length} parts`);   // breaking at spaces can need a third
  assert.ok(parts.every((p) => [...p].length <= 2000 && p.length > 0));
  assert.equal(parts.join(""), long);
  assert.ok(parts[0].endsWith(" "), "breaks after a space, not mid-word");
});

test("no spaces: hard break at the limit", () => {
  const parts = splitBody("y".repeat(4500), 2000);
  assert.deepEqual(parts.map((p) => p.length), [2000, 2000, 500]);
});

test("emoji are never cut in half", () => {
  const s = "😀".repeat(2500);                       // 5000 UTF-16 units, 2500 characters
  const parts = splitBody(s, 2000);
  assert.deepEqual(parts.map((p) => [...p].length), [2000, 500]);
  assert.equal(parts.join(""), s);
});

test("our pushes are recognised by the id Jace gives them", () => {
  const ext = externalIdFor("dm", 42);
  assert.equal(ext, "js-dm-42");
  const expected = "app-" + createHash("sha256").update(`client-123:${ext}`).digest("hex").slice(0, 32);
  assert.equal(appMessageId("client-123", ext), expected);
  assert.match(appMessageId("c", "js-ch-7"), /^app-[0-9a-f]{32}$/);
});

test("tokens are encrypted, and can't be read or changed without the key", () => {
  const key = randomBytes(32);
  const sealed = encryptToken("secret-jace-token", key);
  assert.ok(!sealed.includes("secret-jace-token"));
  assert.notEqual(encryptToken("secret-jace-token", key), sealed, "a fresh IV every time");
  assert.equal(decryptToken(sealed, key), "secret-jace-token");
  assert.throws(() => decryptToken(sealed, randomBytes(32)));
  const [v, iv, tag, ct] = sealed.split(".");
  const flipped = Buffer.from(ct, "base64url"); flipped[0] ^= 1;
  assert.throws(() => decryptToken([v, iv, tag, flipped.toString("base64url")].join("."), key));
});

test("JACE_TOKEN_KEY: 32 bytes as base64 or hex, else no syncing", () => {
  const k = randomBytes(32);
  assert.equal(tokenKey(k.toString("base64"))?.length, 32);
  assert.equal(tokenKey(k.toString("hex"))?.length, 32);
  assert.equal(tokenKey("too-short"), null);
  assert.equal(tokenKey(undefined), null);
});

test("Jace's errors mean what the API says", () => {
  assert.equal(classify(401, { error: "invalid_token" }), "disconnected");
  assert.equal(classify(401, { error: "invalid_request" }), "disconnected");
  assert.equal(classify(403, { error: "account_banned" }), "banned");
  assert.equal(classify(403, { error: "insufficient_scope" }), "disconnected");
  assert.equal(classify(403, { error: "invalid_request", error_description: "muted" }), "muted");
  assert.equal(classify(404, { error: "not_found" }), "not_found");
  assert.equal(classify(400, { error: "invalid_request" }), "rejected");
  assert.equal(classify(503, {}), "temporary");
  assert.equal(classify(429, {}), "temporary");
});

test("retries back off, up to 6 hours", () => {
  assert.equal(backoffSeconds(0), 60);
  assert.equal(backoffSeconds(1), 120);
  assert.equal(backoffSeconds(3), 480);
  assert.equal(backoffSeconds(30), 6 * 3600);
});
