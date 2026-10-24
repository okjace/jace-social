// Where uploads go: several storage services, each used until it's nearly full - for the most free
// space (supabase/017_storage.sql keeps how much each holds, and where every file went).
//
//   1. Cloudflare R2   10 GB free, free downloads, files up to 500 MB   (R2_* settings)
//   2. Backblaze B2    10 GB free, files up to 500 MB                   (B2_* settings)
//   3. Supabase        1 GB free, files up to 50 MB                     (always there)
//
// A file goes to the first one that's set up, takes a file that big, and has room. R2 and B2 are
// S3-compatible: the app uploads straight to them with a signed URL (the bucket needs CORS for this
// site) and they serve the files from their public URL. Every file's URL is
//   <the service's public URL>/<area>/<key>      area: attachments | avatars | sounds
// so a file can be checked as "ours" (and its owner's) by its URL alone, whichever service it's on.
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ApiError, db, supabaseUrl } from "./server";

export type Area = "attachments" | "avatars" | "sounds";
type ProviderId = "r2" | "b2" | "supabase";
type Provider = {
  id: ProviderId; maxFile: number; capacity: number; base: string;
  s3?: { client: S3Client; bucket: string };
};

const MB = 1024 * 1024, GB = 1024 * MB;
const gb = (v: string | undefined, fallback: number) => (Number(v) > 0 ? Number(v) * GB : fallback);
const trim = (u: string | undefined) => (u ?? "").replace(/\/+$/, "");

let cached: Provider[] | null = null;
/** The services that are set up, in the order they're filled. */
export function providers(): Provider[] {
  if (cached) return cached;
  const list: Provider[] = [];
  const r2Endpoint = process.env.R2_ENDPOINT || (process.env.CLOUDFLARE_ACCOUNT_ID ? `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com` : "");
  if (process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET && process.env.R2_PUBLIC_URL && r2Endpoint) {
    list.push({
      id: "r2", maxFile: 500 * MB, capacity: gb(process.env.R2_LIMIT_GB, 9.5 * GB), base: trim(process.env.R2_PUBLIC_URL),
      s3: { bucket: process.env.R2_BUCKET, client: new S3Client({ region: "auto", endpoint: r2Endpoint, forcePathStyle: true,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } }) },
    });
  }
  if (process.env.B2_KEY_ID && process.env.B2_APPLICATION_KEY && process.env.B2_BUCKET && process.env.B2_ENDPOINT && process.env.B2_PUBLIC_URL) {
    const endpoint = process.env.B2_ENDPOINT.startsWith("http") ? process.env.B2_ENDPOINT : `https://${process.env.B2_ENDPOINT}`;
    const region = process.env.B2_REGION || /s3\.([a-z0-9-]+)\.backblazeb2\.com/.exec(endpoint)?.[1] || "us-west-004";
    list.push({
      id: "b2", maxFile: 500 * MB, capacity: gb(process.env.B2_LIMIT_GB, 9.5 * GB), base: trim(process.env.B2_PUBLIC_URL),
      s3: { bucket: process.env.B2_BUCKET, client: new S3Client({ region, endpoint, forcePathStyle: true,
        credentials: { accessKeyId: process.env.B2_KEY_ID, secretAccessKey: process.env.B2_APPLICATION_KEY } }) },
    });
  }
  list.push({ id: "supabase", maxFile: 50 * MB, capacity: gb(process.env.SUPABASE_STORAGE_LIMIT_GB, 0.95 * GB),
    base: `${supabaseUrl()}/storage/v1/object/public` });
  cached = list;
  return list;
}

/** The biggest file any service set up here takes. */
export const largestFile = () => Math.max(...providers().map((p) => p.maxFile));

/** The first service that takes a file this big and still has room for it. */
async function choose(size: number): Promise<Provider> {
  const list = providers();
  const { data } = await db().from("storage_usage").select("provider, bytes");
  const used = new Map((data ?? []).map((r) => [r.provider as string, Number(r.bytes)]));
  const fits = list.find((p) => size <= p.maxFile && (used.get(p.id) ?? 0) + size <= p.capacity);
  if (fits) return fits;
  if (list.some((p) => size <= p.maxFile)) throw new ApiError(507, "Jace Social's storage is full right now - try a smaller file, or again later");
  throw new ApiError(413, `Files can be up to ${Math.round(largestFile() / MB)} MB`);
}

const urlFor = (p: Provider, area: Area, key: string) => `${p.base}/${area}/${key}`;
const objectKey = (area: Area, key: string) => `${area}/${key}`;

async function record(p: Provider, url: string, key: string, size: number, owner: string | null) {
  await db().from("storage_files").upsert({ url, provider: p.id, key, size, owner }, { onConflict: "url" });
  await db().rpc("storage_add", { p: p.id, n: size });
}

/**
 * A one-time upload for the app to send the file to directly (message files - too big for this
 * server). -> where to PUT it (R2/B2), or a Supabase signed upload (path + token), and its URL.
 */
export async function signUpload(owner: string, area: Area, key: string, type: string, size: number) {
  const p = await choose(size);
  const url = urlFor(p, area, key);
  if (p.s3) {
    const upload_url = await getSignedUrl(p.s3.client,
      new PutObjectCommand({ Bucket: p.s3.bucket, Key: objectKey(area, key), ContentType: type }), { expiresIn: 900 });
    await record(p, url, objectKey(area, key), size, owner);
    return { provider: p.id, url, upload_url, method: "PUT" as const, headers: { "Content-Type": type } };
  }
  const { data, error } = await db().storage.from(area).createSignedUploadUrl(key);
  if (error || !data) throw new ApiError(500, `Couldn't prepare the upload (${error?.message ?? "unknown"})`);
  await record(p, url, key, size, owner);
  return { provider: p.id, url, upload_url: data.signedUrl, path: key, token: data.token, method: "PUT" as const, headers: { "Content-Type": type } };
}

/** Upload bytes from this server (pictures, sounds - small ones) -> the file's URL. */
export async function putFile(owner: string | null, area: Area, key: string, bytes: Uint8Array, type: string): Promise<string> {
  const p = await choose(bytes.length);
  const url = urlFor(p, area, key);
  if (p.s3) {
    await p.s3.client.send(new PutObjectCommand({ Bucket: p.s3.bucket, Key: objectKey(area, key), Body: bytes, ContentType: type }));
    await record(p, url, objectKey(area, key), bytes.length, owner);
    return url;
  }
  const { error } = await db().storage.from(area).upload(key, bytes, { contentType: type, upsert: false });
  if (error) throw new ApiError(500, `Couldn't save the file (${error.message})`);
  await record(p, url, key, bytes.length, owner);
  return db().storage.from(area).getPublicUrl(key).data.publicUrl;
}

/** Delete a file we stored (wherever it went). */
export async function removeFile(url: string) {
  const { data: f } = await db().from("storage_files").select("*").eq("url", url).maybeSingle();
  if (f) {
    const p = providers().find((x) => x.id === f.provider);
    if (p?.s3) await p.s3.client.send(new DeleteObjectCommand({ Bucket: p.s3.bucket, Key: f.key })).catch(() => {});
    else if (f.provider === "supabase") {
      const area = /\/storage\/v1\/object\/public\/(attachments|avatars|sounds)\//.exec(url)?.[1];   // its bucket
      if (area) await db().storage.from(area).remove([f.key]);
    }
    await db().from("storage_files").delete().eq("url", url);
    await db().rpc("storage_add", { p: f.provider, n: -Number(f.size) });
    return;
  }
  // from before the storage list (supabase/017_storage.sql): a Supabase file
  const m = /\/storage\/v1\/object\/public\/(attachments|avatars|sounds)\/(.+)$/.exec(url);
  if (m) await db().storage.from(m[1]).remove([decodeURIComponent(m[2])]);
}

/** Is this one of our files in that area (and folder, e.g. "<owner uuid>/")? Any service set up counts. */
export function isOurFile(url: unknown, area: Area, folder = ""): url is string {
  return typeof url === "string" && !url.includes("..") && providers().some((p) => url.startsWith(`${p.base}/${area}/${folder}`));
}
