// GET: the Jace message sync's regular run (vercel.json "crons", every few minutes): resend queued
// messages that are due, then pull new Jace messages for everyone connected, longest-waiting first.
// Only Vercel Cron may call it: Authorization: Bearer <CRON_SECRET>.
import { syncEveryone } from "@/lib/jaceSync";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET isn't set" }, { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Not allowed" }, { status: 401 });
  try {
    return Response.json(await syncEveryone(50_000));
  } catch (e) {
    console.error("jace cron", e);
    return Response.json({ error: "Sync failed" }, { status: 500 });
  }
}
