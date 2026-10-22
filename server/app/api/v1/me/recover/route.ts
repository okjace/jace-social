// POST {recovery_id}: Settings -> Accounts -> Delete account, with a recovery ID typed in: this account
// turns back into the deleted one (the same as pasting it to the Jace bot - lib/accountDeletion.ts).
// -> {ok, message}
import { body, handler, me } from "@/lib/server";
import { recover } from "@/lib/accountDeletion";

export const POST = handler(async (req) => {
  const p = await me(req);
  const b = await body<{ recovery_id?: string }>(req);
  return recover(p, String(b.recovery_id ?? ""));
});
