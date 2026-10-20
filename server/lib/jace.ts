// "Sign in with Jace" (OAuth 2 authorization code flow against jaceo.vercel.app).
// The client secret stays on this server: browsers and apps only ever see our own session tokens.
import { ApiError, siteUrl } from "./server";

/** Jace itself. JACE_URL points it elsewhere for testing (scripts/mock-jace.mjs); never in production. */
export const JACE = (process.env.JACE_URL || "https://jaceo.vercel.app").replace(/\/+$/, "");

export const jaceConfigured = () => !!(process.env.JACE_OAUTH_CLIENT_ID && process.env.JACE_OAUTH_CLIENT_SECRET);

/** The one redirect URI to register with Jace. */
export const jaceCallbackUrl = () => `${siteUrl()}/api/v1/auth/jace/callback`;

export function jaceAuthorizeUrl(state: string) {
  if (!jaceConfigured()) throw new ApiError(503, "Sign in with Jace isn't set up on this server yet");
  return `${JACE}/oauth/authorize?` + new URLSearchParams({
    response_type: "code", client_id: process.env.JACE_OAUTH_CLIENT_ID!, redirect_uri: jaceCallbackUrl(),
    // messages: Jace Social is an official Jace app, so this asks nothing extra (no consent
    // screen) and lets it sync people's Jace messages (lib/jaceSync.ts)
    scope: "profile messages", state,
  });
}

export type JaceUser = {
  sub: string; username: string; picture: string | null; banned: boolean; muted: boolean;
  /** the access token (365 days, no refresh): kept encrypted for syncing messages */
  token: string; scope: string;
};

/** Trade the code from the redirect for the Jace account it belongs to (and its access token). */
export async function jaceUserFromCode(code: string): Promise<JaceUser> {
  const r = await fetch(`${JACE}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: jaceCallbackUrl(),
      client_id: process.env.JACE_OAUTH_CLIENT_ID!, client_secret: process.env.JACE_OAUTH_CLIENT_SECRET!,
    }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new ApiError(401, `Jace sign-in failed (${t.error_description || t.error || r.status})`);
  const u = await fetch(`${JACE}/api/oauth/userinfo`, { headers: { Authorization: `Bearer ${t.access_token}` } });
  const d = await u.json().catch(() => ({}));
  if (!u.ok) throw new ApiError(401, "Couldn't read your Jace account");
  // accept the usual OpenID-style names for each field
  const sub = String(d.sub ?? d.id ?? "");
  const username = String(d.preferred_username ?? d.username ?? d.name ?? "").slice(0, 32);
  if (!sub) throw new ApiError(502, "Jace didn't say who you are");
  const picture = typeof (d.picture ?? d.avatar_url ?? d.image) === "string" ? String(d.picture ?? d.avatar_url ?? d.image) : null;
  return { sub, username: username || "Jace user", picture, banned: d.banned === true, muted: d.muted === true,
           token: String(t.access_token), scope: String(t.scope ?? "") };
}
