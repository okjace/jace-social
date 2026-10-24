// Files in messages. Vercel only accepts ~4.5 MB per request, so files don't pass through this
// server: it hands out a one-time signed upload for one of the storage services (lib/storage.ts -
// R2, B2 or Supabase, up to 500 MB on R2/B2), the app uploads there directly, then sends the message.
import { randomBytes } from "node:crypto";
import { ApiError } from "./server";
import { isOurFile, largestFile, signUpload as signStorageUpload } from "./storage";
import type { Attachment } from "./chat";

export const MAX_FILES = 10;
// served from the storage service's own domain, so even an HTML file can't touch Jace Social; still,
// keep to things people send each other
const BLOCKED = /^(text\/html|application\/(x-)?(msdownload|javascript|x-sh)|image\/svg)/;

export async function signUpload(uuid: string, name: string, type: string, size: number) {
  const clean = name.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/\s+/g, "_").slice(-80) || "file";
  if (!size || size < 0) throw new ApiError(400, "The file is empty");
  if (size > largestFile()) throw new ApiError(413, `Files can be up to ${Math.round(largestFile() / 1024 / 1024)} MB`);
  if (BLOCKED.test(type)) throw new ApiError(400, "That kind of file can't be sent");
  return signStorageUpload(uuid, "attachments", `${uuid}/${randomBytes(8).toString("hex")}/${clean}`, type, size);
}

/** Attachments a message may carry: only files this player uploaded (their own folder, on any of our storage). */
export function cleanAttachments(list: unknown, uuid?: string): Attachment[] {
  if (!Array.isArray(list) || !list.length) return [];
  if (list.length > MAX_FILES) throw new ApiError(400, `Up to ${MAX_FILES} files per message`);
  return list.map((a: any) => {
    const url = String(a?.url ?? "");
    if (!isOurFile(url, "attachments", uuid ? `${uuid}/` : "")) throw new ApiError(400, "Upload the file first");
    const out: Attachment = {
      url, name: String(a.name ?? "file").slice(0, 100), type: String(a.type ?? "application/octet-stream").slice(0, 100),
      size: Math.min(largestFile(), Math.max(0, Number(a.size) || 0)),
    };
    if (Number(a.width) > 0 && Number(a.height) > 0) { out.width = Math.round(Number(a.width)); out.height = Math.round(Number(a.height)); }
    if (a.no_preview === true) out.no_preview = true;   // the sender chose: show it as a file, not a picture/player
    return out;
  });
}

const previewable = (a: Attachment) => /^(image|video|audio)\//.test(a.type);

/**
 * Editing a message (its text, and its previews turned on or off after sending) -> what to save, and
 * whether to look for a link preview again. link_preview / file_previews: true or false from the app's
 * edit box (left out by older apps: a new text gets a new link preview, files stay as they are).
 */
export function editChanges(m: { body: string; attachments?: Attachment[] | null; embeds?: unknown[] | null },
  text: string, b: { link_preview?: unknown; file_previews?: unknown }) {
  const changes: Record<string, unknown> = {};
  const textChanged = text !== m.body;
  if (textChanged) { changes.body = text; changes.edited_at = new Date().toISOString(); }
  if (typeof b.file_previews === "boolean" && m.attachments?.length) {
    const files = m.attachments.map((a) => {
      if (!previewable(a)) return a;
      const { no_preview: _, ...rest } = a;
      return b.file_previews ? rest : { ...rest, no_preview: true };
    });
    if (JSON.stringify(files) !== JSON.stringify(m.attachments)) changes.attachments = files;
  }
  let lookUp = false;
  if (b.link_preview === false) { if (m.embeds?.length) changes.embeds = []; }
  else if (textChanged || (b.link_preview === true && !m.embeds?.length)) { changes.embeds = []; lookUp = true; }
  return { changes, lookUp };
}
