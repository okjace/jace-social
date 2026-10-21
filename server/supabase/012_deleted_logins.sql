-- Jace Social: remember, for good, when a Jace login's account was deleted - also after the 10 days,
-- and for accounts deleted right away ("([DELETE-NOW])", lib/accountDeletion.ts). The Jace message
-- sync uses it so nothing from before comes back to a new account with that login (lib/jaceSync.ts).
-- Only the Jace account id and the time are kept. Run once in Supabase -> SQL Editor (after 011). Safe to re-run.

create table if not exists jace_deleted_logins (
  jace_sub    text primary key,
  deleted_at  timestamptz not null default now()
);
alter table jace_deleted_logins enable row level security;
grant select, insert, update, delete on jace_deleted_logins to service_role;
revoke all on jace_deleted_logins from anon, authenticated;

-- accounts deleted before this file
insert into jace_deleted_logins (jace_sub, deleted_at)
  select deleted_jace_sub, max(deleted_at) from profiles
   where deleted_at is not null and deleted_jace_sub is not null group by deleted_jace_sub
on conflict (jace_sub) do update set deleted_at = greatest(jace_deleted_logins.deleted_at, excluded.deleted_at);

create or replace function park_account(acct text, parked text, hash text, expires timestamptz) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into jace_deleted_logins (jace_sub, deleted_at)
    select jace_sub, now() from profiles where uuid = acct and jace_sub is not null
  on conflict (jace_sub) do update set deleted_at = excluded.deleted_at;
  delete from sessions where uuid = acct;
  delete from voice_states where uuid = acct;
  delete from jace_connections where uuid = acct;          -- the encrypted Jace token
  update profiles set deleted_at = now(), recover_hash = hash, recover_expires_at = expires,
         deleted_jace_sub = jace_sub, jace_sub = null, status = 'invisible', activity = null,
         deleted_handle = handle, handle = null             -- free for a new account
    where uuid = acct;
  perform rename_profile(acct, parked);
end $$;

create or replace function recover_account(dead text, alive text) returns void
language plpgsql security definer set search_path = public as $$
declare
  a profiles%rowtype;
  d profiles%rowtype;
begin
  select * into a from profiles where uuid = alive;
  select * into d from profiles where uuid = dead and deleted_at is not null;
  if a.uuid is null or d.uuid is null then raise exception 'nothing to recover'; end if;
  delete from jace_deleted_logins where jace_sub = d.deleted_jace_sub;   -- that login's account isn't deleted any more
  perform merge_jace_sync(alive, dead);
  perform merge_profiles_extra(alive, dead);
  perform merge_profiles(alive, dead);                     -- deletes the new account's row (and frees its handle)
  perform rename_profile(dead, alive);
  update profiles set
    deleted_at = null, recover_hash = null, recover_expires_at = null, status = 'online',
    inbox = a.inbox, name = a.name, mc_linked = a.mc_linked, signed_up = coalesce(signed_up, a.signed_up),
    jace_sub = coalesce(jace_sub, case when d.deleted_jace_sub is not null
      and not exists (select 1 from profiles o where o.jace_sub = d.deleted_jace_sub) then d.deleted_jace_sub end),
    jace_name = case when a.jace_sub is not null then a.jace_name else jace_name end,
    deleted_jace_sub = null,
    handle = case when d.deleted_handle is not null
      and not exists (select 1 from profiles o where lower(o.handle) = lower(d.deleted_handle)) then d.deleted_handle
      else coalesce(handle, a.handle) end,
    deleted_handle = null
    where uuid = alive;
end $$;

revoke all on function park_account(text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function recover_account(text, text) from public, anon, authenticated;
grant execute on function park_account(text, text, text, timestamptz) to service_role;
grant execute on function recover_account(text, text) to service_role;

-- the Jace bot's Doc about deleting: how to skip the 10 days
update jace_bot_docs set body = body || $doc$
**Delete it right away instead:** end your message with **([DELETE-NOW])**, like "delete my account ([DELETE-NOW])". After signing in again and confirming, your account and everything in it is deleted at once and for good - there's no recovery ID.
$doc$, updated_at = now()
 where slug = 'delete-account' and body not like '%DELETE-NOW%';

notify pgrst, 'reload schema';
