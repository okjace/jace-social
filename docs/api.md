# Jace Social API (v1)

Every route, from the comments at the top of server/app/api/v1/**/route.ts (regenerate when
they change). Requests need `Authorization: Bearer <token>` unless said otherwise; bodies and
answers are JSON. Live events arrive on the player's private Supabase Realtime channel (`inbox`
from GET /me): see server/lib/server.ts `notify` and the web app's handling in
server/components/SocialApp.tsx.

## /api/v1/auth/finish
Step 2 of sign-in: ask Mojang whether this player really joined our server id.
Only the real owner of the Minecraft account can make that true, and we never
see their Microsoft password or Minecraft token.
methods: POST 

## /api/v1/auth/jace/callback
Jace sends the browser back here with ?code&state. We finish sign-in or linking,
then either redirect the web app (token in the #fragment, never in logs) or show
"you can close this tab" while the app picks the result up by polling.
methods: GET (browser redirect)

## /api/v1/auth/jace/poll
GET ?state=&key=  -> {pending: true} until the browser part finishes, then the result once.
methods: GET 

## /api/v1/auth/jace
Sign in with Jace.
GET ?return_to=/app  -> redirects the browser to Jace (web app)
POST {}             -> {url, state, poll_key}: apps open url in a browser, then poll /auth/jace/poll
methods: GET methods: POST 

## /api/v1/auth/minecraft/poll
POST {ticket}: {pending: true} until the player has entered the code at microsoft.com/link,
then signs them in like /auth/finish -> {token, uuid, inbox, realtime}
methods: POST 

## /api/v1/auth/minecraft
POST: start Minecraft sign-in in the browser -> {user_code, verification_uri, interval, expires_at, ticket}
(Microsoft's device code flow; see lib/minecraft.ts)
methods: POST 

## /api/v1/auth/signout
methods: POST 

## /api/v1/auth/start
Step 1 of sign-in: hand out a one-time "server id". The client then calls
Mojang's session server with it (exactly what joining a Minecraft server does).
methods: POST 

## /api/v1/bots/directory
GET ?q=: public bots anyone can add to their server (the official Jace bot first)
methods: GET 

## /api/v1/bots/[id]/activity
GET ?server=<id>&before=<log id>: everything a bot did (its activity log, newest first).
  Its owner sees all of it; in a server, people who can manage that server see what it did there.
methods: GET 

## /api/v1/bots/[id]/avatar
POST (image body): set your bot's picture
methods: POST 

## /api/v1/bots/[id]/code
PUT {code}: save your bot's JavaScript (it runs here, see lib/codebots.ts); null removes it.
  Checked first: it has to load, and its bot.command(...)s become its slash commands.
POST {code, text?, command?}: try code without saving or doing anything: runs it for a
  pretend message (or command) and says what it would do.
methods: PUT methods: POST 

## /api/v1/bots/[id]/program
PUT {program, blocks?}: save your bot's block program (see lib/blocks.ts). blocks is the
    editor's own save of the workspace, kept so it can be opened again.
methods: PUT 

## /api/v1/bots/[id]
GET: a bot's public page (anyone): profile, owner, commands, and whether you can add it
PATCH {name?, bio?, bot_public?, bot_enabled?, bot_commands?}: edit your bot
DELETE: delete your bot (it leaves every server)
methods: GET methods: PATCH methods: DELETE 

## /api/v1/bots/[id]/session
POST: sign in as your bot (for the account switcher) -> {token, uuid, name}
methods: POST 

## /api/v1/bots/[id]/token
POST: a new API token for your bot (the old ones, and switched-in sessions, stop working)
methods: POST 

## /api/v1/bots
GET: your bots
POST {name}: make a bot (you're its owner) -> {bot, token}. The token is only shown now;
     make a new one with POST /bots/{id}/token.
methods: GET methods: POST 

## /api/v1/calls/ice
GET: ICE servers for a voice call. STUN always; TURN relay (for players behind
strict NATs) from Cloudflare Realtime when CLOUDFLARE_TURN_KEY_ID and
CLOUDFLARE_TURN_API_TOKEN are set. Credentials are short-lived.
methods: GET 

## /api/v1/calls
POST {to, call_id, kind: offer|answer|hangup|renegotiate|reanswer, sdp?}: send call setup to a friend
  (renegotiate/reanswer: a new description mid-call, e.g. when screen sharing starts)
GET ?id=<signal id>: read a call signal sent to you (the live event only carries its id)
methods: POST methods: GET 

## /api/v1/channels/[id]/commands
GET: slash commands you can use here (from the bots in this chat)
POST {bot, name, args}: use one
methods: GET methods: POST 

## /api/v1/channels/[id]/messages
GET ?before=<id>&around=<id>: 50 messages (oldest first) with senders, reactions and replied-to messages
POST {body, reply_to?, attachments?}: send a message to a group chat or server channel
methods: GET methods: POST 

## /api/v1/channels/[id]/overrides
PUT {target_type: role|member, target_id, allow, deny}: set a channel's permission override
    for a role or a member (manage roles, and only permissions you have)
DELETE ?target_type=&target_id=: remove it
methods: PUT methods: DELETE 

## /api/v1/channels/[id]/pins
GET: a channel's pinned messages (newest pin first) with their senders
methods: GET 

## /api/v1/channels/[id]/read
POST {id?}: mark the channel read up to message id (default: everything)
methods: POST 

## /api/v1/channels/[id]
PATCH {name?, topic?, position?, parent_id?, slowmode?, user_limit?}: edit a server channel (manage channels)
DELETE: delete a server channel (manage channels; a server keeps at least one text channel)
methods: PATCH methods: DELETE 

## /api/v1/channels/[id]/typing
POST: "I'm typing" in a group chat or channel (shown to the others for ~8 seconds)
methods: POST 

## /api/v1/channels/[id]/voice
Voice rooms: server voice channels, and calls in group chats.
GET: who's in the room
POST {action: "join" | "leave" | "state", muted?, deafened?, streaming?}
  join: enter the room (leaves any other room) -> {participants, ice_servers}
  state: mute/deafen/screen sharing, and the heartbeat (every ~20 s; gone after 45 s)
methods: GET methods: POST 

## /api/v1/friends/respond
POST {uuid, accept}: accept or decline an incoming friend request
methods: POST 

## /api/v1/friends
GET: friends (with online status + what they're doing), incoming and outgoing requests
POST {name} or {uuid}: send a friend request. name can be a Minecraft username (works even if they
  haven't used Jace Social yet), someone's @handle, or a Jace username (write @name to skip Minecraft).
DELETE ?uuid=: remove a friend or cancel/decline a request
methods: GET methods: POST methods: DELETE 

## /api/v1/groups/[id]/icon
POST (image body): set the group's picture
methods: POST 

## /api/v1/groups/[id]/members
POST {uuid}: add a friend to the group chat (any member)
DELETE ?uuid=: leave (your own id) or, for the group's owner, remove someone
methods: POST methods: DELETE 

## /api/v1/groups/[id]
PATCH {name}: rename a group chat (any member)
methods: PATCH 

## /api/v1/groups
GET: your group chats (members, unread count, last message time)
POST {name?, members: [uuid]}: start a group chat with friends (up to 10 people including you)
methods: GET methods: POST 

## /api/v1/health
Public status for the website: is the service up, and how many players use it.
No personal data.
methods: GET 

## /api/v1/invites/[code]
GET: preview the server an invite is for (works signed out too, for invite pages)
POST: join it. The code can be a server's invite code or its custom link (vanity).
methods: GET methods: POST 

## /api/v1/jace-bot/thread
Your chat with the official Jace bot (lib/jaceBot.ts).
GET: {mode: "ai" | "human"} - who answers: the AI, or a person from Jace
POST {human: boolean}: "Talk to a person" (true) or "Back to the AI" (false)
methods: GET methods: POST

## /api/v1/jace-bot/announcements
GET: everyone - newest first (50)
POST {body}: (the Jace bot) post one: it's in the Announcements tab, and goes to everyone as a message
DELETE ?id=: (the Jace bot) remove one from the tab (messages already sent stay)
methods: GET methods: POST methods: DELETE

## /api/v1/jace-bot/docs
GET: everyone - the Jace bot's Docs. POST {title, body}, PATCH {id, title?, body?, position?},
DELETE ?id=: (the Jace bot) manage them
methods: GET methods: POST methods: PATCH methods: DELETE

## /api/v1/jace-bot/inbox
GET: (the Jace bot, or its owner) everyone with a chat with it, people who asked for a person first
methods: GET

## /api/v1/jace-bot/ban
POST {uuid, reason?, jace?}: (the Jace bot) ban from all of Jace Social; jace: also their Jace account
DELETE ?uuid=&jace=1: unban
methods: POST methods: DELETE

## /api/v1/jace/cron
GET: the Jace message sync's regular run (every 5 minutes): resend queued messages, pull new Jace
messages for everyone connected. Only with Authorization: Bearer <CRON_SECRET>.
methods: GET

## /api/v1/jace/messages/sync
POST: "Sync now" - bring in what's new from Jace and resend anything waiting -> the same as
      GET /jace/messages, plus {imported}
methods: POST

## /api/v1/jace/messages
Syncing your direct messages and group chats with your Jace messages (lib/jaceSync.ts).
GET: {available, state: none|ok|disconnected|banned, sync_enabled, imported, last_sync_at, last_error}
  none / disconnected: connect (or reconnect) with POST /link/jace, which signs in with Jace again
PATCH {sync: boolean}: the "Sync messages with Jace" switch
DELETE: "Disconnect Jace messages" - deletes the stored Jace token
methods: GET methods: PATCH methods: DELETE

## /api/v1/link/jace
POST: link a Jace account to the signed-in (Minecraft) player -> {url, state, poll_key}.
      Open url in a browser, then poll /api/v1/auth/jace/poll.
DELETE: unlink Jace (only when Minecraft can still sign in).
methods: POST methods: DELETE 

## /api/v1/link/minecraft/device/poll
POST {ticket}: {pending: true} until the code is entered, then links that Minecraft account
methods: POST 

## /api/v1/link/minecraft/device
POST: start linking Minecraft from the browser (same device code flow as sign-in)
methods: POST 

## /api/v1/link/minecraft
POST {name, server_id}: link Minecraft to the signed-in (Jace) player. Same proof as Minecraft
sign-in (the app "joins" server_id from /auth/start with Mojang). If that Minecraft player
already uses Jace Social, the two accounts become one, keeping friends and chats from both.
methods: POST 

## /api/v1/appeals
Jace ban appeals, for Jace Official's owner and admins only (Jace decides who - lib/appeals.ts).
GET: {appeals: [{user_id, username, picture, status: banned|muted|active|deleted, ban_reason, banned_at,
  mute_reason, muted_at, last_message, waiting, unread}]}, newest activity first; {reconnect: true}
  when their Jace sign-in stopped working. Anyone else: 404, the same as a page that doesn't exist.
methods: GET 

## /api/v1/appeals/[id]
One Jace ban appeal (staff only). {id} is the appealing person's Jace user id.
GET ?since=: {appeal, messages: [{id, from_id, from_name, body, created_at}]}, oldest first. Opening it marks it read.
POST {body, reply_id}: reply as Jace Official. Send the same reply_id when retrying: Jace skips it.
methods: GET methods: POST 

## /api/v1/appeals/[id]/decision
POST {action: "unban", reason?}: lifts the ban on Jace (checked with Jace again first) -> {result}
POST {action: "keep", body, reply_id}: keeps it - just a reply as Jace Official.
methods: POST 

## /api/v1/me/avatar
POST (body = the image, Content-Type image/png|jpeg|gif|webp - animated too -, up to 4 MB): new profile picture
DELETE: back to your Minecraft head (or initials)
methods: POST methods: DELETE 

## /api/v1/me/background
POST (image body): upload a background picture for Settings -> Appearance. It's used once you
save it in your settings (PATCH /me {settings: {background: url}}).
methods: POST 

## /api/v1/me/banner
POST (image body): set your profile banner; DELETE: remove it
methods: POST methods: DELETE 

## /api/v1/me
GET: your own profile (everything friends see, plus account details)
PATCH {display_name?, handle?, bio?, pronouns?, accent_color?, links?, status?, custom_status?, status_emoji?}
  handle: your unique @name (3-20: letters, numbers, _ and .), changeable once every 7 days
DELETE: delete your account (ask the Jace bot). Only with a session from signing in again in the last
  10 minutes. -> {recovery_id, expires_at}: pasting the recovery ID to the Jace bot from a new account
  within 10 days brings it all back (lib/accountDeletion.ts)
methods: GET methods: PATCH methods: DELETE 

## /api/v1/messages/direct/[id]
PATCH {body}: edit your own direct message; DELETE: delete it
methods: PATCH methods: DELETE 

## /api/v1/messages/[id]/pin
PUT: pin a group/server message; DELETE: unpin it (servers: manage messages; group chats: anyone)
methods: PUT methods: DELETE 

## /api/v1/messages/[id]
PATCH {body}: edit your own group/server message
DELETE: delete your own message (people who can manage messages can delete anyone's)
methods: PATCH methods: DELETE 

## /api/v1/messages/read
POST {with}: mark a friend's messages to me as read
methods: POST 

## /api/v1/messages
GET ?with=<uuid>&before=<id>: chat history with a friend (newest 50, oldest first), with reactions
  and the messages replied to
POST {to, body, reply_to?, attachments?}: send a message to a friend (anyone can message the official
  Jace bot, and it can message anyone)
methods: GET methods: POST 

## /api/v1/messages/typing
POST {to}: "I'm typing" in a direct message
methods: POST 

## /api/v1/presence
POST {activity} every ~2 minutes while the launcher or game is open.
activity: {type: launcher|playing|hosting|app, instance?, version?, loader?, modpack?, server?, world?,
           address?, details?, state?, started_at?, app?} or null to go offline.
methods: POST 

## /api/v1/reactions
POST {scope: "c"|"d", message_id, emoji}: add a reaction; DELETE (same body): remove yours.
scope "c" = group/server messages, "d" = direct messages.
methods: POST methods: DELETE 

## /api/v1/releases/[kind]
GET /api/v1/releases/desktop | mobile: the newest app version, what's new and its downloads
(the phone app checks this for updates). Public; cached.
methods: GET (browser redirect)

## /api/v1/servers/[id]/banner
POST (image body): set the server banner (manage server); DELETE: remove it
methods: POST methods: DELETE 

## /api/v1/servers/[id]/bans
GET: the server's bans (ban members)
POST {uuid, reason?, delete_messages?}: ban someone (removes them; they can't rejoin)
DELETE ?uuid=: unban
methods: GET methods: POST methods: DELETE 

## /api/v1/servers/[id]/bots
POST {bot}: add a bot to the server (add bots). It must be public, or yours.
methods: POST 

## /api/v1/servers/[id]/channels
POST {name, kind?: text|voice|announcement|category, parent_id?, topic?, private?}: add a channel
     (manage channels). private: only you and people with roles you add later can see it.
PUT {order: [{id, parent_id}]}: reorder channels and move them between categories
methods: POST methods: PUT 

## /api/v1/servers/[id]/icon
POST (image body): set the server icon (admins)
methods: POST 

## /api/v1/servers/[id]/invite
POST: make a new invite code (create invites). The old code stops working.
methods: POST 

## /api/v1/servers/[id]/members
DELETE ?uuid=: leave the server (your own id) or kick someone (kick members; only people
              below your highest role). The owner can't leave - hand it over or delete it.
PATCH {uuid, nickname?, timeout_until?, roles?, role?: "owner"}: change a member:
  nickname (yours: change nickname; others: manage nicknames), time out (time out members),
  roles (manage roles; only roles below yours), or hand the server over (owner).
methods: DELETE methods: PATCH 

## /api/v1/servers/[id]/onboarding
POST {answers: [[optionIndex, ...], ...], agreed?: true}: finish the server's onboarding.
     Each picked answer gives its roles; agreed = accepted the rules.
methods: POST 

## /api/v1/servers/[id]/roles/[roleId]
PATCH {name?, color?, icon?, permissions?, hoist?, mentionable?}: edit a role below yours (manage roles)
DELETE: delete a role below yours
methods: PATCH methods: DELETE 

## /api/v1/servers/[id]/roles
POST {name, color?, icon?, permissions?, hoist?, mentionable?}: create a role (manage roles),
     placed just below your highest role
PUT {order: [roleId, ...]} (highest first): reorder roles below yours
methods: POST methods: PUT 

## /api/v1/servers/[id]
GET: a server with its channels (the ones you can see, with unread counts and your permissions
     in each), roles, members, voice rooms, and your own permissions
PATCH {name?, description?, vanity?, banner?, accent_color?, rules?, welcome?, onboarding?,
       system_channel?, invites_paused?}: server settings (manage server)
DELETE: delete the server (owner)
methods: GET methods: PATCH methods: DELETE 

## /api/v1/servers
GET: servers you're in (with unread counts)
POST {name}: create a server (you're the owner; it starts with #general)
methods: GET methods: POST 

## /api/v1/uploads
POST {name, type, size}: a one-time signed URL to upload a file for a message (see lib/uploads.ts)
  -> {path, token, upload_url, url}; then send the message with attachments: [{url, name, type, size}]
methods: POST 

## /api/v1/users/[id]
GET: someone's profile, whether you're friends, and servers you share
methods: GET 

## /api/v1/users
GET ?q=name : find Jace Social players by @handle, display name, Jace or Minecraft username (10 max)
methods: GET 

## /api/v1/version
GET: which build of the website is live (open apps compare it with their own, to offer a reload).


## /api/v1/voice/signal
Connection setup inside a voice room (each pair of people has its own connection).
POST {channel_id, to, kind: offer|answer, sdp}: send it to someone in the same room
GET ?id=: read one sent to you (the live "voice_signal" event only carries its id)
methods: POST methods: GET 

