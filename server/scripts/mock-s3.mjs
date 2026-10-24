// A local stand-in for an S3-compatible storage service (Cloudflare R2 / Backblaze B2) for testing
// lib/storage.ts: PUT (signed URL or the SDK), GET and DELETE of objects, kept in memory. Signatures
// aren't checked. Never used in production.
//   node scripts/mock-s3.mjs        # http://localhost:4100   (bucket in the path: /<bucket>/<key>)
//   GET /mock/state -> the stored keys
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 4100);
const objects = new Map();   // "/bucket/key" -> { type, body }
createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (url.pathname === "/mock/state") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify([...objects.keys()])); }
  const path = decodeURIComponent(url.pathname);
  console.log(req.method, path);
  if (req.method === "PUT") {
    const chunks = []; for await (const c of req) chunks.push(c);
    objects.set(path, { type: req.headers["content-type"] ?? "application/octet-stream", body: Buffer.concat(chunks) });
    res.writeHead(200, { ETag: '"mock"' }); return res.end();
  }
  if (req.method === "DELETE") { objects.delete(path); res.writeHead(204); return res.end(); }
  const o = objects.get(path);
  if (!o) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": o.type, "Content-Length": o.body.length });
  res.end(req.method === "HEAD" ? undefined : o.body);
}).listen(PORT, () => console.log(`Mock S3 on http://localhost:${PORT}`));
