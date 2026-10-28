// POST (image body): set your profile banner; DELETE: remove it
import { checkPicture } from "@/lib/automod";
import { assertCanPost } from "@/lib/moderation";
import { db, friendsOf, handler, me, notify } from "@/lib/server";
import { uploadImage } from "@/lib/images";

export const POST = handler(async (req) => {
  const p = await me(req);
  assertCanPost(p);
  await checkPicture(p, "a banner", "profile");               // Jace's auto moderation (lib/automod.ts)
  const url = await uploadImage(req, `banners/${p.uuid}`);
  await db().from("profiles").update({ banner_url: url }).eq("uuid", p.uuid);
  await notify((await friendsOf(p.uuid)).map((f) => f.inbox), "presence", { uuid: p.uuid });
  return { banner_url: url };
});

export const DELETE = handler(async (req) => {
  const p = await me(req);
  await db().from("profiles").update({ banner_url: null }).eq("uuid", p.uuid);
  return { ok: true };
});
