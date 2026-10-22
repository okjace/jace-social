// POST (body = the image, Content-Type image/png|jpeg|gif|webp - animated too -, up to 4 MB): new profile picture
// DELETE: back to your Minecraft head (or initials)
import { db, friendsOf, handler, me, notify } from "@/lib/server";
import { uploadImage } from "@/lib/images";
import { pushProfileToJace } from "@/lib/jaceAdmin";

async function changed(uuid: string) {
  const friends = await friendsOf(uuid);
  await notify(friends.map((f) => f.inbox), "presence", { uuid });
}

export const POST = handler(async (req) => {
  const p = await me(req);
  const url = await uploadImage(req, p.uuid);
  await db().from("profiles").update({ avatar_url: url }).eq("uuid", p.uuid);
  await changed(p.uuid);
  pushProfileToJace(p, { picture: url });                // your Jace picture follows (lib/jaceAdmin.ts)
  return { avatar_url: url };
});

export const DELETE = handler(async (req) => {
  const p = await me(req);
  await db().from("profiles").update({ avatar_url: null }).eq("uuid", p.uuid);
  await changed(p.uuid);
  pushProfileToJace(p, { picture: null });
  return { ok: true };
});
