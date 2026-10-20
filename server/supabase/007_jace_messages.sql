-- Jace Social: direct messages and group chats sync both ways with people's Jace messages
-- (jaceo.vercel.app's messages API, see lib/jaceSync.ts). Run once in Supabase -> SQL Editor
-- (after 006_handles.sql). Safe to re-run.

-- Each person's Jace access token (from "Sign in with Jace" with the messages scope). The token
-- itself is encrypted with JACE_TOKEN_KEY (AES-256-GCM) before it gets here, and is never sent
-- to clients. Kept out of profiles so no "select *" on profiles can ever reach it.
create table if not exists jace_connections (
  uuid          text primary key references profiles(uuid) on delete cascade,
  token_enc     text,                                   -- null after "Disconnect Jace messages"
  granted_at    timestamptz,
  status        text not null default 'ok' check (status in ('ok', 'disconnected', 'banned')),
  sync_enabled  boolean not null default true,          -- the "Sync messages with Jace" switch
  imported_at   timestamptz,                            -- the one-time history import finished
  last_sync_at  timestamptz,
  last_error    text check (char_length(last_error) <= 500),
  syncing_until timestamptz,                            -- a lock, so two pulls don't overlap
  created_at    timestamptz not null default now()
);

-- Which local message a Jace message is. One Jace message can become several Jace Social
-- direct messages (they're 2000 characters at most, Jace's 4000): part 0, 1, ...
-- Messages we push to Jace are linked under the id Jace gives them ("app-" + hash), so they're
-- never imported back; messages that came from Jace are never pushed back.
create table if not exists jace_message_links (
  jace_id     text not null check (char_length(jace_id) <= 200),
  part        int not null default 0,
  kind        text not null check (kind in ('dm', 'ch')),
  local_id    bigint,                                   -- null while it's being imported
  origin      text not null default 'jace' check (origin in ('jace', 'local')),
  created_at  timestamptz not null default now(),
  primary key (jace_id, part)
);
create unique index if not exists jace_message_links_local on jace_message_links (kind, local_id);

-- A Jace group chat and the Jace Social group chat it became.
create table if not exists jace_group_links (
  jace_group_id text primary key check (char_length(jace_group_id) <= 200),
  channel_id    uuid not null unique references channels(id) on delete cascade,
  created_at    timestamptz not null default now()
);

-- How far each person's conversations are synced: the newest Jace created_at seen.
-- conversation: 'dm:<jace user id>' or 'g:<jace group id>'.
create table if not exists jace_sync_cursors (
  uuid          text not null references profiles(uuid) on delete cascade,
  conversation  text not null check (char_length(conversation) <= 220),
  last_at       timestamptz not null,
  primary key (uuid, conversation)
);

-- Messages waiting to go to Jace, retried with backoff. status: pending -> sent, or
-- muted (the Jace account is muted: kept here, not retried) or failed (gave up).
create table if not exists jace_outbox (
  id           bigint generated always as identity primary key,
  sender       text not null references profiles(uuid) on delete cascade,
  kind         text not null check (kind in ('dm', 'ch')),
  local_id     bigint not null,
  target       text not null check (char_length(target) <= 200),   -- Jace user id (dm) or group id (ch)
  external_id  text not null unique check (char_length(external_id) <= 200),
  body         text not null check (char_length(body) between 1 and 4000),
  created_at   timestamptz not null,                   -- the message's own time
  status       text not null default 'pending' check (status in ('pending', 'sent', 'muted', 'failed')),
  attempts     int not null default 0,
  next_at      timestamptz not null default now(),
  last_error   text check (char_length(last_error) <= 500),
  queued_at    timestamptz not null default now()
);
create index if not exists jace_outbox_due on jace_outbox (next_at) where status = 'pending';

-- Messages are listed by time, then id (imported history keeps its original times).
create index if not exists messages_pair_time on messages (least(sender, recipient), greatest(sender, recipient), created_at, id);
create index if not exists channel_messages_time on channel_messages (channel_id, created_at, id);

alter table jace_connections   enable row level security;
alter table jace_message_links enable row level security;
alter table jace_group_links   enable row level security;
alter table jace_sync_cursors  enable row level security;
alter table jace_outbox        enable row level security;
grant select, insert, update, delete on jace_connections, jace_message_links, jace_group_links, jace_sync_cursors, jace_outbox
  to service_role;
grant usage, select on all sequences in schema public to service_role;
revoke all on jace_connections, jace_message_links, jace_group_links, jace_sync_cursors, jace_outbox from anon, authenticated;

-- Merging accounts (linking Jace to Minecraft) keeps the connection and cursors of the one
-- that stays, and takes the other's if it has none.
create or replace function merge_jace_sync(src text, dst text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if src = dst then return; end if;
  if not exists (select 1 from jace_connections where uuid = dst) then
    update jace_connections set uuid = dst where uuid = src;
  end if;
  insert into jace_sync_cursors (uuid, conversation, last_at)
    select dst, conversation, last_at from jace_sync_cursors where uuid = src on conflict do nothing;
  update jace_outbox set sender = dst where sender = src;
end $$;
revoke all on function merge_jace_sync(text, text) from public, anon, authenticated;
grant execute on function merge_jace_sync(text, text) to service_role;

notify pgrst, 'reload schema';
