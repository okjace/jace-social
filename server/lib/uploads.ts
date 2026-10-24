// Files in messages. Vercel only accepts ~4.5 MB per request, so files don't pass through
// this server: it hands out a one-time signed upload URL for the public "attachments"
// bucket (50 MB max - Supabase's per-file limit on the free plan; supabase/016_bigger_files.sql),
// the app uploads there directly, then sends the message with the file.
import { randomBytes } from "node:crypto";
import { ApiError, db, supabaseUrl } from "./server";
import type { Attachment } from "./chat";

export const MAX_FILE = 50 * 1024 * 1024;
export const MAX_FILES = 10;
// served from Supabase's domain, so even an HTML file can't touch Jace Social; still, keep
// to things people send each other
const BLOCKED = /^(text\/html|application\/(x-)?(msdownload|javascript|x-sh)|image\/svg)/;

function folderUrl(uuid: string) {
  return `${supabaseUrl()}/storage/v1/object/public/attachments/${uuid}/`;
}

export async function signUpload(uuid: string, name: string, type: string, size: number) {
  const clean = name.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/\s+/g, "_").slice(-80) || "file";
  if (!size || size > MAX_FILE) throw new ApiError(413, "Files can be up to 50 MB");
  if (BLOCKED.test(type)) throw new ApiError(400, "That kind of file can't be sent");
  const path = `${uuid}/${randomBytes(8).toString("hex")}/${clean}`;
  const { data, error } = await db().storage.from("attachments").createSignedUploadUrl(path);
  if (error || !data) throw new ApiError(500, `Couldn't prepare the upload (${error?.message ?? "unknown"})`);
  return {
    path, token: data.token, upload_url: data.signedUrl,
    url: db().storage.from("attachments").getPublicUrl(path).data.publicUrl,
  };
}

/** Attachments a message may carry: only files this player uploaded (their own folder). */
export function cleanAttachments(list: unknown, uuid?: string): Attachment[] {
  if (!Array.isArray(list) || !list.length) return [];
  if (list.length > MAX_FILES) throw new ApiError(400, `Up to ${MAX_FILES} files per message`);
  return list.map((a: any) => {
    const url = String(a?.url ?? "");
    if (!url.startsWith(`${supabaseUrl()}/storage/v1/object/public/attachments/`) || (uuid && !url.startsWith(folderUrl(uuid))))
      throw new ApiError(400, "Upload the file first");
    const out: Attachment = {
      url, name: String(a.name ?? "file").slice(0, 100), type: String(a.type ?? "application/octet-stream").slice(0, 100),
      size: Math.min(MAX_FILE, Math.max(0, Number(a.size) || 0)),
    };
    if (Number(a.width) > 0 && Number(a.height) > 0) { out.width = Math.round(Number(a.width)); out.height = Math.round(Number(a.height)); }
    if (a.no_preview === true) out.no_preview = true;   // the sender chose: show it as a file, not a picture/player
    return out;
  });
}
