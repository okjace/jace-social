# Native phone apps

Jace Social for phones is being rewritten as two native apps (the user's choice, 2026-10-12):

| | iPhone | Android |
|---|---|---|
| Folder | `ios/` | `android/` |
| Language / UI | Swift, SwiftUI (iOS 16+) | Kotlin, Jetpack Compose, Material 3 (Android 8+, API 26) |
| HTTP | URLSession (async/await) | OkHttp + kotlinx.serialization |
| Live events | URLSessionWebSocketTask (Phoenix protocol) | OkHttp WebSocket (Phoenix protocol) |
| Calls (WebRTC) | WebRTC (stasel/WebRTC, Swift Package) | stream-webrtc-android |
| Sign-in token | Keychain | EncryptedSharedPreferences |
| Jace sign-in | ASWebAuthenticationSession | Custom Tabs |
| Project file | XcodeGen (`ios/project.yml`) | Gradle (Kotlin DSL) |

Both talk to the same API as the website ([api.md](api.md)) and get the same live events. They keep
the earlier app's id (`dev.jacedeb.jacesocial`) and Android signing key, so 2.0.0 installs over the
Capacitor app (1.x, the website in a shell). Releasing works like before: bump `mobile/package.json`
and `mobile/CHANGELOG.md`, push; the "phone" part (native.yml) builds, tests and publishes them.

Building: only on GitHub (the "native" part of Build and release). The iPhone app needs a Mac, so it
is only ever built on GitHub's macOS runners. CI starts each app (Android emulator, iOS simulator),
takes screenshots and uploads them, which is how screens get checked.

The one exception to "native": the block bot editor is Blockly (JavaScript, no native version),
so it opens as a web page inside the app.

## The app for older iPhones (`ios12/`)

A third, smaller app for iPhones stuck on iOS 12 (iPhone 5s, 6), added 2026-10-27 at the user's
request. SwiftUI, async/await, Combine and URLSessionWebSocketTask all need iOS 13, so it is plain
UIKit with completion handlers, and its own WebSocket client (`WebSocket.swift`, RFC 6455 over
URLSessionStreamTask). Its own app id (`dev.jacedeb.jacesocial.ios12`), so it installs next to the
main app. It shares the version and changelog with the other phone apps and is released with them
as `jace_social_mobile-<version>-ios12-unsigned.ipa` (GitHub release and Jace Store, from 2.0.2).

What it has: signing in (Jace, Minecraft), Chats (direct messages, group chats, servers with their
text and voice channels; new group chats, creating and joining servers), messages (text, photos,
replies, reactions, editing and deleting your own, older messages, typing), live updates, calls with
friends and voice channels (WebRTC, the same signalling as the main app, ported to callbacks; camera
too), group chat settings, server settings (name, description, icon, channels, roles and their
permissions, members: roles / kick / ban, bans, adding your bots, deleting), bots (make, rename, picture,
public / on, new token, code editor with Try), Friends, You (status, custom status, display name,
picture, sign out). Not in it: sharing your screen, the block bot editor, onboarding questions.

Notifications while the app is closed: a sideloaded app can't get push notifications, so iOS's
background fetch wakes it now and then (iOS decides how often) and `Unread.swift` notifies about
direct messages and group chats with more unread than last time. While it's still running in the
background (just left, or in a call), live events notify straight away.

Updates: it checks /releases/mobile when it opens (once a day; You → Updates turns it off) and offers
the "ios12" download. AltStore / SideStore install updates by themselves once the website's source
(/altstore) is added: it lists this app as a second app, "Jace Social (iOS 12)" (iOS 12.2+, AltStore's
own minimum). With Sideloadly, people install the new download by hand.

It must be built with Xcode 16 (CI picks it); newer Xcodes don't build for iOS 12. CI checks that the
release, and the libraries in it (WebRTC), still allow iOS 12.

## The same structure on both

- `Api`: one function per endpoint, typed models that mirror `server/lib/client.ts`
- `Session`: token storage, sign-in (Jace in a browser plus polling; Minecraft device code), sign out,
  the account switcher
- `Live`: Supabase Realtime over a websocket. Join `realtime:<inbox>`, turn broadcasts into events:
  call, channel, command, dm_update, friends, groups, message, presence, servers, typing, voice,
  voice_signal
- `Store`: app state (me, friends, groups, servers, open chat), refreshed by API calls and live events
- Screens: listed below

## Features (✓ = done on both; released in 2.0.0)

- [x] Sign in with Jace / with Minecraft, sign out, account switcher
- [x] Friends: list with presence and activity, requests (send, accept, decline, cancel), remove
- [x] Direct messages: history, send, edit, delete, reply, reactions, typing, read state, pins
- [x] Messages: markdown, @mentions, link previews, attachments (upload, images, files), link warning
- [x] Group chats: create, rename, icon, members, leave
- [x] Servers: list, create, join by invite, channels by category, unread, text channels
- [x] Server settings: roles, permissions, channels, overrides, invites, vanity link, bans, onboarding,
      members (kick, ban, time out, nickname, roles), bots
- [x] Slash commands from bots
- [x] Profiles: view, edit (name, bio, pronouns, links, avatar, banner, accent), status and custom status
- [x] Voice calls with friends (WebRTC): ring, answer, mute, camera, screen sharing (Android; iPhone sees others'), move between devices
- [x] Voice channels and group calls (mesh), camera and screen sharing in them
- [x] Notifications while the app runs (in the background too); push when it's closed is still to do (APNs / FCM keys)
- [x] Bots: my bots, create, token, code editor + Try it, block editor (web view), activity log
- [x] Settings: appearance (themes, accent, text size, compact), notifications, privacy, links, accounts
- [x] Onboarding / welcome tour, server onboarding
- [x] Invite links (jacesocial://invite/<code>, https links)
- [x] Updates: the "new version" prompt (Android: APK; iPhone: release page)
