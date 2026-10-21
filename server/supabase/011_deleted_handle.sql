-- Jace Social: deleting your account frees your @handle at once (a new account with the same login
-- gets it, not "name2"); recovering gives it back if nobody has taken it meanwhile.
-- Run once in Supabase -> SQL Editor (after 010_account_deletion.sql). Safe to re-run.

alter table profiles add column if not exists deleted_handle text;

create or replace function park_account(acct text, parked text, hash text, expires timestamptz) returns void
language plpgsql security definer set search_path = public as $$
begin
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
    -- your old handle back if it's free, else the new account's
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

notify pgrst, 'reload schema';
