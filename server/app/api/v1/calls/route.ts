// POST {to, call_id, kind: offer|answer|hangup|renegotiate|reanswer, sdp?}: send call setup to a friend
//   (renegotiate/reanswer: a new description mid-call, e.g. when screen sharing starts)
// GET ?id=<signal id>: read a call signal sent to you (the live event only carries its id)
// GET ?call_id=&after=<signal id>: the signals of that call sent to you after that one (newest 20) -
//   the app checks every few seconds during a call, in case a live event was missed
import { ApiError, areFriends, body, cleanUuid, db, handler, me, notify } from "@/lib/server";

export const POST = handler(async (req) => {
  const p = await me(req);
  const b = await body<{ to?: string; call_id?: string; kind?: string; sdp?: string }>(req);
  const to = cleanUuid(b.to);
  const callId = String(b.call_id ?? "");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(callId)) throw new ApiError(400, "Bad call id");
  const kind = String(b.kind ?? "");
  if (!["offer", "answer", "hangup", "renegotiate", "reanswer"].includes(kind))
    throw new ApiError(400, "kind must be offer, answer, hangup, renegotiate or reanswer");
  const sdp = kind === "hangup" ? null : String(b.sdp ?? "");
  if (sdp !== null && (!sdp.startsWith("v=0") || sdp.length > 30000)) throw new ApiError(400, "Bad call description");
  if (!(await areFriends(p.uuid, to))) throw new ApiError(403, "You can only call friends");
  if (kind === "offer") {
    const minuteAgo = new Date(Date.now() - 60_000).toISOString();
    const { count } = await db().from("call_signals").select("id", { count: "exact", head: true })
      .eq("sender", p.uuid).eq("kind", "offer").gt("created_at", minuteAgo);
    if ((count ?? 0) >= 6) throw new ApiError(429, "Too many calls - try again in a minute");
  }
  // old signals are only useful while a call starts
  await db().from("call_signals").delete().lt("created_at", new Date(Date.now() - 10 * 60_000).toISOString());
  const { data, error } = await db().from("call_signals")
    .insert({ call_id: callId, sender: p.uuid, recipient: to, kind, sdp }).select("id").single();
  if (error) throw error;
  const { data: o } = await db().from("profiles").select("inbox").eq("uuid", to).single();
  if (o) await notify([o.inbox], "call", { id: data.id, kind, call_id: callId, from: p.uuid, name: p.name });
  return { ok: true, id: data.id };
});

export const GET = handler(async (req) => {
  const p = await me(req);
  const q = new URL(req.url).searchParams;
  const callId = q.get("call_id");
  if (callId) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(callId)) throw new ApiError(400, "Bad call id");
    const { data, error } = await db().from("call_signals").select("id, call_id, sender, kind")
      .eq("call_id", callId).eq("recipient", p.uuid).gt("id", Number(q.get("after")) || 0).order("id").limit(20);
    if (error) throw error;
    return { signals: (data ?? []).map((s) => ({ id: s.id, kind: s.kind, call_id: s.call_id, from: s.sender })) };
  }
  const id = Number(q.get("id"));
  if (!id) throw new ApiError(400, "id is required");
  const { data } = await db().from("call_signals")
    .select("id, call_id, sender, kind, sdp, created_at").eq("id", id).eq("recipient", p.uuid).maybeSingle();
  if (!data) throw new ApiError(404, "Call not found");
  const { data: s } = await db().from("profiles").select("name").eq("uuid", data.sender).single();
  return { signal: { ...data, name: s?.name ?? "" } };
});
