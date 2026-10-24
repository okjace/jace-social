// Custom sounds (lib/sounds.ts): ringtones, calling sounds and message sounds people upload, and the community
// library of ones they've shared.
// GET ?mine=1: your sounds. GET ?kind=ringtone|calling|message&q=: the community library (most used first).
// POST (body = the audio file, Content-Type audio/..., up to 1 MB) ?name=&kind=ringtone|calling|message&public=1:
//   upload one -> {sound}. public=1 shares it in the community library.
import { randomBytes } from "node:crypto";
import { ApiError, db, handler, me } from "@/lib/server";
import { putFile } from "@/lib/storage";

const TYPES: Record<string, string> = {
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
  "audio/webm": "webm", "audio/mp4": "m4a", "audio/aac": "aac", "audio/x-m4a": "m4a",
};
const MAX_SOUNDS = 30;
const columns = "id, owner, name, kind, url, public, uses, created_at";

export const GET = handler(async (req) => {
  const p = await me(req);
  const q = new URL(req.url).searchParams;
  if (q.get("mine")) {
    const { data, error } = await db().from("sounds").select(columns).eq("owner", p.uuid).order("created_at", { ascending: false });
    if (error) throw error;
    return { sounds: data ?? [] };
  }
  let query = db().from("sounds").select(`${columns}, profiles!sounds_owner_fkey(name, display_name, handle)`).eq("public", true);
  const kind = q.get("kind");
  if (kind === "ringtone" || kind === "calling" || kind === "message") query = query.eq("kind", kind);
  const term = (q.get("q") ?? "").trim().replace(/[%_,()]/g, "");
  if (term) query = query.ilike("name", `%${term}%`);
  const { data, error } = await query.order("uses", { ascending: false }).order("created_at", { ascending: false }).limit(60);
  if (error) throw error;
  return {
    sounds: (data ?? []).map(({ profiles, ...s }) => {
      const o = profiles as unknown as { name: string; display_name: string | null; handle: string | null } | null;
      return { ...s, by: o ? (o.handle ? `@${o.handle}` : o.display_name || o.name) : "someone" };
    }),
  };
});

export const POST = handler(async (req) => {
  const p = await me(req);
  if (p.is_bot) throw new ApiError(403, "Bots can't upload sounds");
  const q = new URL(req.url).searchParams;
  const name = String(q.get("name") ?? "").trim().slice(0, 40);
  if (!name) throw new ApiError(400, "Give the sound a name");
  const kind = q.get("kind");
  if (kind !== "ringtone" && kind !== "calling" && kind !== "message") throw new ApiError(400, 'kind is "ringtone", "calling" or "message"');
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!TYPES[type]) throw new ApiError(400, "Use an MP3, OGG, WAV, M4A, AAC or WebM audio file");
  const { count } = await db().from("sounds").select("id", { count: "exact", head: true }).eq("owner", p.uuid);
  if ((count ?? 0) >= MAX_SOUNDS) throw new ApiError(400, `You can have up to ${MAX_SOUNDS} sounds - delete one first`);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length) throw new ApiError(400, "The file is empty");
  if (bytes.length > 1024 * 1024) throw new ApiError(413, "Sounds can be up to 1 MB (a short clip is best)");
  const url = await putFile(p.uuid, "sounds", `${p.uuid}/${randomBytes(8).toString("hex")}.${TYPES[type]}`, bytes, type);   // lib/storage.ts
  const { data, error } = await db().from("sounds").insert({ owner: p.uuid, name, kind, url, public: q.get("public") === "1" })
    .select(columns).single();
  if (error) throw error;
  return { sound: data };
});
