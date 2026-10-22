// Jace ban appeals, for Jace Official's owner and admins only (Jace decides who - lib/appeals.ts).
// GET: {appeals: [{user_id, username, picture, status: banned|muted|active|deleted, ban_reason, banned_at,
//   mute_reason, muted_at, last_message, waiting, unread}]}, newest activity first; {reconnect: true}
//   when their Jace sign-in stopped working. Anyone else: 404, the same as a page that doesn't exist.
import { handler, me } from "@/lib/server";
import { listAppeals } from "@/lib/appeals";

export const GET = handler(async (req) => listAppeals(await me(req)));
