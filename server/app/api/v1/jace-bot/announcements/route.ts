// The official Jace bot's announcements (lib/jaceBot.ts).
// GET: everyone - newest first (50)
// POST {body}: (the Jace bot) post one: it's in the Announcements tab, and goes to everyone as a message
// DELETE ?id=: (the Jace bot) remove one from the tab (messages already sent stay)
import { ApiError, body, db, handler, me } from "@/lib/server";
import { announce, requireJaceStaff } from "@/lib/jaceBot";

export const GET = handler(async (req) => {
  await me(req);
  const { data, error } = await db().from("jace_bot_announcements").select("id, body, created_at, sent_to")
    .order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  return { announcements: data ?? [] };
});

export const POST = handler(async (req) => {
  await requireJaceStaff(await me(req));
  const b = await body<{ body?: string }>(req);
  return { announcement: await announce(String(b.body ?? "")) };
});

export const DELETE = handler(async (req) => {
  await requireJaceStaff(await me(req));
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!id) throw new ApiError(400, "Which announcement?");
  await db().from("jace_bot_announcements").delete().eq("id", id);
  return { ok: true };
});
