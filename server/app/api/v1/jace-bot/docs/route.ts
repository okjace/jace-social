// The official Jace bot's Docs: help articles, and what its AI answers from (lib/jaceBot.ts).
// GET: everyone - [{id, slug, title, body, position, updated_at}]
// POST {title, body, slug?, position?}: (the Jace bot) add one
// PATCH {id, title?, body?, position?}: (the Jace bot) change one
// DELETE ?id=: (the Jace bot) remove one
import { ApiError, body, db, handler, me } from "@/lib/server";
import { requireJaceStaff } from "@/lib/jaceBot";

const clean = (b: { title?: unknown; body?: unknown }) => {
  const out: Record<string, unknown> = {};
  if (b.title !== undefined) {
    const t = String(b.title).trim();
    if (!t || t.length > 120) throw new ApiError(400, "Titles are 1 to 120 characters");
    out.title = t;
  }
  if (b.body !== undefined) {
    const t = String(b.body).trim();
    if (t.length > 20000) throw new ApiError(400, "Docs can be up to 20000 characters");
    out.body = t;
  }
  return out;
};

export const GET = handler(async (req) => {
  await me(req);
  const { data, error } = await db().from("jace_bot_docs").select("*").order("position").order("title");
  if (error) throw error;
  return { docs: data ?? [] };
});

export const POST = handler(async (req) => {
  await requireJaceStaff(await me(req));
  const b = await body<{ title?: string; body?: string; slug?: string; position?: number }>(req);
  const fields = clean({ title: b.title ?? "", body: b.body ?? "" });
  const slug = (b.slug || String(fields.title)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "doc";
  const { data, error } = await db().from("jace_bot_docs")
    .insert({ ...fields, slug: `${slug}-${Date.now().toString(36)}`, position: Number(b.position) || 100 }).select("*").single();
  if (error) throw error;
  return { doc: data };
});

export const PATCH = handler(async (req) => {
  await requireJaceStaff(await me(req));
  const b = await body<{ id?: string; title?: string; body?: string; position?: number }>(req);
  if (!b.id) throw new ApiError(400, "Which doc?");
  const fields = { ...clean(b), ...(b.position !== undefined ? { position: Number(b.position) || 0 } : {}), updated_at: new Date().toISOString() };
  const { data, error } = await db().from("jace_bot_docs").update(fields).eq("id", b.id).select("*").maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiError(404, "Doc not found");
  return { doc: data };
});

export const DELETE = handler(async (req) => {
  await requireJaceStaff(await me(req));
  const id = new URL(req.url).searchParams.get("id");
  if (!id) throw new ApiError(400, "Which doc?");
  await db().from("jace_bot_docs").delete().eq("id", id);
  return { ok: true };
});
