// Syncing your direct messages and group chats with your Jace messages (lib/jaceSync.ts).
// GET: {available, state: none|ok|disconnected|banned, sync_enabled, imported, last_sync_at, last_error}
//   none / disconnected: connect (or reconnect) with POST /link/jace, which signs in with Jace again
// PATCH {sync: boolean}: the "Sync messages with Jace" switch
// DELETE: "Disconnect Jace messages" - deletes the stored Jace token
import { ApiError, body, handler, me } from "@/lib/server";
import { connectionInfo, disconnect, setSyncEnabled } from "@/lib/jaceSync";

export const GET = handler(async (req) => connectionInfo((await me(req)).uuid));

export const PATCH = handler(async (req) => {
  const p = await me(req);
  const b = await body<{ sync?: unknown }>(req);
  if (typeof b.sync !== "boolean") throw new ApiError(400, "Say sync: true or false");
  const info = await connectionInfo(p.uuid);
  if (info.state === "none") throw new ApiError(400, "Connect your Jace messages first");
  await setSyncEnabled(p.uuid, b.sync);
  return connectionInfo(p.uuid);
});

export const DELETE = handler(async (req) => {
  const p = await me(req);
  await disconnect(p.uuid);
  return connectionInfo(p.uuid);
});
