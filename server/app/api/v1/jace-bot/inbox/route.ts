// GET: (the Jace bot, or its owner) everyone with a chat with the Jace bot, people who asked for a
//      person first: [{uuid, name, handle, avatar_url, wants_person, unread, last, last_at, banned}]
import { handler, me } from "@/lib/server";
import { inbox, requireJaceStaff } from "@/lib/jaceBot";

export const GET = handler(async (req) => {
  await requireJaceStaff(await me(req));
  return { people: await inbox() };
});
