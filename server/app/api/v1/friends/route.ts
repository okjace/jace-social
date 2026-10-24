// GET: friends (with online status + what they're doing), incoming and outgoing requests, and
//   jace: the official Jace bot (everyone can message it), with its unread count
// POST {name} or {uuid}: send a friend request. name can be a Minecraft username (works even if they
//   haven't used Jace Social yet), someone's @handle, or a Jace username. "#name" means only Minecraft,
//   "@name" only a handle or Jace username.
// DELETE ?uuid=: remove a friend or cancel/decline a request
import {
  ApiError, body, cleanUuid, db, ensureProfile, friendsOf, handler, JACE_BOT, me, mojangLookup, notify, profileByHandle, publicProfile,
  type Profile,
} from "@/lib/server";
import { ensureJaceBot } from "@/lib/bots";

export const GET = handler(async (req) => {
  const p = await me(req);
  const [friends, pending] = await Promise.all([
    friendsOf(p.uuid),
    db().from("friendships")
      .select("requester, addressee, created_at, a:profiles!friendships_requester_fkey(*), b:profiles!friendships_addressee_fkey(*)")
      .eq("status", "pending").or(`requester.eq.${p.uuid},addressee.eq.${p.uuid}`),
  ]);
  if (pending.error) throw pending.error;
  const { data: unread } = await db().from("messages").select("sender").eq("recipient", p.uuid).is("read_at", null);
  const unreadBy: Record<string, number> = {};
  for (const m of unread ?? []) unreadBy[m.sender] = (unreadBy[m.sender] ?? 0) + 1;
  const jace = p.uuid === JACE_BOT ? null : { ...publicProfile(await ensureJaceBot()), unread: unreadBy[JACE_BOT] ?? 0 };
  // chats with people who aren't your friends (they let anyone message them, or you do)
  const others = p.uuid === JACE_BOT ? [] : await otherChats(p.uuid, new Set(friends.map((f) => f.uuid)), unreadBy);
  return {
    jace,
    friends: friends.filter((f) => f.uuid !== JACE_BOT).map((f) => ({ ...publicProfile(f), unread: unreadBy[f.uuid] ?? 0 })),
    others,
    incoming: (pending.data ?? []).filter((r) => r.addressee === p.uuid && !(r.a as unknown as Profile)?.deleted_at).map((r) => publicProfile(r.a as unknown as Profile)),
    outgoing: (pending.data ?? []).filter((r) => r.requester === p.uuid && !(r.b as unknown as Profile)?.deleted_at).map((r) => publicProfile(r.b as unknown as Profile)),
  };
});

/** They may no longer answer each other's messages (lib: app/api/v1/messages/route.ts dm_allow). */
async function forgetReplies(uuid: string, other: string) {
  const { data } = await db().from("profiles").select("settings").eq("uuid", uuid).maybeSingle();
  const s = (data?.settings ?? {}) as { dm_allow?: string[] };
  if (!s.dm_allow?.includes(other)) return;
  await db().from("profiles").update({ settings: { ...s, dm_allow: s.dm_allow.filter((x) => x !== other) } }).eq("uuid", uuid);
}

/** The newest direct-message chats with people who aren't your friends (20 at most). */
async function otherChats(uuid: string, friends: Set<string>, unreadBy: Record<string, number>) {
  const { data } = await db().from("messages").select("sender, recipient")
    .or(`sender.eq.${uuid},recipient.eq.${uuid}`).order("id", { ascending: false }).limit(400);
  const ids: string[] = [];
  for (const m of data ?? []) {
    const o = m.sender === uuid ? m.recipient : m.sender;
    if (o && o !== JACE_BOT && !friends.has(o) && !ids.includes(o)) ids.push(o);
    if (ids.length >= 20) break;
  }
  if (!ids.length) return [];
  const { data: people } = await db().from("profiles").select("*").in("uuid", ids);
  return ids.map((id) => (people ?? []).find((x) => x.uuid === id) as Profile | undefined)
    .filter((x): x is Profile => !!x && !x.deleted_at)
    // (presence is only for friends)
    .map((x) => ({ ...publicProfile(x), online: false, status: "offline", activity: null, last_seen: null, unread: unreadBy[x.uuid] ?? 0, not_friend: true }));
}

/** Who "name" means: someone's @handle or Jace username (@name, or not a valid Minecraft name), or a Minecraft player. */
async function findTarget(b: { name?: string; uuid?: string }): Promise<Profile> {
  if (b.uuid) {
    const { data } = await db().from("profiles").select("*").eq("uuid", cleanUuid(b.uuid)).maybeSingle();
    if (!data) throw new ApiError(404, "Player not found");
    return data as Profile;
  }
  const raw = String(b.name ?? "").trim();
  // #name: a Minecraft player; @name: a handle or Jace username (the web app always sends one of the
  // two); no prefix (the mod and older apps): Minecraft first, then Jace
  const minecraftOnly = raw.startsWith("#");
  const jaceOnly = raw.startsWith("@") || (!minecraftOnly && !/^[A-Za-z0-9_]{1,16}$/.test(raw));
  const name = raw.replace(/^[@#]/, "");
  if (minecraftOnly) {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new ApiError(400, "Minecraft names are 1-16 letters, numbers and _");
    const target = await mojangLookup(name);
    return await ensureProfile(target.uuid, target.name);
  }
  if (!name) throw new ApiError(400, "Type a username");
  const jace = async () => {
    const byHandle = await profileByHandle(name);
    if (byHandle) return byHandle;
    const { data } = await db().from("profiles").select("*").ilike("jace_name", name.replace(/[%_\\]/g, "")).limit(1).maybeSingle();
    return data?.deleted_at ? null : data as Profile | null;
  };
  if (jaceOnly) {
    const j = await jace();
    if (!j) throw new ApiError(404, `Nobody has the handle @${name}`);
    return j;
  }
  try {
    const target = await mojangLookup(name);
    return await ensureProfile(target.uuid, target.name);
  } catch (e) {
    const j = await jace();                     // not a Minecraft player: maybe a Jace username
    if (j) return j;
    throw e;
  }
}

export const POST = handler(async (req) => {
  const p = await me(req);
  const other = await findTarget(await body<{ name?: string; uuid?: string }>(req));
  if (other.uuid === p.uuid) throw new ApiError(400, "That's you!");
  if (other.deleted_at) throw new ApiError(404, "Player not found");

  const { data: existing } = await db().from("friendships").select("*")
    .or(`and(requester.eq.${p.uuid},addressee.eq.${other.uuid}),and(requester.eq.${other.uuid},addressee.eq.${p.uuid})`)
    .maybeSingle();
  if (existing?.status === "accepted") throw new ApiError(409, `You're already friends with ${other.name}`);
  if (existing?.requester === p.uuid) throw new ApiError(409, `You already sent ${other.name} a request`);
  if (existing) {                                   // they asked us first: accept
    await db().from("friendships").update({ status: "accepted" }).eq("requester", other.uuid).eq("addressee", p.uuid);
    await notify([other.inbox], "friends", { kind: "accepted", uuid: p.uuid, name: p.name });
    return { status: "accepted", friend: publicProfile(other) };
  }
  const { error } = await db().from("friendships").insert({ requester: p.uuid, addressee: other.uuid, status: "pending" });
  if (error) throw error;
  await notify([other.inbox], "friends", { kind: "request", uuid: p.uuid, name: p.name });
  return { status: "pending", friend: publicProfile(other) };
});

export const DELETE = handler(async (req) => {
  const p = await me(req);
  const other = cleanUuid(new URL(req.url).searchParams.get("uuid"));
  const { data } = await db().from("friendships").delete()
    .or(`and(requester.eq.${p.uuid},addressee.eq.${other}),and(requester.eq.${other},addressee.eq.${p.uuid})`)
    .select("requester");
  const { data: o } = await db().from("profiles").select("inbox").eq("uuid", other).maybeSingle();
  if (data?.length && o) await notify([o.inbox], "friends", { kind: "removed", uuid: p.uuid });
  await forgetReplies(p.uuid, other);                // removing someone stops their messages: no answers either way
  await forgetReplies(other, p.uuid);
  return { ok: true };
});
