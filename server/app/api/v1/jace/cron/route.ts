// GET: the Jace message sync's regular run (vercel.json "crons", every few minutes): resend queued
// messages that are due, then pull new Jace messages for everyone connected, longest-waiting first.
// Also deletes for good the accounts deleted more than 10 days ago (lib/accountDeletion.ts).
// Only Vercel Cron may call it: Authorization: Bearer <CRON_SECRET>.
import { syncEveryone } from "@/lib/jaceSync";
import { purgeDeletedAccounts } from "@/lib/accountDeletion";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET isn't set" }, { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Not allowed" }, { status: 401 });
  try {
    const purged = await purgeDeletedAccounts().catch((e) => { console.error("purge deleted accounts", e); return 0; });
    return Response.json({ ...(await syncEveryone(50_000)), purged });
  } catch (e) {
    console.error("jace cron", e);
    return Response.json({ error: "Sync failed" }, { status: 500 });
  }
}
