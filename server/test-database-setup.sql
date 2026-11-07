-- Jace Social: everything for a fresh TEST Supabase project (schema.sql + 002..007), in order.
-- For testing only. Never run this on the production project.

-- ===== schema.sql =====
-- Jace Social database. Run this once in Supabase -> SQL Editor.
-- Every table has row level security ON with no policies: only the server
-- (secret key) can read or write. Players go through the API.

create table if not exists profiles (
  uuid        text primary key,              -- Minecraft UUID without dashes
  name        text not null,                 -- current Minecraft username
  inbox       text not null unique,          -- private live-notification channel
  activity    jsonb,                         -- what they're doing (launcher / playing / hosting)
  last_seen   timestamptz,                   -- null = signed out
  signed_up   timestamptz,                   -- null = added as a friend but never signed in
  created_at  timestamptz not null default now()
);

create table if not exists sessions (
  token_hash  text primary key,              -- sha256 of the bearer token
  uuid        text not null references profiles(uuid) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists sessions_uuid on sessions(uuid);

create table if not exists auth_challenges (
  server_id   text primary key,
  created_at  timestamptz not null default now()
);

create table if not exists friendships (
  requester   text not null references profiles(uuid) on delete cascade,
  addressee   text not null references profiles(uuid) on delete cascade,
  status      text not null check (status in ('pending', 'accepted')),
  created_at  timestamptz not null default now(),
  primary key (requester, addressee),
  check (requester <> addressee)
);
-- one row per pair, whichever direction it was requested in
create unique index if not exists friendships_pair
  on friendships (least(requester, addressee), greatest(requester, addressee));
create index if not exists friendships_addressee on friendships(addressee);

create table if not exists messages (
  id          bigint generated always as identity primary key,
  sender      text not null references profiles(uuid) on delete cascade,
  recipient   text not null references profiles(uuid) on delete cascade,
  body        text not null check (char_length(body) between 1 and 500),
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create index if not exists messages_pair on messages (least(sender, recipient), greatest(sender, recipient), id);
create index if not exists messages_unread on messages (recipient) where read_at is null;

alter table profiles        enable row level security;
alter table sessions        enable row level security;
alter table auth_challenges enable row level security;
alter table friendships     enable row level security;
alter table messages        enable row level security;

-- Access: only the server's secret key (service_role) may use these tables.
-- Works with "Automatically expose new tables" turned OFF (recommended), and
-- makes sure the public keys (anon / authenticated) can't touch anything.
grant usage on schema public to service_role;
grant select, insert, update, delete on profiles, sessions, auth_challenges, friendships, messages to service_role;
grant usage, select on all sequences in schema public to service_role;
revoke all on profiles, sessions, auth_challenges, friendships, messages from anon, authenticated;

-- Voice calls: see 002_calls.sql (also run that one).

-- ===== 002_calls.sql =====
-- Jace Social: voice calls. Run once in Supabase -> SQL Editor (after schema.sql).
-- Call setup messages (WebRTC offers/answers) between friends. The audio itself
-- goes directly between players (or through Cloudflare's TURN relay), never here.
create table if not exists call_signals (
  id          bigint generated always as identity primary key,
  call_id     text not null check (char_length(call_id) between 8 and 64),
  sender      text not null references profiles(uuid) on delete cascade,
  recipient   text not null references profiles(uuid) on delete cascade,
  kind        text not null check (kind in ('offer', 'answer', 'hangup')),
  sdp         text check (char_length(sdp) <= 20000),
  created_at  timestamptz not null default now()
);
create index if not exists call_signals_recipient on call_signals (recipient, id);

alter table call_signals enable row level security;
grant select, insert, delete on call_signals to service_role;
grant usage, select on all sequences in schema public to service_role;
revoke all on call_signals from anon, authenticated;

-- ===== 003_social.sql =====
-- Jace Social: Jace accounts, profiles, status, group chats and servers.
-- Run once in Supabase -> SQL Editor (after schema.sql and 002_calls.sql). Safe to re-run.

-- ---------------------------------------------------------------------------
-- Accounts: a player can sign in with Minecraft, Jace, or both (linked).
-- profiles.uuid stays the player's id everywhere. Minecraft players keep their
-- Minecraft UUID; Jace-only players get a random 32-hex id, and when they link
-- Minecraft later their account is merged into the Minecraft one.
-- ---------------------------------------------------------------------------
alter table profiles add column if not exists jace_sub       text unique;      -- Jace account id
alter table profiles add column if not exists jace_name      text;             -- Jace username
alter table profiles add column if not exists mc_linked      boolean not null default true;  -- false = Jace-only
-- profile
alter table profiles add column if not exists display_name   text check (char_length(display_name) <= 32);
alter table profiles add column if not exists avatar_url     text check (char_length(avatar_url) <= 500);
alter table profiles add column if not exists bio            text check (char_length(bio) <= 300);
alter table profiles add column if not exists pronouns       text check (char_length(pronouns) <= 24);
alter table profiles add column if not exists accent_color   text check (accent_color ~ '^#[0-9a-fA-F]{6}$');
alter table profiles add column if not exists links          jsonb not null default '[]'::jsonb;  -- [{label, url}]
-- status (like Discord): online / idle / dnd / invisible, plus a custom status line
alter table profiles add column if not exists status         text not null default 'online'
  check (status in ('online', 'idle', 'dnd', 'invisible'));
alter table profiles add column if not exists custom_status  text check (char_length(custom_status) <= 80);
alter table profiles add column if not exists status_emoji   text check (char_length(status_emoji) <= 16);
create index if not exists profiles_jace_name on profiles (lower(jace_name));
create index if not exists profiles_name on profiles (lower(name));

-- Sign in with Jace / link Jace: one row per browser round trip.
create table if not exists oauth_requests (
  state       text primary key,                -- random, sent to Jace and back
  purpose     text not null check (purpose in ('signin', 'link')),
  link_uuid   text references profiles(uuid) on delete cascade,  -- for 'link': who is linking
  poll_hash   text,                            -- desktop apps poll for the result with this key
  return_to   text,                            -- web: where to go afterwards
  result      jsonb,                           -- {token, ...} or {error}
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Group chats and servers share "channels" and "channel_messages".
-- A group chat is a channel with server_id null and its own member list;
-- a server channel belongs to a server, and every server member can see it.
-- ---------------------------------------------------------------------------
create table if not exists servers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 48),
  icon_url    text check (char_length(icon_url) <= 500),
  description text check (char_length(description) <= 300),
  owner       text not null references profiles(uuid) on delete cascade,
  invite_code text not null unique,
  created_at  timestamptz not null default now()
);

create table if not exists server_members (
  server_id   uuid not null references servers(id) on delete cascade,
  uuid        text not null references profiles(uuid) on delete cascade,
  role        text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at   timestamptz not null default now(),
  primary key (server_id, uuid)
);
create index if not exists server_members_uuid on server_members(uuid);

create table if not exists channels (
  id          uuid primary key default gen_random_uuid(),
  server_id   uuid references servers(id) on delete cascade,   -- null = group chat
  name        text not null check (char_length(name) between 1 and 48),
  topic       text check (char_length(topic) <= 200),
  icon_url    text check (char_length(icon_url) <= 500),       -- group chats
  owner       text references profiles(uuid) on delete set null,
  position    int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists channels_server on channels(server_id, position);

create table if not exists channel_members (           -- group chats only
  channel_id  uuid not null references channels(id) on delete cascade,
  uuid        text not null references profiles(uuid) on delete cascade,
  joined_at   timestamptz not null default now(),
  primary key (channel_id, uuid)
);
create index if not exists channel_members_uuid on channel_members(uuid);

create table if not exists channel_messages (
  id          bigint generated always as identity primary key,
  channel_id  uuid not null references channels(id) on delete cascade,
  sender      text references profiles(uuid) on delete set null,
  body        text not null check (char_length(body) between 1 and 2000),
  kind        text not null default 'text' check (kind in ('text', 'system')),
  created_at  timestamptz not null default now(),
  edited_at   timestamptz
);
create index if not exists channel_messages_channel on channel_messages(channel_id, id);

create table if not exists channel_reads (              -- unread counts
  channel_id  uuid not null references channels(id) on delete cascade,
  uuid        text not null references profiles(uuid) on delete cascade,
  last_read   bigint not null default 0,
  primary key (channel_id, uuid)
);

alter table oauth_requests   enable row level security;
alter table servers          enable row level security;
alter table server_members   enable row level security;
alter table channels         enable row level security;
alter table channel_members  enable row level security;
alter table channel_messages enable row level security;
alter table channel_reads    enable row level security;
grant select, insert, update, delete on oauth_requests, servers, server_members, channels, channel_members,
  channel_messages, channel_reads to service_role;
grant usage, select on all sequences in schema public to service_role;
revoke all on oauth_requests, servers, server_members, channels, channel_members, channel_messages, channel_reads
  from anon, authenticated;

-- Profile pictures and server/group icons (public files, uploaded through the server).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do nothing;

-- Merge one player into another (linking a Jace-only account to a Minecraft one,
-- or the other way round). Everything of "src" moves to "dst", then "src" is deleted.
-- One function = one transaction, so a failed merge changes nothing.
create or replace function merge_profiles(src text, dst text) returns void
language plpgsql security definer set search_path = public as $$
declare
  s profiles%rowtype;
begin
  if src = dst then return; end if;
  select * into s from profiles where uuid = src;
  if not found then return; end if;
  update profiles set jace_sub = null where uuid = src;   -- free the unique value for dst
  -- friendships: drop the pair between them, and duplicates dst already has
  delete from friendships where (requester = src and addressee = dst) or (requester = dst and addressee = src);
  delete from friendships f where f.requester = src and exists (
    select 1 from friendships g where (g.requester = dst and g.addressee = f.addressee) or (g.addressee = dst and g.requester = f.addressee));
  delete from friendships f where f.addressee = src and exists (
    select 1 from friendships g where (g.requester = dst and g.addressee = f.requester) or (g.addressee = dst and g.requester = f.requester));
  update friendships set requester = dst where requester = src;
  update friendships set addressee = dst where addressee = src;
  -- direct messages and calls
  update messages set sender = dst where sender = src;
  update messages set recipient = dst where recipient = src;
  delete from call_signals where sender = src or recipient = src;
  -- servers, group chats, channel messages
  insert into server_members (server_id, uuid, role, joined_at)
    select server_id, dst, role, joined_at from server_members where uuid = src on conflict do nothing;
  delete from server_members where uuid = src;
  insert into channel_members (channel_id, uuid, joined_at)
    select channel_id, dst, joined_at from channel_members where uuid = src on conflict do nothing;
  delete from channel_members where uuid = src;
  insert into channel_reads (channel_id, uuid, last_read)
    select channel_id, dst, last_read from channel_reads where uuid = src on conflict do nothing;
  delete from channel_reads where uuid = src;
  update servers set owner = dst where owner = src;
  update channels set owner = dst where owner = src;
  update channel_messages set sender = dst where sender = src;
  update sessions set uuid = dst where uuid = src;
  -- keep dst's profile, filling gaps from src
  update profiles d set
    jace_sub      = coalesce(d.jace_sub, s.jace_sub),
    jace_name     = coalesce(d.jace_name, s.jace_name),
    display_name  = coalesce(d.display_name, s.display_name),
    avatar_url    = coalesce(d.avatar_url, s.avatar_url),
    bio           = coalesce(d.bio, s.bio),
    pronouns      = coalesce(d.pronouns, s.pronouns),
    accent_color  = coalesce(d.accent_color, s.accent_color),
    links         = case when d.links = '[]'::jsonb then s.links else d.links end,
    custom_status = coalesce(d.custom_status, s.custom_status),
    signed_up     = coalesce(d.signed_up, s.signed_up)
  where d.uuid = dst;
  delete from profiles where uuid = src;
end $$;
revoke all on function merge_profiles(text, text) from public, anon, authenticated;
grant execute on function merge_profiles(text, text) to service_role;

notify pgrst, 'reload schema';

-- ===== 004_community.sql =====
-- Jace Social: roles and permissions, replies, reactions, mentions, files, link embeds,
-- moderation, custom invite links, onboarding, voice channels, screen sharing and bots.
-- Run once in Supabase -> SQL Editor (after 003_social.sql). Safe to re-run.

-- ---------------------------------------------------------------------------
-- Permissions are bits (like Discord's), stored as bigint:
--   1 view channels        2 send messages      4 attach files       8 add reactions
--   16 mention @everyone   32 manage messages   64 manage channels   128 manage roles
--   256 manage server      512 kick members     1024 ban members     2048 create invites
--   4096 change nickname   8192 manage nicknames 16384 connect (voice) 32768 speak
--   65536 share screen     131072 time out members 262144 manage bots  1073741824 administrator
-- The server owner and the administrator bit can do everything.
-- ---------------------------------------------------------------------------
create table if not exists server_roles (
  id          uuid primary key default gen_random_uuid(),
  server_id   uuid not null references servers(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 32),
  color       text check (color ~ '^#[0-9a-fA-F]{6}$'),
  icon        text check (char_length(icon) <= 16),              -- an emoji
  position    int not null default 0,                            -- higher = more important
  permissions bigint not null default 0,
  hoist       boolean not null default false,                    -- listed separately in the member list
  mentionable boolean not null default false,
  is_default  boolean not null default false,                    -- @everyone (one per server)
  created_at  timestamptz not null default now()
);
create index if not exists server_roles_server on server_roles(server_id, position);
create unique index if not exists server_roles_default on server_roles(server_id) where is_default;

create table if not exists server_member_roles (
  server_id   uuid not null references servers(id) on delete cascade,
  uuid        text not null references profiles(uuid) on delete cascade,
  role_id     uuid not null references server_roles(id) on delete cascade,
  primary key (server_id, uuid, role_id)
);
create index if not exists server_member_roles_role on server_member_roles(role_id);

alter table server_members add column if not exists nickname      text check (char_length(nickname) <= 32);
alter table server_members add column if not exists timeout_until timestamptz;            -- can't talk until then
alter table server_members add column if not exists onboarded     boolean not null default false;

create table if not exists server_bans (
  server_id   uuid not null references servers(id) on delete cascade,
  uuid        text not null references profiles(uuid) on delete cascade,
  reason      text check (char_length(reason) <= 200),
  banned_by   text references profiles(uuid) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (server_id, uuid)
);

-- Channels: text, voice, announcement and categories (which hold other channels).
alter table channels add column if not exists kind       text not null default 'text'
  check (kind in ('text', 'voice', 'announcement', 'category'));
alter table channels add column if not exists parent_id  uuid references channels(id) on delete set null;
alter table channels add column if not exists slowmode   int not null default 0 check (slowmode between 0 and 21600);  -- seconds
alter table channels add column if not exists user_limit int not null default 0 check (user_limit between 0 and 25); -- voice

-- Per-channel permission overrides for a role or one member (deny is applied before allow).
create table if not exists channel_overrides (
  channel_id  uuid not null references channels(id) on delete cascade,
  target_type text not null check (target_type in ('role', 'member')),
  target_id   text not null,                                     -- role id or player uuid
  allow       bigint not null default 0,
  deny        bigint not null default 0,
  primary key (channel_id, target_type, target_id)
);

-- Servers: a custom invite link (jace-social.vercel.app/<vanity>), look, welcome and onboarding.
alter table servers add column if not exists vanity          text unique check (vanity ~ '^[a-z0-9-]{3,32}$');
alter table servers add column if not exists banner_url      text check (char_length(banner_url) <= 500);
alter table servers add column if not exists accent_color    text check (accent_color ~ '^#[0-9a-fA-F]{6}$');
alter table servers add column if not exists rules           text check (char_length(rules) <= 2000);
alter table servers add column if not exists welcome         jsonb not null default '{}'::jsonb;  -- {message, channels: [id]}
alter table servers add column if not exists onboarding      jsonb not null default '[]'::jsonb;  -- [{question, options: [{label, emoji, role_ids}]}]
alter table servers add column if not exists system_channel  uuid references channels(id) on delete set null;  -- "X joined" messages
alter table servers add column if not exists invites_paused  boolean not null default false;

-- ---------------------------------------------------------------------------
-- Messages: replies, files, link previews, mentions, pins. Group/server messages
-- (channel_messages) and direct messages (messages) both get replies, files,
-- previews and reactions; mentions and pins are for group chats and servers.
-- ---------------------------------------------------------------------------
alter table channel_messages add column if not exists reply_to        bigint references channel_messages(id) on delete set null;
alter table channel_messages add column if not exists attachments     jsonb not null default '[]'::jsonb;  -- [{url, name, type, size, width?, height?}]
alter table channel_messages add column if not exists embeds          jsonb not null default '[]'::jsonb;  -- [{url, title, description, image, site}]
alter table channel_messages add column if not exists mentions        text[] not null default '{}';         -- player ids
alter table channel_messages add column if not exists mention_roles   uuid[] not null default '{}';
alter table channel_messages add column if not exists mention_everyone boolean not null default false;
alter table channel_messages add column if not exists pinned_at       timestamptz;
alter table channel_messages add column if not exists pinned_by       text references profiles(uuid) on delete set null;
alter table channel_messages add column if not exists components      jsonb not null default '[]'::jsonb;  -- bot buttons
alter table channel_messages drop constraint if exists channel_messages_body_check;
alter table channel_messages add constraint channel_messages_body_check check (char_length(body) <= 4000);  -- files can come without text
create index if not exists channel_messages_pinned on channel_messages(channel_id) where pinned_at is not null;

alter table messages add column if not exists reply_to    bigint references messages(id) on delete set null;
alter table messages add column if not exists attachments jsonb not null default '[]'::jsonb;
alter table messages add column if not exists embeds      jsonb not null default '[]'::jsonb;
alter table messages add column if not exists edited_at   timestamptz;
alter table messages drop constraint if exists messages_body_check;
alter table messages add constraint messages_body_check check (char_length(body) <= 2000);

-- Reactions on both kinds of messages: scope 'c' = channel_messages, 'd' = direct messages.
create table if not exists message_reactions (
  scope       text not null check (scope in ('c', 'd')),
  message_id  bigint not null,
  uuid        text not null references profiles(uuid) on delete cascade,
  emoji       text not null check (char_length(emoji) between 1 and 32),
  created_at  timestamptz not null default now(),
  primary key (scope, message_id, uuid, emoji)
);
create index if not exists message_reactions_message on message_reactions(scope, message_id);

-- ---------------------------------------------------------------------------
-- Voice channels: who's in which room, and the connection setup between them
-- (offers/answers; audio and screens go directly between players, a small mesh).
-- ---------------------------------------------------------------------------
create table if not exists voice_states (
  channel_id  uuid not null references channels(id) on delete cascade,
  uuid        text not null references profiles(uuid) on delete cascade,
  muted       boolean not null default false,
  deafened    boolean not null default false,
  streaming   boolean not null default false,                   -- sharing their screen
  joined_at   timestamptz not null default now(),
  last_seen   timestamptz not null default now(),               -- heartbeat; stale rows are dropped
  primary key (channel_id, uuid)
);
create unique index if not exists voice_states_one_room on voice_states(uuid);

create table if not exists voice_signals (
  id          bigint generated always as identity primary key,
  channel_id  uuid not null references channels(id) on delete cascade,
  sender      text not null references profiles(uuid) on delete cascade,
  recipient   text not null references profiles(uuid) on delete cascade,
  kind        text not null check (kind in ('offer', 'answer')),
  sdp         text not null check (char_length(sdp) <= 30000),
  created_at  timestamptz not null default now()
);
create index if not exists voice_signals_recipient on voice_signals(recipient, id);

-- Direct calls can now carry a screen share too (renegotiated with a new offer/answer).
alter table call_signals drop constraint if exists call_signals_sdp_check;
alter table call_signals add constraint call_signals_sdp_check check (char_length(sdp) <= 30000);
alter table call_signals drop constraint if exists call_signals_kind_check;
alter table call_signals add constraint call_signals_kind_check check (kind in ('offer', 'answer', 'hangup', 'renegotiate', 'reanswer'));

-- ---------------------------------------------------------------------------
-- Bots are accounts too (profiles.is_bot) with an owner. They act through the same API
-- with a bot token, their owner can switch to them in the app, and a bot can be made
-- with blocks (program) that this server runs when something happens.
-- ---------------------------------------------------------------------------
alter table profiles add column if not exists is_bot          boolean not null default false;
alter table profiles add column if not exists bot_owner       text references profiles(uuid) on delete cascade;
alter table profiles add column if not exists bot_public      boolean not null default false;   -- anyone can add it to their server
alter table profiles add column if not exists bot_commands    jsonb not null default '[]'::jsonb;  -- [{name, description, options}]
alter table profiles add column if not exists bot_program     jsonb;                              -- block program (see lib/blocks.ts)
alter table profiles add column if not exists bot_enabled     boolean not null default true;
alter table profiles add column if not exists banner_url      text check (char_length(banner_url) <= 500);
alter table profiles add column if not exists settings        jsonb not null default '{}'::jsonb; -- private: theme, trusted links...
alter table profiles add column if not exists onboarded_at    timestamptz;
create index if not exists profiles_bot_owner on profiles(bot_owner) where is_bot;

alter table sessions add column if not exists kind text not null default 'user' check (kind in ('user', 'bot'));

-- Block bots' own variables (per bot and server), e.g. counters.
create table if not exists bot_storage (
  bot         text not null references profiles(uuid) on delete cascade,
  scope       text not null,                                    -- server id, or 'global'
  key         text not null check (char_length(key) <= 64),
  value       jsonb,
  primary key (bot, scope, key)
);

alter table server_roles        enable row level security;
alter table server_member_roles enable row level security;
alter table server_bans         enable row level security;
alter table channel_overrides   enable row level security;
alter table message_reactions   enable row level security;
alter table voice_states        enable row level security;
alter table voice_signals       enable row level security;
alter table bot_storage         enable row level security;
grant select, insert, update, delete on server_roles, server_member_roles, server_bans, channel_overrides,
  message_reactions, voice_states, voice_signals, bot_storage to service_role;
grant usage, select on all sequences in schema public to service_role;
revoke all on server_roles, server_member_roles, server_bans, channel_overrides, message_reactions,
  voice_states, voice_signals, bot_storage from anon, authenticated;

-- Files in messages (public links, uploaded through the server).
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', true, 10485760)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Existing servers: an @everyone role with the normal member permissions, and an
-- Admin role (administrator) for everyone who was an admin.
-- ---------------------------------------------------------------------------
insert into server_roles (server_id, name, position, permissions, is_default)
select s.id, '@everyone', 0, 1 | 2 | 4 | 8 | 2048 | 4096 | 16384 | 32768 | 65536, true
from servers s
where not exists (select 1 from server_roles r where r.server_id = s.id and r.is_default);

insert into server_roles (server_id, name, color, position, permissions, hoist)
select s.id, 'Admin', '#3ddc84', 1, 1073741824, true
from servers s
where exists (select 1 from server_members m where m.server_id = s.id and m.role = 'admin')
  and not exists (select 1 from server_roles r where r.server_id = s.id and r.name = 'Admin');

insert into server_member_roles (server_id, uuid, role_id)
select m.server_id, m.uuid, r.id
from server_members m join server_roles r on r.server_id = m.server_id and r.name = 'Admin' and not r.is_default
where m.role = 'admin'
on conflict do nothing;

update servers s set system_channel = (select c.id from channels c where c.server_id = s.id order by c.position, c.created_at limit 1)
where system_channel is null;

-- Merging accounts (merge_profiles in 003) now also moves roles, reactions, voice and bots.
create or replace function merge_profiles_extra(src text, dst text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into server_member_roles (server_id, uuid, role_id)
    select server_id, dst, role_id from server_member_roles where uuid = src on conflict do nothing;
  delete from server_member_roles where uuid = src;
  insert into message_reactions (scope, message_id, uuid, emoji, created_at)
    select scope, message_id, dst, emoji, created_at from message_reactions where uuid = src on conflict do nothing;
  delete from message_reactions where uuid = src;
  delete from voice_states where uuid = src;
  delete from voice_signals where sender = src or recipient = src;
  update server_bans set banned_by = dst where banned_by = src;
  update channel_messages set pinned_by = dst where pinned_by = src;
  update profiles set bot_owner = dst where bot_owner = src;
  update profiles d set settings = s.settings || d.settings, onboarded_at = coalesce(d.onboarded_at, s.onboarded_at)
    from profiles s where d.uuid = dst and s.uuid = src;
end $$;
revoke all on function merge_profiles_extra(text, text) from public, anon, authenticated;
grant execute on function merge_profiles_extra(text, text) to service_role;

notify pgrst, 'reload schema';

-- ===== 005_code_bots.sql =====
-- Jace Social: bots written in code and run on Jace Social's servers, and every bot's activity log.
-- Run once in Supabase -> SQL Editor (after 004_community.sql). Safe to re-run.

-- A bot's JavaScript (see lib/codebots.ts): runs in a sandbox when something happens.
alter table profiles add column if not exists bot_code text check (char_length(bot_code) <= 60000);

-- Everything a bot does (and what it was reacting to), so its owner and the admins of the
-- servers it's in can see it. Kept for 14 days.
create table if not exists bot_logs (
  id          bigserial primary key,
  bot         text not null references profiles(uuid) on delete cascade,
  at          timestamptz not null default now(),
  server_id   uuid references servers(id) on delete cascade,
  channel_id  uuid,
  kind        text not null check (kind in ('event', 'message', 'react', 'role', 'delete', 'storage', 'log', 'error', 'command')),
  detail      text not null check (char_length(detail) <= 1000)
);
create index if not exists bot_logs_bot on bot_logs(bot, id desc);
create index if not exists bot_logs_server on bot_logs(server_id, bot, id desc);

alter table bot_logs enable row level security;
grant select, insert, update, delete on bot_logs to service_role;
grant usage, select on all sequences in schema public to service_role;
revoke all on bot_logs from anon, authenticated;

-- ===== 006_handles.sql =====
-- Jace Social: handles - each account's unique @name, which people choose (and change) themselves.
-- Run once in Supabase -> SQL Editor (after 005_code_bots.sql). Safe to re-run.
--
-- 3-20 characters: lowercase letters, numbers, _ and . (not at the start or end). Unique,
-- ignoring case. Everyone gets one: existing accounts now, new ones when they're created -
-- their Minecraft name, else their Jace name, else their display name, made to fit, with a
-- number added when it's taken. Changing it (PATCH /me {handle}) is allowed once every 7 days.

alter table profiles add column if not exists handle text
  check (handle ~ '^[a-z0-9_]([a-z0-9_.]{1,18}[a-z0-9_])$');
alter table profiles add column if not exists handle_changed_at timestamptz;
create unique index if not exists profiles_handle on profiles (lower(handle));

-- A free handle based on some name ("Steve" -> "steve", taken -> "steve2", ...).
create or replace function jace_free_handle(base text, me text default null) returns text
language plpgsql as $$
declare
  b text := left(regexp_replace(regexp_replace(lower(coalesce(base, '')), '[^a-z0-9_.]', '', 'g'), '^\.+|\.+$', '', 'g'), 17);
  h text;
  n int := 1;
begin
  if b = '' then b := 'player'; elsif char_length(b) < 3 then b := rpad(b, 3, '0'); end if;
  b := regexp_replace(b, '\.+$', '');
  h := b;
  while exists (select 1 from profiles where lower(handle) = h and uuid is distinct from me)
        or h in ('everyone', 'here', 'jace', 'jacesocial', 'admin', 'administrator', 'moderator', 'mod', 'support', 'system', 'staff', 'official', 'help', 'null', 'undefined') loop
    n := n + 1;
    h := left(b, 20 - char_length(n::text)) || n;
  end loop;
  return h;
end $$;

-- New accounts get a handle when they're created.
create or replace function jace_handle_on_insert() returns trigger
language plpgsql as $$
begin
  if new.handle is null then
    new.handle := jace_free_handle(
      case when coalesce(new.mc_linked, true) and not coalesce(new.is_bot, false) then new.name   -- a Minecraft player
           else coalesce(nullif(new.jace_name, ''), nullif(new.display_name, ''), new.name) end,
      new.uuid);
  end if;
  return new;
end $$;
drop trigger if exists profiles_handle_insert on profiles;
create trigger profiles_handle_insert before insert on profiles for each row execute function jace_handle_on_insert();

-- Existing accounts: Minecraft players first (their name is theirs), then Jace-only accounts, then bots.
do $$
declare r record;
begin
  for r in select uuid, name from profiles where handle is null and coalesce(mc_linked, true) and not coalesce(is_bot, false)
           order by signed_up nulls last loop
    update profiles set handle = jace_free_handle(r.name, r.uuid) where uuid = r.uuid;
  end loop;
  for r in select uuid, coalesce(nullif(jace_name, ''), display_name, name) as base from profiles where handle is null
           order by is_bot, signed_up nulls last loop
    update profiles set handle = jace_free_handle(r.base, r.uuid) where uuid = r.uuid;
  end loop;
end $$;

grant execute on function jace_free_handle(text, text) to service_role;

-- ===== 007_jace_messages.sql =====
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
