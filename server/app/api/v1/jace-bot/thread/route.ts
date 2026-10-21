// Your chat with the official Jace bot (lib/jaceBot.ts).
// GET: {mode: "ai" | "human"} - who answers: the AI, or a person from Jace
// POST {human: boolean}: "Talk to a person" (true) or "Back to the AI" (false)
import { ApiError, body, handler, JACE_BOT, me } from "@/lib/server";
import { setThreadMode, threadMode } from "@/lib/jaceBot";

export const GET = handler(async (req) => ({ mode: await threadMode((await me(req)).uuid) }));

export const POST = handler(async (req) => {
  const p = await me(req);
  if (p.uuid === JACE_BOT) throw new ApiError(400, "That's the Jace bot itself");
  const b = await body<{ human?: unknown }>(req);
  if (typeof b.human !== "boolean") throw new ApiError(400, "Say human: true or false");
  await setThreadMode(p, b.human);
  return { mode: b.human ? "human" : "ai" };
});
