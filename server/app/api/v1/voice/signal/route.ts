// Connection setup inside a voice room (each pair of people has its own connection).
// POST {channel_id, to, kind: offer|answer, sdp}: send it to someone in the same room
// GET ?id=: read one sent to you (the live "voice_signal" event only carries its id)
// GET ?channel_id=&after=<id>: the ones sent to you in that room after that one (in case a live event
//   was missed - the app checks every few seconds while in a room)
import { ApiError, body, cleanUuid, db, handler, me, notify } from "@/lib/server";
import { cleanId } from "@/lib/chat";

export const POST = handler(async (req) => {
  const p = await me(req);
  const b = await body<{ channel_id?: string; to?: string; kind?: string; sdp?: string }>(req);
  const channelId = cleanId(b.channel_id);
  const to = cleanUuid(b.to);
  if (!["offer", "answer"].includes(String(b.kind))) throw new ApiError(400, "kind must be offer or answer");
  const sdp = String(b.sdp ?? "");
  if (!sdp.startsWith("v=0") || sdp.length > 30000) throw new ApiError(400, "Bad connection description");
  const { data: both } = await db().from("voice_states").select("uuid").eq("channel_id", channelId).in("uuid", [p.uuid, to]);
  if ((both ?? []).length !== 2) throw new ApiError(404, "They aren't in this room");
  await db().from("voice_signals").delete().lt("created_at", new Date(Date.now() - 5 * 60_000).toISOString());
  const { data, error } = await db().from("voice_signals")
    .insert({ channel_id: channelId, sender: p.uuid, recipient: to, kind: b.kind, sdp }).select("id").single();
  if (error) throw error;
  const { data: o } = await db().from("profiles").select("inbox").eq("uuid", to).single();
  if (o) await notify([o.inbox], "voice_signal", { id: data.id, from: p.uuid, kind: b.kind, channel_id: channelId });
  return { ok: true };
});

export const GET = handler(async (req) => {
  const p = await me(req);
  const q = new URL(req.url).searchParams;
  if (q.get("channel_id") && q.get("latest")) {               // ?channel_id=&latest=1: just the newest id (on joining)
    const { data } = await db().from("voice_signals").select("id").eq("channel_id", cleanId(q.get("channel_id")))
      .eq("recipient", p.uuid).order("id", { ascending: false }).limit(1).maybeSingle();
    return { latest: data?.id ?? 0 };
  }
  if (q.get("channel_id")) {
    const { data, error } = await db().from("voice_signals").select("id, channel_id, sender, kind")
      .eq("channel_id", cleanId(q.get("channel_id"))).eq("recipient", p.uuid).gt("id", Number(q.get("after")) || 0).order("id").limit(30);
    if (error) throw error;
    return { signals: (data ?? []).map((s) => ({ id: s.id, from: s.sender, kind: s.kind, channel_id: s.channel_id })) };
  }
  const id = Number(q.get("id"));
  const { data } = await db().from("voice_signals").select("id, channel_id, sender, kind, sdp").eq("id", id).eq("recipient", p.uuid).maybeSingle();
  if (!data) throw new ApiError(404, "Not found");
  return { signal: data };
});
