-- Jace Social: Jace ban appeals (lib/appeals.ts). Muted or banned Jace accounts can only message the
-- Jace Official organization; its owner and admins read and answer those appeals here. Jace decides
-- who that is (GET /api/oauth/appeals answers 200 only for them) - this only remembers the answer for
-- a few minutes, and what each of them has seen. Appeal messages themselves are never stored here.
-- Run once in Supabase -> SQL Editor (after 012_deleted_logins.sql). Safe to re-run.

-- Did this profile's Jace token pass Jace's appeals check, and when was it last asked?
create table if not exists jace_appeal_staff (
  uuid        text primary key references profiles(uuid) on delete cascade on update cascade,
  is_staff    boolean not null default false,
  reconnect   boolean not null default false,       -- was staff, but the Jace token stopped working (401)
  checked_at  timestamptz not null default now(),
  polled_at   timestamptz                           -- first poll done: from then on, new appeals notify
);

-- Per staff member and appealing Jace account: the newest message already notified about (or there
-- at the first poll), and when they last opened the thread (for the unread count).
create table if not exists jace_appeal_seen (
  staff            text not null references profiles(uuid) on delete cascade on update cascade,
  user_id          text not null,                   -- the appealing Jace account's id
  last_message_at  timestamptz,
  read_at          timestamptz,
  primary key (staff, user_id)
);

alter table jace_appeal_staff enable row level security;
alter table jace_appeal_seen  enable row level security;
grant select, insert, update, delete on jace_appeal_staff, jace_appeal_seen to service_role;
revoke all on jace_appeal_staff, jace_appeal_seen from anon, authenticated;

notify pgrst, 'reload schema';
