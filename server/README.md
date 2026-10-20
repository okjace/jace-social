# Jace Social server and web app

The server behind Jace Social: friends, messages, group chats, servers and hosted worlds. It serves the web app at `/app` too.
Jace Launcher, the desktop app and the Jace Social mod all talk to it. It's a Next.js app on Vercel with a Supabase database.

## How it works

- **Minecraft sign-in in the browser:** browsers can't talk to Xbox Live, so the web app uses Microsoft's device code flow. You enter a code at microsoft.com/link, and the server swaps the result for your Minecraft profile (Microsoft → Xbox Live → Minecraft). Unlike the other sign-ins, the server briefly holds those tokens. It uses them once to read the profile and never stores them (`lib/minecraft.ts`).
- **Sign-in (desktop app, Jace Launcher, mod):** works like joining a Minecraft server. The server hands out a one-time id, the client tells Mojang it "joined" it, and the server asks Mojang to confirm (`hasJoined`). Only the real account owner can do that. Minecraft tokens never reach this server, and only Microsoft accounts work.
- **Database access:** every table has row-level security on and no policies, so only the server (secret key) can read or write. Players go through `/api/v1/*` with a bearer token.
- **Live updates:** each player has a private, unguessable Supabase Realtime channel. Broadcasts only say what changed (never message text), and clients then fetch through the API.
- **Hosted worlds:** the mod opens your world to LAN, the e4all mod gives it a public address, and the address is shared with friends through your status.

## Setup (one time)

1. **Supabase:** create a free project at <https://supabase.com>.
   - **Security options when creating the project:** Data API **on**, "Automatically expose new tables" **off**, automatic RLS **on**.
   - **SQL Editor:** run `supabase/schema.sql`, then `supabase/002_calls.sql`, then `supabase/003_social.sql`, then `supabase/004_community.sql`, then `supabase/005_code_bots.sql`, `supabase/006_handles.sql` (everyone's @handle) and `supabase/007_jace_messages.sql` (syncing messages with Jace). 003 adds Jace accounts, profiles, group chats, servers and the `avatars` storage bucket. 004 adds roles and permissions, replies, reactions, files (the `attachments` bucket), moderation, custom invite links, onboarding, voice channels and bots. Each file is safe to run again.
   - **Realtime → Settings:** make sure public channel access is allowed (it's the default).
   - **Project Settings → API Keys:** copy the project URL, the **publishable** key and the **secret** key.
2. **Vercel:** New Project, then import `okjace/jace-social`.
   - **Root Directory:** `server`
   - **Project name:** `jace-social` (that gives `https://jace-social.vercel.app`, the address the launcher and mod use).
   - **Environment variables:** `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY` (see `.env.example`).
   - **Sign in with Jace:** register an app at Jace with this redirect URI:
     `https://jace-social.vercel.app/api/v1/auth/jace/callback`
     Then add `JACE_OAUTH_CLIENT_ID` and `JACE_OAUTH_CLIENT_SECRET`.
   - **Syncing messages with Jace** (see below): `JACE_TOKEN_KEY` (encrypts people's Jace tokens:
     `openssl rand -base64 32`) and `CRON_SECRET` (any long random text; also add it as the
     `CRON_SECRET` secret on GitHub, which runs the sync every 5 minutes).
   - Deploy.

## Jace messages

Direct messages and group chats sync both ways with people's Jace messages (jaceo.vercel.app's
messages API; Jace's own site no longer shows them, so Jace Social is where they're read). See
`lib/jaceSync.ts`. In short:

- **Connect:** "Sign in with Jace" asks for `profile messages`. The access token is kept encrypted
  with `JACE_TOKEN_KEY` (AES-256-GCM) in `jace_connections`, never sent to clients. People who
  signed in before connect in Settings → Accounts → Jace messages (it signs in with Jace again).
- **Import:** the first sync copies every Jace conversation once, with original times. Jace people
  who never used Jace Social get a placeholder profile, which becomes theirs when they sign in with
  Jace; people who talk on Jace become friends here so their chat shows up.
- **Pull:** every 5 minutes (`.github/workflows/jace-sync.yml` calls `/api/v1/jace/cron`), and right
  after someone opens a chat. Only conversations with something new are fetched (`?since=`).
- **Push:** messages sent here between two Jace people, or in a group chat that came from Jace, also
  go to Jace (text only, `external_id` `js-dm-<id>` / `js-ch-<id>`), after the sender gets their
  answer, through the `jace_outbox` queue with retries.
- **No duplicates:** `jace_message_links` maps Jace message ids to local ones; our own pushes are
  linked under the id Jace gives them, so they never come back.
- **Moderation:** a banned Jace account stops syncing; a muted one keeps its messages here only.
- **Off switch:** Settings → Accounts → Jace messages: "Sync messages with Jace", "Sync now",
  "Disconnect Jace messages" (deletes the token). Minecraft-only people are never involved.
- **Testing:** `scripts/mock-jace.mjs` is a local Jace with two users who already talk; point the
  server at it with `JACE_URL` (never in production). `scripts/test-jace-core.mjs` tests the parts
  without a database; `scripts/test-jace-sync.mjs` runs the whole sync against a test Supabase project.

## API (`/api/v1`, `Authorization: Bearer <token>`)

| Method | Path | |
|---|---|---|
| POST | `auth/start` → `{server_id}` | step 1 of sign-in (no auth) |
| POST | `auth/finish` `{name, server_id}` | step 2: returns `{token, uuid, inbox, realtime}` |
| POST | `auth/minecraft` → `{user_code, verification_uri, ticket}` | browser Minecraft sign-in (no auth) |
| POST | `auth/minecraft/poll` `{ticket}` | `{pending}` until the code is entered, then like `auth/finish` |
| POST | `link/minecraft/device`, `link/minecraft/device/poll` `{ticket}` | the same, to link Minecraft to a signed-in Jace account |
| POST | `auth/signout` | |
| GET | `me` | (Jace-linked people: also `jace_messages`, see `jace/messages`) |
| GET, PATCH `{sync}`, DELETE | `jace/messages` | syncing with Jace messages: its state, the switch, disconnect |
| POST | `jace/messages/sync` | "Sync now" |
| GET | `friends` | friends with status and unread counts, plus incoming and outgoing requests |
| POST | `friends` `{name}` | send a request (works even if they haven't signed up yet) |
| DELETE | `friends?uuid=` | remove a friend or cancel/decline a request |
| POST | `friends/respond` `{uuid, accept}` | |
| POST | `presence` `{activity}` / `{offline: true}` | heartbeat every ~2 min |
| GET | `messages?with=&before=` | 50 newest, oldest first |
| POST | `messages` `{to, body}` | friends only, 500 chars max, 20/min |
| POST | `messages/read` `{with}` | |
| POST | `calls` `{to, call_id, kind, sdp?}` | voice call setup (offer / answer / hangup), friends only |
| GET | `calls?id=` | read a call signal sent to you (the live `call` event carries its id) |
| GET | `calls/ice` | STUN/TURN servers for calls |

## Servers, bots and the rest (`004_community.sql`)

| Area | Endpoints |
|---|---|
| Permissions | Bits in `lib/permbits.ts`. `GET servers/{id}` returns your permissions, roles, channels (each with your permissions there), members, voice rooms and onboarding |
| Roles | `POST/PUT servers/{id}/roles`, `PATCH/DELETE servers/{id}/roles/{roleId}`, `PATCH servers/{id}/members {uuid, roles, nickname, timeout_until}` |
| Channels | `POST/PUT servers/{id}/channels` (text, voice, announcement, category), `PATCH/DELETE channels/{id}`, `PUT/DELETE channels/{id}/overrides` |
| Moderation | `DELETE servers/{id}/members?uuid=` (kick), `GET/POST/DELETE servers/{id}/bans` |
| Messages | `POST channels/{id}/messages {body, reply_to, attachments}`, the same on `messages` for DMs; `POST/DELETE reactions {scope: c/d, message_id, emoji}`; `PUT/DELETE messages/{id}/pin`; `POST channels/{id}/typing`; `POST uploads` (a signed upload URL, 10 MB) |
| Invites | `GET/POST invites/{code}` (an invite code or a custom link); the page at `/{code}` offers the desktop app (`jacesocial://invite/{code}`) or the browser |
| Onboarding | `POST servers/{id}/onboarding {answers, agreed}`; your own: `PATCH me {onboarded: true, settings}` |
| Voice rooms | `GET/POST channels/{id}/voice {action: join/leave/state}`, `POST/GET voice/signal` (a mesh; each pair has its own connection) |
| Bots | `GET/POST bots`, `GET/PATCH/DELETE bots/{id}`, `POST bots/{id}/token`, `POST bots/{id}/session`, `PUT bots/{id}/program`, `GET bots/directory`, `POST servers/{id}/bots`, `GET/POST channels/{id}/commands` |

**Bots** use the same API with `Authorization: Bearer <bot token>` and get live events on their own Realtime channel (`GET /me`), plus `command` when someone uses one of their slash commands. **Block bots** are run by the server (`lib/blocks.ts`) when someone sends a message, uses a command or joins, with limits: 500 steps, 5 messages and 4 seconds of waiting per event. The official **Jace** bot (`lib/bots.ts`) is built in.

**Link previews** are fetched by the server after a message is sent (so people's IP addresses don't go to every linked site). Private and local addresses are never fetched.

## Voice calls

One-to-one calls work in the web app, the desktop app and Jace Launcher, and any of them can call any other (the Jace Social mod controls calls through the launcher). The web app uses the browser's WebRTC (`lib/calls.ts`), the launcher uses aiortc; both send a full description once ICE gathering finishes, with no trickle. Audio goes straight between the two players. When a direct connection isn't possible, it goes through Cloudflare's free TURN relay.

Setup:
1. In Supabase's **SQL Editor**, run `supabase/002_calls.sql`.
2. Optional, for the relay: in the Cloudflare dashboard, go to **Realtime → TURN Server → Create**. Then add these Vercel environment variables and redeploy:
   - `CLOUDFLARE_TURN_KEY_ID`: the Turn Token ID
   - `CLOUDFLARE_TURN_API_TOKEN`: the API token
   Without them, calls still work for most home networks (STUN only).
