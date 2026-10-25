# Jace Social desktop app changelog

## 1.0.13
- **Overlay shortcut on niri** (and other desktops that don't let apps set shortcuts): bind a key in your desktop's own settings to run Jace Social with `--overlay`, which opens or closes the overlay. For niri, add this inside `binds { }` in `~/.config/niri/config.kdl`: `Mod+Shift+J { spawn "/path/to/JaceSocial.AppImage" "--overlay"; }`. Settings shows the exact line for your computer. Before, the app only said "The shortcut wasn't allowed".

## 1.0.12
- Fixes Jace Social not opening again after you quit it (seen on Linux) until you restarted the computer. Quitting sometimes got stuck partway, and opening the app again only asked the stuck copy to show itself. Quitting now always finishes, and if a stuck copy is ever left over, opening Jace Social closes it and starts fresh.
- Message and call sounds play reliably while the window is hidden in the tray or behind other windows. Before, the app slowed down in the background, lost its live connection now and then, and messages or calls that came in during that gap made no sound.

## 1.0.11
- **Overlay shortcut on Wayland** (GNOME, KDE): your desktop now owns the keys. Settings shows the keys it uses (like Ctrl+Shift+J); **Change keys…** opens your desktop's own window to pick others, and Jace Social follows when you do. Before, choosing different keys in Jace Social didn't reach the desktop, so the shortcut seemed not to work.

## 1.0.10
- Fixes an all-white window when you open Jace Social again after closing it, on desktops without a tray icon (like GNOME). Closing the window now keeps Jace Social running in the background there too, so messages still reach you; opening it again brings it back as it was.
- Notifications now show on desktops without a tray icon (GNOME), as normal desktop notifications.
- **Quit:** press Ctrl+Q (Cmd+Q on a Mac), or use **Quit Jace Social** in Settings.

## 1.0.9
- **Game overlay on Wayland** (GNOME 48+, KDE, e.g. CachyOS): the overlay shortcut now works there too. The first time, your desktop asks you to allow the shortcut (you can pick other keys in its dialog; Settings shows which ones it uses). Then the shortcut opens Jace Social in front of whatever you're doing, games included.

## 1.0.8
- Linux: fixes a blank window on some graphics drivers (seen with new Intel graphics on GNOME/Wayland, e.g. CachyOS). The app notices, switches that computer to drawing the page in software, and restarts once by itself.
- Linux: fixes Jace Social showing up twice in the app menu ("Jace Social" and "Jace Social (1)") when AppImageLauncher is installed. The AppImage now tells AppImageLauncher to leave it alone, and the extra entry (and its icon) is removed the next time the app starts.

## 1.0.7
- **Reload:** press F5 or Ctrl+R (Cmd+R on a Mac), or pick **Reload** in the tray menu, to load the newest Jace Social without quitting.
- Jace Social also tells you when a new version of it is live ("Jace Social was updated - Reload"), so the app doesn't stay on an old one while it sits in the tray.

## 1.0.6
- macOS: fixes the app closing when you set the overlay shortcut. It now uses macOS's own keyboard shortcuts, so it also no longer needs Accessibility permission.

## 1.0.5
- **Game overlay:** pick a keyboard shortcut in Settings (for example Ctrl+Shift+J) and press it in a game: Jace Social pops up on top, small, on the side of the screen. Press it again (or Esc) to hide it. It's the same Jace Social as the main window, so calls and voice keep going. Drag its top bar to move it; it remembers where. Works over games in windowed or borderless mode (not exclusive fullscreen). On Linux it needs X11 (games through XWayland and Proton work too).
- **Open on startup** is now a switch in Settings: turn starting Jace Social when you sign in to your computer on or off any time.
- The tray menu has **Show overlay**.

## 1.0.4
- **Updates like Jace Launcher:** the app checks for a new version a few seconds after it starts (and every few hours while it's open in the tray), then asks **Update now** or **Later** and shows what's new. It asks once per version; the green **Update** button stays in the sidebar until you update.
- **Check for updates on startup** can be turned off in Settings, next to **Check for updates**.

## 1.0.3
- Fixes "no permission" when turning on your camera in a call or voice channel.
- Screen sharing works in the app: pick your whole screen or one window to share.
- macOS asks for camera access the first time you turn your camera on.

## 1.0.2
- Fixes Sign in with Minecraft showing a blank white window.
- Invite links open in the app: on an invite page, click **Open in the desktop app**.
- Everything new in Jace Social shows up in the app too: servers with roles, voice channels, screen sharing, bots, themes and more. Those come from the web app, so they work right away.

## 1.0.1
- Linux: fixes the app not starting on newer distros ("Could not initialize GLX"). The AppImage now uses your system's own graphics, GTK and GLib libraries instead of older copies, and is 25 MB smaller.

## 1.0.0
- First release: Jace Social in its own window - friends, direct messages, group chats and servers.
- Sign in with Jace or with Minecraft (Microsoft), and link the other one any time.
- Notifications and a tray icon, so messages reach you while the window is closed. It can start when you sign in to your computer.
- Voice calls with friends, whether they use the app, the web, or Jace Launcher.
- Every download is the app itself: open it once and a short setup installs it (Windows, macOS and Linux), adds shortcuts, starts the installed copy and removes the download.
- One-click updates: an **Update** button appears when a new version is out (also in Settings and the tray menu).
- Settings → Delete Jace Social removes the app, and optionally your sign-in on this computer.
