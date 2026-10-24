// One custom sound (lib/sounds.ts).
// PATCH {name?, public?}: rename it, or share it in (or take it out of) the community library - yours only
// POST {action: "use"}: you picked it as your ringtone or calling sound (counts toward "most used") -> {url}
// DELETE: delete it - yours, or anyone's for the people running the Jace bot (community moderation)
import { ApiError, body, db, handler, me } from "@/lib/server";
import { isJaceStaff } from "@/lib/jaceBot";
import { removeFile } from "@/lib/storage";

async function sound(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiError(404, "Sound not found");
  const { data } = await db().from("sounds").select("*").eq("id", id).maybeSingle();
  if (!data) throw new ApiError(404, "Sound not found");
  return data as { id: string; owner: string; url: string; public: boolean; uses: number };
}

export const PATCH = handler(async (req, ctx) => {
  const p = await me(req);
  const s = await sound((await ctx.params).id);
  if (s.owner !== p.uuid) throw new ApiError(403, "That's not your sound");
  const b = await body<{ name?: unknown; public?: unknown }>(req);
  const patch: Record<string, unknown> = {};
  if (typeof b.name === "string" && b.name.trim()) patch.name = b.name.trim().slice(0, 40);
  if (typeof b.public === "boolean") patch.public = b.public;
  const { data, error } = await db().from("sounds").update(patch).eq("id", s.id).select("*").single();
  if (error) throw error;
  return { sound: data };
});

export const POST = handler(async (req, ctx) => {
  const p = await me(req);
  const s = await sound((await ctx.params).id);
  if (!s.public && s.owner !== p.uuid) throw new ApiError(404, "Sound not found");
  if (s.owner !== p.uuid) await db().from("sounds").update({ uses: s.uses + 1 }).eq("id", s.id);
  return { url: s.url };
});

export const DELETE = handler(async (req, ctx) => {
  const p = await me(req);
  const s = await sound((await ctx.params).id);
  if (s.owner !== p.uuid && !(await isJaceStaff(p))) throw new ApiError(403, "That's not your sound");
  await db().from("sounds").delete().eq("id", s.id);
  await removeFile(s.url);                         // wherever it's stored (lib/storage.ts)
  return { ok: true };
});
