// POST (image body): upload a background picture for Settings -> Appearance. It's used once you
// save it in your settings (PATCH /me {settings: {background: url}}).
import { handler, me } from "@/lib/server";
import { uploadImage } from "@/lib/images";

export const POST = handler(async (req) => {
  const p = await me(req);
  return { url: await uploadImage(req, `backgrounds/${p.uuid}`) };
});
