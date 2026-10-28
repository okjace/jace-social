-- Jace Social: moderation (lib/moderation.ts) - mutes, bans that end on their own, bans and mutes
-- carried over from a linked Jace account, Jace's auto moderation rules (lib/automod.ts), and
-- reports to Jace Social's staff.
-- Run once in Supabase -> SQL Editor (after 017_storage.sql). Safe to re-run.

-- bans (banned_at, ban_reason were already here) can end: ban_until (null = for good)
alter table profiles add column if not exists ban_until timestamptz;
-- who banned: 'staff' (Jace Social's staff / the Jace bot) or 'jace' (their linked Jace account is
-- banned there; lifted when Jace lifts it)
alter table profiles add column if not exists ban_from text;
-- muted: can read, can't post (messages, edits, reactions, profile text) until mute_until (null = for good)
alter table profiles add column if not exists muted_at timestamptz;
alter table profiles add column if not exists mute_reason text;
alter table profiles add column if not exists mute_until timestamptz;
alter table profiles add column if not exists mute_from text;          -- staff | jace | automod
-- when Jace was last asked about this account's ban and mute (a few minutes apart)
alter table profiles add column if not exists jace_mod_checked_at timestamptz;

-- every post Jace's auto moderation rules blocked here (for staff, and for the auto-mute count)
create table if not exists automod_log (
  id          bigserial primary key,
  uuid        text references profiles(uuid) on delete cascade on update cascade,
  area        text not null,                       -- a message, a display name, a picture, ...
  matched     text not null,
  excerpt     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists automod_log_uuid on automod_log(uuid, created_at);

-- reports: someone reports a message or a person; staff answer them in Reports
create table if not exists reports (
  id            bigserial primary key,
  reporter      text references profiles(uuid) on delete set null on update cascade,
  target        text references profiles(uuid) on delete cascade on update cascade,   -- the person reported
  scope         text,                              -- the message's kind: d (direct) | c (channel), or null
  message_id    bigint,
  channel_id    text,
  server_id     text,
  excerpt       text,                              -- the message as it was when reported
  reason        text not null,                     -- spam | harassment | hate | sexual | violence | other
  details       text,
  status        text not null default 'open',      -- open | resolved | dismissed
  resolution    text,                              -- what staff did
  resolved_by   text references profiles(uuid) on delete set null on update cascade,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
create index if not exists reports_open on reports(status, created_at desc);
create index if not exists reports_target on reports(target);

alter table automod_log enable row level security;
alter table reports enable row level security;
grant select, insert, update, delete on automod_log, reports to service_role;
grant usage, select on sequence automod_log_id_seq, reports_id_seq to service_role;

notify pgrst, 'reload schema';
