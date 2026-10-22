// The official Jace bot's Broadcast tab (lib/jaceBot.ts), for the people running it.
// POST {body}: a normal message from the Jace bot to everyone (not listed in Announcements) -> {sending: true};
//   the sender gets a "broadcast_sent" {sent} event when it's done.
import { body, handler, me } from "@/lib/server";
import { broadcast, requireJaceStaff } from "@/lib/jaceBot";

export const POST = handler(async (req) => {
  const p = await me(req);
  await requireJaceStaff(p);
  const b = await body<{ body?: string }>(req);
  return broadcast(p, String(b.body ?? ""));
});
