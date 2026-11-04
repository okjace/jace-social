-- Jace Social: more kinds of server channels, and reports on more kinds of things.
--   forum   a channel of posts: each post has a title, tags and its own conversation (lib/forums.ts)
--   media   a forum where every post starts with a picture or video
--   stage   a voice channel for talks: speakers talk, the audience listens and can raise a hand
--   post    one forum post (a channel inside its forum: parent_id = the forum; never in channel lists)
-- Reports can now be about a server, a group chat, a channel or a forum post too (lib/reports.ts).
-- Run once in Supabase -> SQL Editor (after 018_moderation.sql). Safe to re-run.

alter table channels drop constraint if exists channels_kind_check;
alter table channels add constraint channels_kind_check
  check (kind in ('text', 'voice', 'announcement', 'category', 'forum', 'media', 'stage', 'post'));

-- forums: the tags posts can have ([{id, name, emoji?}], up to 20); posts: their tags, and how they're kept
alter table channels add column if not exists available_tags jsonb not null default '[]'::jsonb;
alter table channels add column if not exists tags           text[] not null default '{}';
alter table channels add column if not exists locked         boolean not null default false;     -- no new replies (except moderators)
alter table channels add column if not exists pinned         boolean not null default false;     -- first in the forum
alter table channels add column if not exists message_count  int not null default 0;
alter table channels add column if not exists last_activity  timestamptz;
create index if not exists channels_posts on channels(parent_id, last_activity desc) where kind = 'post';

-- stages: who's speaking, and who raised a hand to speak
alter table voice_states add column if not exists speaker   boolean not null default false;
alter table voice_states add column if not exists hand_at   timestamptz;

-- reports about a server, a group chat, a channel or a post (kind), not just a message or person
alter table reports add column if not exists kind text;     -- message | person | bot | server | group | channel | post

notify pgrst, 'reload schema';
