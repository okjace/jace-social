-- Jace Social: uploads spread over several storage services (lib/storage.ts) - Cloudflare R2, then
-- Backblaze B2, then Supabase - each used until it's nearly full. This keeps how much each holds,
-- and where every file went (so it can be deleted from the right place).
-- Run once in Supabase -> SQL Editor (after 016_bigger_files.sql). Safe to re-run.

create table if not exists storage_usage (
  provider  text primary key,                     -- r2 | b2 | supabase
  bytes     bigint not null default 0
);

create table if not exists storage_files (
  url         text primary key,
  provider    text not null,
  key         text not null,                      -- where it is in that service
  size        bigint not null default 0,
  owner       text references profiles(uuid) on delete set null on update cascade,
  created_at  timestamptz not null default now()
);
create index if not exists storage_files_owner on storage_files(owner);

-- add (or, negative, take away) bytes for a service, in one step
create or replace function storage_add(p text, n bigint) returns void
language sql security definer set search_path = public as $$
  insert into storage_usage (provider, bytes) values (p, greatest(n, 0))
  on conflict (provider) do update set bytes = greatest(storage_usage.bytes + n, 0);
$$;

alter table storage_usage enable row level security;
alter table storage_files enable row level security;
grant select, insert, update, delete on storage_usage, storage_files to service_role;
revoke all on storage_usage, storage_files from anon, authenticated;
revoke all on function storage_add(text, bigint) from public, anon, authenticated;
grant execute on function storage_add(text, bigint) to service_role;

notify pgrst, 'reload schema';
