-- Jace Social: Jace's own admins are admins here too (lib/jaceAdmin.ts) - Jace says who in its userinfo
-- (is_admin), asked with the person's stored Jace token and remembered for a few minutes.
-- Run once in Supabase -> SQL Editor (after 013_jace_appeals.sql). Safe to re-run.

create table if not exists jace_admins (
  uuid        text primary key references profiles(uuid) on delete cascade on update cascade,
  is_admin    boolean not null default false,
  checked_at  timestamptz not null default now()
);
alter table jace_admins enable row level security;
grant select, insert, update, delete on jace_admins to service_role;
revoke all on jace_admins from anon, authenticated;

notify pgrst, 'reload schema';
