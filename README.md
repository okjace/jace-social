# Jace Social

**Website:** https://jace-social.vercel.app · **Web app:** https://jace-social.vercel.app/app

Friends, direct messages, group chats, servers and voice calls, with Minecraft built in. Use it:
- in your browser
- as a desktop app for Windows, macOS and Linux
- in [Jace Launcher](https://github.com/okjace/jace-launcher)
- inside Minecraft with the Jace Social mod

One account, the same friends everywhere.

## What's here

| Folder | What it is |
|---|---|
| `server/` | The Jace Social server and web app (Next.js on Vercel, Supabase database). See [server/README.md](server/README.md). |
| `app/` | The desktop app: the web app in its own window, plus Minecraft sign-in, notifications and a tray icon (Python + Qt). |
| `mod/` | The Jace Social mod for Minecraft 1.20.1-26.3 on Fabric/Quilt, NeoForge and Forge (Stonecutter). |
| `site/` | A redirect: the old GitHub Pages address sends visitors to the website at jace-social.vercel.app (`server/app/page.tsx`). |
| `packaging/` | Scripts that publish the mod and the desktop app to [Jace Store](https://jace-store-deb.vercel.app). |

## Accounts

Sign in with a **Jace** account (in the browser and the desktop app) or with **Minecraft** (in Jace Launcher, the desktop app and the mod). Link them so both work:
- **Jace Launcher:** Settings → Jace Social → **Link Jace**
- **Desktop app or web:** Settings → Linked accounts. In the browser, Minecraft sign-in and linking use a code you enter at microsoft.com/link.

If both accounts already had friends or chats, linking merges them into one.

## Features

- **Jace messages:** sign in with Jace and your Jace conversations show up here, and messages between Jace people are also saved to your Jace account (Settings → Accounts → Jace messages turns it off). See [Privacy](https://jace-social.vercel.app/privacy).
- **Friends:** add by @handle, Minecraft or Jace username, with requests, online status and unread counts.
- **Direct messages and group chats:** up to 10 people per group, with a name, picture, and adding or removing people.
- **Servers, like Discord:**
  - text, voice and announcement channels in categories, with private channels and slowmode
  - roles with colors, icons and permissions, plus per-channel permissions
  - invite links (`jace-social.vercel.app/<code>`) and a custom link (`jace-social.vercel.app/yourserver`) that open in the desktop app or the browser
  - onboarding: rules, questions that give roles, and a welcome screen
  - moderation: kick, ban, time out, nicknames, pins, deleting messages
  - an icon, banner, accent color and description
- **Messages:** replies, reactions, @mentions (people, roles, @everyone), files and pictures (up to 10 MB), link previews, Discord-style formatting, typing indicators, and clickable links that warn before leaving Jace Social.
- **Voice:** one-to-one calls, voice channels and group calls (up to 8 people), with screen sharing.
- **Bots:** make your own bots, either Scratch-style with blocks (they run on the Jace Social server) or with code through the API and a bot token. You can switch to a bot and chat as it. The official **Jace** bot has `/help`, `/roll`, `/poll`, `/mcstatus` and more.
- **Make it yours:** themes (dark, midnight, forest, light), accent color, text size, compact mode, notification settings and muting, an account switcher, a profile banner.
- **Status:** Online, Idle, Do Not Disturb or Invisible, plus a custom status with an emoji.
- **Rich presence:** the Minecraft version and loader, the server or world, the modpack, and how long you've been playing. It's reported by Jace Launcher and the mod.
- **Profiles:** picture, display name, pronouns, about me, profile color, and up to 5 links.
- **Voice calls with Jace Launcher too:** one-to-one calls work between the web app, the desktop app and Jace Launcher, and the mod controls them.
- **In Minecraft (the mod):** friends, group chats and server channels; host your world with roles, and permission menus (LuckPerms, or the mod's own groups where LuckPerms can't run) and WorldEdit.

## Desktop app

Each download is the app itself: `JaceSocial-<ver>-windows-x64.exe`, `-macos-arm64.app.zip` / `-macos-x86_64.app.zip`, or `-x86_64.AppImage`. The first time it runs, a setup wizard installs it, then starts the installed copy and deletes the download. Setup can't be skipped; cancelling closes the app.

| | Installs to | Options |
|---|---|---|
| Windows | `%LOCALAPPDATA%\Programs\Jace Social` (no admin) | Start menu, desktop shortcut, start with Windows, Installed apps entry, `jace-social` command |
| macOS | `/Applications` or `~/Applications` | Dock, desktop shortcut, open at login, `jace-social` command, remove the quarantine flag |
| Linux | `~/Applications` | menu entry, desktop shortcut, start at login, `jace-social` command, app center info |

Your sign-in and settings live outside the app folder (`%APPDATA%\Jace Social`, `~/Library/Application Support/Jace Social` or `~/.local/share/jace-social`), so updates and reinstalls keep them. The app isn't signed: on a Mac, right-click → **Open** the first time (macOS 15+: System Settings → Privacy & Security → **Open Anyway**); on Windows, **More info → Run anyway**.

Command line: `--install` (the wizard), `--install --yes` (defaults, no questions), `--uninstall`, `--uninstall --purge` (also your sign-in and settings), `--hidden` (start in the tray), `--help`.

Build it with `python app/packaging/build.py` on Windows or macOS, or `app/packaging/build_appimage.sh` on Linux. PyInstaller can't cross-compile, so releases are built by GitHub Actions.

## Releases

- **Mod:** `git tag mod-vX.Y.Z && git push origin mod-vX.Y.Z` builds every Minecraft version and publishes it to Jace Store.
- **Desktop app:** `git tag app-vX.Y.Z && git push origin app-vX.Y.Z` builds every platform, tests that each download installs, updates and uninstalls itself, makes a GitHub release and lists it on Jace Store. Bump `APP_VERSION` in `app/jace_social_app/__init__.py` and add a `## X.Y.Z` section to `app/CHANGELOG.md` first.
- **Server and web app:** deployed by Vercel on every push to `main` (root directory `server`).

Both release workflows need the `JACE_STORE_TOKEN` repository secret.
