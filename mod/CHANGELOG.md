# Jace Social mod changelog

## 1.5.3
- **Hosting uses [e4mc](https://modrinth.com/mod/e4mc) again.** e4all was removed from Modrinth, so launchers couldn't install it any more. Jace Launcher now installs e4mc with Jace Social. e4all still works if you have it (from github.com/Synquox/e4all).
- **Offline accounts:** Host world has an **Offline accounts** switch, like e4all's Online Mode button, so friends without a Minecraft account can join - with e4mc too. It's off unless you turn it on: with it on, anyone with the address can join under any name, and everyone gets the **Everyone else** role (nobody can take a friend's role by using their name).
- **No chat signing with Offline accounts on:** players' chat isn't signed in a world you host with Offline accounts, so friends with a Minecraft account and friends without one can chat together - no more "Invalid signature for profile public key" kicks.
- Minecraft starts without e4mc or e4all; Host world says what's missing.
- **Fixed:** opening the Friends menu again after closing it could crash the game ("Can only blur once per frame") on Minecraft 26.2 and newer.

## 1.5.2
- **Works with permission addons:** mods like [Vanilla Permissions](https://modrinth.com/mod/vanilla-permissions), WorldEdit and Essential Commands now follow Jace Social's permission groups in worlds you host, no LuckPerms needed. For example, allow `minecraft.command.gamemode` for the Builder group (Host world → Permissions) and builders can use /gamemode without being an operator.
- **NeoForge and Forge too:** mods that ask NeoForge's / Forge's permission API follow Jace Social's groups in worlds you host. Anything the groups don't mention works as before.
- The Permissions menu has an **Ideas** button that fills in common permissions for the addons you have installed.

## 1.5.1
- **Normal permissions when you host:** with **Allow Commands** on, Minecraft gives everyone who joins your world commands. Now only you and players on the ops list get them, like on a server. Give a friend commands with **/op name** (or the Admin group in Host world → Permissions), take them away with **/deop name**.
- **/op** and **/deop** work in worlds you host (Minecraft only has them on servers).

## 1.5.0
- **Voice channels and group calls:** join a server's voice channel (**Servers** → open a server → **Join**) or a group chat's call (**Voice** next to the group). Everyone's in one call together, like in the Jace Social app.
- **Camera and screen sharing:** in a call or a voice channel, **Camera** and **Share** send your camera or your screen to everyone else.
- A call bar at the bottom of the Friends and Servers screens: mute, deafen, camera, share, watch and leave. You get a notification when someone in your voice channel turns on their camera or shares their screen. **Watch** opens it in Jace Social.
- Needs Jace Launcher 1.4.0 or later (the voice runs there).

## 1.4.1
- **Camera and screen sharing in calls:** when the friend you're calling turns on their camera or shares their screen, you get a notification. Press **J**, then **Watch**, and the call moves to Jace Social, where you can see it. Needs Jace Launcher 1.3.2 or later.

## 1.4.0
- **Servers in game:** a new **Servers** button lists your Jace Social servers. Open one to see its channels by category, chat in text channels, and see who's in voice. Join a server by pasting an invite code or link.
- **Remove friends** from the friends list (click ✕, then **Sure?**).
- **Permissions without LuckPerms:** LuckPerms' Fabric version only runs on dedicated servers, so in singleplayer and in worlds you host the mod now has its own permission groups. They use the same menu and the same Visitor/Builder/Admin groups. On Fabric 26.1+, other mods like WorldEdit follow them too.
- Messages show @mentions by name and list attached files.
- Server channels only pop up a notification when you're @mentioned or replied to.
- Fixes the version shown in the game log (it always said 1.1.0).
- The jar files are now named like `jace_social_1.4.0+26.3-fabric.jar`. The mod itself is the same (its id is still `jacefriends`), so updates and your settings carry over.

## 1.3.0
- **Jace Friends is now the Jace Social mod.** It's part of [Jace Social](https://jace-social.vercel.app/), which also has a web app and a desktop app with the same friends.
- **Group chats:** they appear in your friends list. Chat in them, or start a new one with **New group**.
- Friends see your **status** (Idle, Do Not Disturb) and **custom status**.
- **Richer presence:** friends see your mod loader, world name and how long you've been playing.

## 1.2.0
- **LuckPerms menu** (Host world > LuckPerms…): edit each group's permissions and pick players' groups without typing commands. **Let me use /lp** gives you /lp access; a hosted world has no server console, so before this nobody could use /lp.
- **WorldEdit menu** (Host world > WorldEdit…): turn WorldEdit on for each player, and for Builders/Visitors who join later. This fixes "//wand" saying you don't have permission in newer Minecraft versions even with cheats on.
- The Admin role now really makes friends operators (singleplayer has no /op command, so it didn't before).

## 1.1.0
- **Every Minecraft release from 1.20.1 to 26.3,** on Fabric/Quilt, NeoForge (1.20.4 and up) and Forge (1.20.1).
- Friends list and chat in game (press **J**, or **Friends** on the title or pause screen), friend requests, and pop-up notifications. On 26.2 and newer, Minecraft's own **Friends** button opens Jace Friends.
- **Host world** button in the pause menu (and in **World Options** on 26.3). Friends click **Join** to play with you. Needs [e4all](https://modrinth.com/mod/e4all), which is now a required dependency.
- **Roles for hosted worlds:** make each friend a Visitor (look only), Builder or Admin (op), plus a role for everyone else. With LuckPerms installed, players are also put in `jace_visitor`, `jace_builder` and `jace_admin` groups for custom permissions.
- **Voice calls** with friends: **Call** on the friends list or in chat, and answer, mute or hang up in game. The audio runs in Jace Launcher, so calls need the game to be started from Jace Launcher.

## 1.0.0
- First release, for Minecraft 26.3 on Fabric.
