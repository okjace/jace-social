// POST: "Sync now" - bring in what's new from Jace and resend anything waiting -> the same as
//       GET /jace/messages, plus {imported}
import { ApiError, handler, me } from "@/lib/server";
import { connectionInfo, retryOutbox, syncPerson } from "@/lib/jaceSync";

export const maxDuration = 60;

export const POST = handler(async (req) => {
  const p = await me(req);
  const info = await connectionInfo(p.uuid);
  if (info.state !== "ok") throw new ApiError(400, info.state === "banned" ? "Your Jace account is banned" : "Connect your Jace messages first");
  if (!info.sync_enabled) throw new ApiError(400, "Turn on \"Sync messages with Jace\" first");
  const r = await syncPerson(p.uuid);
  await retryOutbox({ sender: p.uuid });
  return { ...(await connectionInfo(p.uuid)), imported: r.imported };
});
