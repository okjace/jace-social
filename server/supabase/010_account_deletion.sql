-- Jace Social: deleting your account by asking the Jace bot, with a recovery ID for 10 days
-- (lib/accountDeletion.ts). Run once in Supabase -> SQL Editor (after 008_jace_bot.sql). Safe to re-run.
--
-- Deleting doesn't erase anything for 10 days: the account is set aside under a new hidden id (so
-- your Minecraft / Jace login is free, and signing in again makes a new account), with everything
-- still attached. Pasting the recovery ID to the Jace bot in that new account turns it back into the
-- old one. After 10 days the set-aside account is deleted for good (by the regular cron run).

alter table profiles add column if not exists deleted_at         timestamptz;
alter table profiles add column if not exists recover_hash       text unique;   -- sha256 of the recovery ID
alter table profiles add column if not exists recover_expires_at timestamptz;
alter table profiles add column if not exists deleted_jace_sub   text;          -- its Jace login, given back on recovery if still free
create index if not exists profiles_deleted on profiles(recover_expires_at) where deleted_at is not null;

-- Every reference to a profile follows it when its uuid changes (on update cascade), keeping each
-- constraint's name and what happens on delete.
do $$
declare c record;
begin
  for c in select conrelid::regclass as tbl, conname, pg_get_constraintdef(oid) as def from pg_constraint
           where contype = 'f' and confrelid = 'public.profiles'::regclass and confupdtype <> 'c'
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
    execute format('alter table %s add constraint %I %s on update cascade', c.tbl, c.conname, c.def);
  end loop;
end $$;

-- Give a profile a new uuid; everything that's theirs follows.
create or replace function rename_profile(old_uuid text, new_uuid text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update profiles set uuid = new_uuid where uuid = old_uuid;
  update channel_overrides set target_id = new_uuid where target_type = 'member' and target_id = old_uuid;   -- not a foreign key
end $$;

-- Delete (set aside) an account: signed out everywhere, Jace messages disconnected, its login freed.
create or replace function park_account(acct text, parked text, hash text, expires timestamptz) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from sessions where uuid = acct;
  delete from voice_states where uuid = acct;
  delete from jace_connections where uuid = acct;          -- the encrypted Jace token
  update profiles set deleted_at = now(), recover_hash = hash, recover_expires_at = expires,
         deleted_jace_sub = jace_sub, jace_sub = null, status = 'invisible', activity = null
    where uuid = acct;
  perform rename_profile(acct, parked);
end $$;

-- Recover: the account you're in ("alive", new) becomes the deleted one ("dead") again. Anything
-- the new account has moves into it, then it takes the new account's place (its id, so this login
-- finds it, and its inbox, so your open app keeps working). One transaction: all or nothing.
create or replace function recover_account(dead text, alive text) returns void
language plpgsql security definer set search_path = public as $$
declare
  a profiles%rowtype;
  d profiles%rowtype;
begin
  select * into a from profiles where uuid = alive;
  select * into d from profiles where uuid = dead and deleted_at is not null;
  if a.uuid is null or d.uuid is null then raise exception 'nothing to recover'; end if;
  perform merge_jace_sync(alive, dead);
  perform merge_profiles_extra(alive, dead);
  perform merge_profiles(alive, dead);                     -- deletes the new account's row
  perform rename_profile(dead, alive);
  update profiles set
    deleted_at = null, recover_hash = null, recover_expires_at = null, status = 'online',
    inbox = a.inbox, name = a.name, mc_linked = a.mc_linked, signed_up = coalesce(signed_up, a.signed_up),
    jace_sub = coalesce(jace_sub, case when d.deleted_jace_sub is not null
      and not exists (select 1 from profiles o where o.jace_sub = d.deleted_jace_sub) then d.deleted_jace_sub end),
    jace_name = case when a.jace_sub is not null then a.jace_name else jace_name end,
    deleted_jace_sub = null
    where uuid = alive;
end $$;

revoke all on function rename_profile(text, text) from public, anon, authenticated;
revoke all on function park_account(text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function recover_account(text, text) from public, anon, authenticated;
grant execute on function rename_profile(text, text) to service_role;
grant execute on function park_account(text, text, text, timestamptz) to service_role;
grant execute on function recover_account(text, text) to service_role;

-- A Doc for the Jace bot (and its AI) about it
insert into jace_bot_docs (slug, title, position, body) values
('delete-account', 'Deleting your account', 11, $doc$
**To delete your account,** tell the Jace bot "delete my account". It asks you to sign in again (with Jace or Minecraft), then asks if you're sure. When you press **Yes, delete my account**, you're signed out everywhere and your account disappears for everyone.

You get a **recovery ID** (it starts with JSR-). Keep it somewhere safe: **for 10 days** you can get everything back. Sign in again (that makes a new, empty account), and paste the recovery ID in a chat with the Jace bot. The account you're in turns back into your old one - friends, messages, servers, profile and settings.

After 10 days your account and everything in it is deleted for good, and the recovery ID stops working.
$doc$)
on conflict (slug) do nothing;

notify pgrst, 'reload schema';
