// POST (image body): upload a background picture for Settings -> Appearance. It's used once you
// save it in your settings (PATCH /me {settings: {background: url}}).
import { checkPicture } from "@/lib/automod";
import { assertCanPost } from "@/lib/moderation";
import { handler, me } from "@/lib/server";
import { uploadImage } from "@/lib/images";

export const POST = handler(async (req) => {
  const p = await me(req);
  assertCanPost(p);
  await checkPicture(p, "a background", "profile");               // Jace's auto moderation (lib/automod.ts)
  return { url: await uploadImage(req, `backgrounds/${p.uuid}`) };
});
