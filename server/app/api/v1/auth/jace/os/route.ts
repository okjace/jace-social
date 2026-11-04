// Jace OS: signing in with the computer's Jace account. The desktop app (app/jace_social_app/jaceos.py)
// asks the computer's `jace-account --token-for <client_id>` for a Jace access token for Jace Social
// (Jace's token exchange), then sends it here. It's checked with Jace's /api/oauth/introspect: it must
// be active and issued to Jace Social's own client id. Then it's the same as "Sign in with Jace".
// GET  -> {client_id, scope}: what to ask jace-account for (null client_id: Jace sign-in isn't set up)
// POST {access_token} -> the usual session {token, expires_at, uuid, realtime_url, realtime_key}
import { ApiError, body, handler } from "@/lib/server";
import { introspectJace, jaceUserFromToken } from "@/lib/jace";
import { signInWithJace } from "@/lib/jaceSignIn";

export const GET = handler(async () => ({ client_id: process.env.JACE_OAUTH_CLIENT_ID ?? null, scope: "profile messages" }));

export const POST = handler(async (req) => {
  const t = String((await body<{ access_token?: unknown }>(req)).access_token ?? "");
  if (!t || t.length > 4096) throw new ApiError(400, "access_token is required");
  const ok = await introspectJace(t);
  if (!ok) throw new ApiError(401, "That Jace token isn't valid for Jace Social");
  const user = await jaceUserFromToken(t, ok.scope);
  if (user.sub !== ok.sub) throw new ApiError(401, "That Jace token isn't valid for Jace Social");
  return signInWithJace(user);
});
