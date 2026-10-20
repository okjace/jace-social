// Jace sends the browser back here with ?code&state. We finish sign-in or linking,
// then either redirect the web app (token in the #fragment, never in logs) or show
// "you can close this tab" while the app picks the result up by polling.
import { ApiError, createSession, db, mergeProfiles, newPlayerId, siteUrl, supabaseUrl, token, type Profile } from "@/lib/server";
import { jaceUserFromCode, type JaceUser } from "@/lib/jace";
import { saveConnection } from "@/lib/jaceSync";

type Req = { state: string; purpose: "signin" | "link"; link_uuid: string | null; poll_hash: string | null; return_to: string };

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const { data: r } = await db().from("oauth_requests").select("*").eq("state", sp.get("state") ?? "").maybeSingle();
  if (!r) return page("This sign-in link expired", "Go back and try again.");
  const request = r as Req;
  let result: Record<string, unknown>;
  try {
    if (sp.get("error")) throw new ApiError(400, sp.get("error_description") || "Sign-in was cancelled");
    const user = await jaceUserFromCode(sp.get("code") ?? "");
    result = request.purpose === "signin" ? await signIn(user) : await link(user, request.link_uuid!);
  } catch (e) {
    result = { error: e instanceof ApiError ? e.message : "Something went wrong signing in" };
    if (!(e instanceof ApiError)) console.error(e);
  }
  if (request.poll_hash) {                                   // an app is waiting
    await db().from("oauth_requests").update({ result }).eq("state", request.state);
    return result.error ? page("Couldn't sign in", String(result.error))
      : page(request.purpose === "link" ? "Jace account linked" : "Signed in", "You can close this tab and go back to the app.");
  }
  await db().from("oauth_requests").delete().eq("state", request.state);
  const frag = new URLSearchParams(Object.entries(result).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  return Response.redirect(`${siteUrl()}${request.return_to}#${frag}`, 302);
}

async function signIn(u: JaceUser) {
  const { data: existing } = await db().from("profiles").select("*").eq("jace_sub", u.sub).maybeSingle();
  let p = existing as Profile | null;
  if (p) {
    const patch: Partial<Profile> = {};
    if (p.jace_name !== u.username) patch.jace_name = u.username;
    // a placeholder made for their Jace messages (lib/jaceSync.ts) becomes their account
    if (!p.signed_up) { patch.signed_up = new Date().toISOString(); if (!p.avatar_url && u.picture) patch.avatar_url = u.picture; }
    if (Object.keys(patch).length) await db().from("profiles").update(patch).eq("uuid", p.uuid);
  } else {
    const row = {
      uuid: newPlayerId(), name: u.username, inbox: token(), signed_up: new Date().toISOString(),
      jace_sub: u.sub, jace_name: u.username, mc_linked: false, avatar_url: u.picture,
    };
    const { data, error } = await db().from("profiles").insert(row).select("*").single();
    if (error) throw error;
    p = data as Profile;
  }
  await saveConnection(p.uuid, u);                   // keep the token for syncing Jace messages
  const session = await createSession(p.uuid);
  return { ...session, uuid: p.uuid, realtime_url: supabaseUrl() ?? "", realtime_key: process.env.SUPABASE_PUBLISHABLE_KEY ?? "" };
}

async function link(u: JaceUser, uuid: string) {
  const { data: other } = await db().from("profiles").select("uuid, mc_linked").eq("jace_sub", u.sub).maybeSingle();
  if (other && other.uuid !== uuid) {
    if (other.mc_linked) throw new ApiError(409, "That Jace account is already linked to another Minecraft account");
    await mergeProfiles(other.uuid, uuid);   // the Jace-only account joins this one
  }
  const { error } = await db().from("profiles").update({ jace_sub: u.sub, jace_name: u.username }).eq("uuid", uuid);
  if (error) throw error;
  await saveConnection(uuid, u);                     // linking (or "Connect Jace messages") keeps the token too
  return { ok: "true", jace_name: u.username };
}

function page(title: string, text: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(title)}</title><body style="font:16px system-ui;background:#111317;color:#e6e8eb;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="color:#3ddc84">${esc(title)}</h1><p>${esc(text)}</p></div>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
