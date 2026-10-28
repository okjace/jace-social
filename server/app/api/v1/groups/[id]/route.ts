// PATCH {name}: rename a group chat (any member)
import { checkName } from "@/lib/automod";
import { assertCanPost } from "@/lib/moderation";
import { body, db, handler, me } from "@/lib/server";
import { channelFor, cleanName, notifyChanged, postMessage } from "@/lib/chat";
import { ApiError } from "@/lib/server";

export const PATCH = handler(async (req, ctx) => {
  const p = await me(req);
  const { channel, members } = await channelFor((await ctx.params).id, p.uuid);
  if (channel.server_id) throw new ApiError(400, "That's a server channel");
  const name = cleanName((await body<{ name?: string }>(req)).name, "Group name");
  assertCanPost(p);
  await checkName(p, "a group chat's name", name);
  await db().from("channels").update({ name }).eq("id", channel.id);
  await postMessage(channel, members, null, `${p.display_name || p.name} renamed the group to "${name}"`, "system");
  await notifyChanged(members, "groups", { kind: "changed", id: channel.id });
  return { ok: true };
});
