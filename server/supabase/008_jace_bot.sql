-- Jace Social: the official Jace bot - owned by @okjace, answers questions (AI from the Docs, or a
-- person), posts announcements to everyone, keeps the Docs, and can ban people from Jace Social
-- (lib/jaceBot.ts). Run once in Supabase -> SQL Editor (after 007_jace_messages.sql). Safe to re-run.

-- Bans from the whole platform (not one server): signed out everywhere, can't sign in again.
alter table profiles add column if not exists banned_at  timestamptz;
alter table profiles add column if not exists ban_reason text check (char_length(ban_reason) <= 400);

-- The Jace bot's first message to each person, sent once: null = a new account ("Welcome to Jace
-- Social!"), 'existing' = had an account before the Jace bot ("This is now the Jace bot!"), 'done'.
alter table profiles add column if not exists jace_welcome text check (jace_welcome in ('existing', 'done'));
update profiles set jace_welcome = 'existing'
  where jace_welcome is null and signed_up is not null and not coalesce(is_bot, false);

-- Announcements: shown in the Jace bot's Announcements tab, and sent to everyone as a message.
create table if not exists jace_bot_announcements (
  id          bigint generated always as identity primary key,
  body        text not null check (char_length(body) between 1 and 4000),
  sent_to     int not null default 0,
  created_at  timestamptz not null default now()
);

-- Docs: help articles in the Jace bot's Docs tab, and what its AI answers from.
create table if not exists jace_bot_docs (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9-]{1,60}$'),
  title       text not null check (char_length(title) between 1 and 120),
  body        text not null check (char_length(body) <= 20000),
  position    int not null default 0,
  updated_at  timestamptz not null default now()
);

-- Each person's chat with the Jace bot: answered by the AI, or handed to a person.
create table if not exists jace_bot_threads (
  uuid                text primary key references profiles(uuid) on delete cascade,
  mode                text not null default 'ai' check (mode in ('ai', 'human')),
  human_requested_at  timestamptz,
  updated_at          timestamptz not null default now()
);

alter table jace_bot_announcements enable row level security;
alter table jace_bot_docs          enable row level security;
alter table jace_bot_threads       enable row level security;
grant select, insert, update, delete on jace_bot_announcements, jace_bot_docs, jace_bot_threads to service_role;
grant usage, select on all sequences in schema public to service_role;
revoke all on jace_bot_announcements, jace_bot_docs, jace_bot_threads from anon, authenticated;

-- The starter Docs (edit them in the Jace bot's Docs tab; re-running this never overwrites them).
insert into jace_bot_docs (slug, title, position, body) values
('getting-started', 'Getting started', 1, $doc$
Jace Social is a place for friends, chats and servers - with Minecraft built in. It works on the web (jace-social.vercel.app), in the desktop app (Windows, macOS, Linux), on Android and iPhone, in Jace Launcher, and inside Minecraft with the Jace Social mod.

**Signing in:** use your **Jace** account or your **Minecraft** account. You can link both (Settings → Accounts) so either one signs you in, and your friends, chats and servers stay the same.

**First steps:**
1. Pick a display name and picture in **Settings → My profile**.
2. Add friends with their **@handle** or Minecraft username.
3. Create or join a **server** with an invite link.
$doc$),
('friends-and-handles', 'Friends and your @handle', 2, $doc$
**Your @handle** is your unique name on Jace Social. People can add you as a friend with it. Change it in **Settings → My profile** - handles are 3-20 characters (letters, numbers, _ and .), and you can change yours once a week.

**Adding friends:** press **Add friend** and type their @handle or Minecraft username. Minecraft names work even if they haven't joined Jace Social yet - they'll see your request when they do.

**Requests:** accept or decline them in **Friends**. To remove a friend, open their profile and press **Remove friend**.

**Status:** set Online, Idle, Do Not Disturb or Invisible, plus a custom status, from your profile picture in the corner.
$doc$),
('messages', 'Messages', 3, $doc$
Message your friends from **Direct messages**. You can:
- **reply** to a message, **react** with emoji, **edit** or **delete** your own messages
- send **pictures and files** (up to 10 MB each)
- **@mention** people (and roles in servers)
- use formatting: `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, and links

**Links** show a preview. Before leaving Jace Social for another site you'll see where the link really goes - you can turn that off or trust sites in **Settings → Links & privacy**.

**Muting:** right-click (or long-press) a chat to mute it.
$doc$),
('group-chats', 'Group chats', 4, $doc$
A group chat is a chat with up to 10 friends. Start one with the **+** next to **Group chats**, pick friends, and give it a name if you like.

Anyone in the group can rename it, change its picture, add friends, start a **group call**, and pin messages. The person who made it can remove people. Leave a group from its menu.
$doc$),
('servers', 'Servers, channels and roles', 5, $doc$
**Servers** are places for communities: text channels, voice channels, announcement channels, roles, and bots.

- **Create** a server, or **join** one with an invite link or code.
- **Channels** can be grouped in categories, and made private to some roles.
- **Roles** give people permissions (manage channels, kick, ban, time out, and more). Higher roles manage the ones below them.
- **Onboarding** can show new members the rules, ask questions that give them roles, and suggest channels to start in.
- **Invites:** share the invite link from the server menu, or set a custom link in Server settings → Invites.
$doc$),
('voice-and-calls', 'Voice channels and calls', 6, $doc$
**Call a friend** with the 📞 in your chat with them. You can mute, turn on your camera, and share your screen.

**Voice channels** in servers, and **group calls** in group chats, let several people talk at once, with cameras and screen sharing too.

Calls go straight between devices when possible, or through a relay that can't listen in. If someone can't hear you, check that Jace Social is allowed to use your microphone.
$doc$),
('jace-messages', 'Your Jace messages', 7, $doc$
If you sign in with **Jace**, your Jace conversations can show up in Jace Social, and messages between you and other Jace people are also saved to your Jace account. Jace's own site no longer shows messages, so Jace Social is where you read them.

Turn it on, off, or disconnect it in **Settings → Accounts → Jace messages**. Only text syncs (not files, reactions or edits). Chats with Minecraft-only players are never sent to Jace.
$doc$),
('bots', 'Bots', 8, $doc$
Bots are accounts that do things in chats: answer commands, welcome people, give roles, and more.

- **Add a bot** to your server in Server settings → Bots.
- **Make your own** in Settings → My bots: build it with blocks (no code), write it in JavaScript and let Jace Social run it, or program it anywhere with its token and the API.
- Type **/** in a chat to see the slash commands of the bots there.
- Everything a bot does is in its **Activity**, which its owner and the server's admins can see.
$doc$),
('apps-and-downloads', 'Apps and downloads', 9, $doc$
- **Web:** jace-social.vercel.app/app
- **Desktop:** Windows, macOS and Linux, from the downloads on jace-social.vercel.app. It updates itself and can start when you sign in.
- **Android:** the APK from the downloads (or Jace Store).
- **iPhone:** add the AltStore / SideStore source jace-social.vercel.app/altstore, and updates arrive there.
- **Minecraft:** the Jace Social mod (Fabric, NeoForge, Forge) from Jace Store, and friends in Jace Launcher.
$doc$),
('safety', 'Privacy and safety', 10, $doc$
- **Block someone** by removing them as a friend; only friends can message you directly.
- **Report a problem** by asking here and pressing **Talk to a person**.
- People who break the rules can be banned from Jace Social, and from their linked Jace account.
- Read what Jace Social keeps about you at jace-social.vercel.app/privacy.
$doc$)
on conflict (slug) do nothing;

-- The Jace bot itself (normally made the first time it's needed, lib/bots.ts ensureJaceBot).
insert into profiles (uuid, name, inbox, is_bot, bot_public, mc_linked, signed_up, status, bio, last_seen, avatar_url)
values ('00000000000000000000000000000ace', 'Jace', 'jace-bot-' || replace(gen_random_uuid()::text, '-', ''), true, true, false,
        now(), 'online', 'The official Jace Social bot. Ask me a question!', now() + interval '100 years',
        'https://jace-social.vercel.app/jace-bot.png')
on conflict (uuid) do nothing;
update profiles set bio = 'The official Jace Social bot. Ask me a question!'
  where uuid = '00000000000000000000000000000ace' and bio like '%Type / to see what I can do%';

-- The Jace bot is owned by @okjace (set once here, by handle; nobody can take it over later).
update profiles set bot_owner = (select uuid from profiles where handle = 'okjace' and not coalesce(is_bot, false) limit 1)
  where uuid = '00000000000000000000000000000ace' and bot_owner is null
    and exists (select 1 from profiles where handle = 'okjace' and not coalesce(is_bot, false));

notify pgrst, 'reload schema';

-- Who owns the Jace bot now (should be you, @okjace):
select b.name as bot, o.handle as owner_handle, o.name as owner_name
  from profiles b left join profiles o on o.uuid = b.bot_owner
  where b.uuid = '00000000000000000000000000000ace';
