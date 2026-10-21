// Picture uploads (profile pictures and banners - animated GIF/WebP too -, server and group icons,
// backgrounds) to the public "avatars" bucket.
import { randomBytes } from "node:crypto";
import { ApiError, db } from "./server";

const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** Save the request body (an image) under folder/ and return its public URL. */
export async function uploadImage(req: Request, folder: string) {
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!TYPES[type]) throw new ApiError(400, "Use a PNG, JPG, GIF or WebP image");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length) throw new ApiError(400, "The image is empty");
  // 4 MB, so animated GIF and WebP pictures and banners fit (under Vercel's 4.5 MB request limit;
  // the "avatars" bucket's own limit is set in supabase/009_animated_pictures.sql)
  if (bytes.length > 4 * 1024 * 1024) throw new ApiError(413, "Pictures can be up to 4 MB");
  const path = `${folder}/${randomBytes(8).toString("hex")}.${TYPES[type]}`;
  const { error } = await db().storage.from("avatars").upload(path, bytes, { contentType: type, upsert: false });
  if (error) throw new ApiError(500, `Couldn't save the image (${error.message})`);
  return db().storage.from("avatars").getPublicUrl(path).data.publicUrl;
}

