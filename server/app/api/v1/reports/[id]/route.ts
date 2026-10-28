// PATCH {status: resolved | dismissed | open, resolution?, delete_message?}: staff close (or reopen) a report,
// maybe deleting the reported message (lib/reports.ts). Muting / banning: POST /api/v1/moderation.
import { body, handler, me } from "@/lib/server";
import { requireJaceStaff } from "@/lib/jaceBot";
import { closeReport } from "@/lib/reports";

export const PATCH = handler(async (req, ctx) => {
  const p = await me(req);
  await requireJaceStaff(p);
  return closeReport(p, Number((await ctx.params).id), await body(req));
});
