-- Jace Social: custom call sounds (lib/sounds.ts, app/api/v1/sounds). People upload their own
-- ringtones and calling sounds, and can share them in the community library for anyone to use.
-- Run once in Supabase -> SQL Editor (after 014_jace_admins.sql). Safe to re-run.

-- The audio files (public: anyone using a sound plays it from here), up to 1 MB each
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sounds', 'sounds', true, 1048576,
  array['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/x-m4a'])
on conflict (id) do nothing;

create table if not exists sounds (
  id          uuid primary key default gen_random_uuid(),
  owner       text not null references profiles(uuid) on delete cascade on update cascade,
  name        text not null check (char_length(name) between 1 and 40),
  kind        text not null check (kind in ('ringtone', 'calling')),
  url         text not null,
  public      boolean not null default false,       -- in the community library
  uses        int not null default 0,               -- how many people picked it
  created_at  timestamptz not null default now()
);
create index if not exists sounds_owner on sounds(owner);
create index if not exists sounds_public on sounds(kind, uses desc) where public;

alter table sounds enable row level security;
grant select, insert, update, delete on sounds to service_role;
revoke all on sounds from anon, authenticated;

notify pgrst, 'reload schema';
