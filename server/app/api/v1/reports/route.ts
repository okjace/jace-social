// Reports to Jace Social's staff (lib/reports.ts).
// POST {scope: "d" | "c", message_id} | {uuid}, reason (spam | harassment | hate | sexual | violence | scam | other),
//      details?: report a message (direct or channel) or a person -> {ok, id}
// GET ?status=open|all: staff only -> {reports, people, open}
import { body, handler, me } from "@/lib/server";
import { requireJaceStaff } from "@/lib/jaceBot";
import { listReports, report } from "@/lib/reports";

export const POST = handler(async (req) => {
  const p = await me(req);
  return report(req, p, await body(req));
});

export const GET = handler(async (req) => {
  await requireJaceStaff(await me(req));
  return listReports(new URL(req.url).searchParams.get("status") === "all" ? "all" : "open");
});
