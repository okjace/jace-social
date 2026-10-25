"""Installing Jace Social: the Linux AppImage here, Windows in wininstall.py, macOS in
macinstall.py.

Every download is the app itself. The first time it runs, a setup wizard installs
it (see installer.py), starts the installed copy and deletes the download.

Linux: copies the AppImage to a folder of your choice (~/Applications by default)
and adds a menu entry, a desktop shortcut, a terminal command, AppStream info (what
GNOME Software and KDE Discover read to describe apps) and a login item.

From a terminal:
    ./JaceSocial-x86_64.AppImage --install          # opens the setup wizard
    ./JaceSocial-x86_64.AppImage --install --yes    # install with defaults, no questions
    ./JaceSocial-x86_64.AppImage --uninstall [--purge]
"""
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from jace_social_app import APP_ID, APP_NAME, APP_RELEASE_DATE, APP_VERSION, AUTHOR, DATA_DIR, URL_SCHEME, WEBSITE, macinstall, wininstall

ASSETS = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent)) / "assets"
ICON_SRC = ASSETS / "icon.png"
APPIMAGE_NAME = "JaceSocial.AppImage"

HOME = Path.home()
DEFAULT_DIR = HOME / "Applications"
DATA_HOME = Path(os.environ.get("XDG_DATA_HOME") or HOME / ".local" / "share")
CONFIG_HOME = Path(os.environ.get("XDG_CONFIG_HOME") or HOME / ".config")
MENU_FILE = DATA_HOME / "applications" / f"{APP_ID}.desktop"
ICON_FILE = DATA_HOME / "icons" / "hicolor" / "256x256" / "apps" / f"{APP_ID}.png"
METAINFO_FILE = DATA_HOME / "metainfo" / f"{APP_ID}.metainfo.xml"
AUTOSTART_FILE = CONFIG_HOME / "autostart" / f"{APP_ID}.desktop"
BIN_LINK = HOME / ".local" / "bin" / "jace-social"
RECORD = DATA_DIR / "install.json"


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    os.replace(tmp, path)


def desktop_dir() -> Path:
    """The user's Desktop folder (localised names like ~/Escritorio included)."""
    try:
        out = subprocess.run(["xdg-user-dir", "DESKTOP"], capture_output=True, text=True, timeout=5).stdout.strip()
        if out and Path(out) != HOME:
            return Path(out)
    except (OSError, subprocess.SubprocessError):
        pass
    return HOME / "Desktop"


def desktop_shortcut() -> Path:
    return desktop_dir() / f"{APP_ID}.desktop"


def running_appimage() -> Path | None:
    p = os.environ.get("APPIMAGE")
    return Path(p) if p and Path(p).is_file() else None


def install_record() -> dict:
    return read_json(RECORD, {})


def installed_path() -> Path | None:
    p = install_record().get("path")
    return Path(p) if p and Path(p).exists() else None   # a file (AppImage / .exe) or a .app folder


def is_installed() -> bool:
    return installed_path() is not None


def running_package() -> Path | None:
    """The self-installable thing we're running from: an AppImage, a macOS .app or a Windows .exe."""
    return running_appimage() or macinstall.running_bundle() or wininstall.running_exe()


def running_installed_copy() -> bool:
    if wininstall.running_exe():
        return not wininstall.is_setup_build()     # the setup .exe is only ever the download
    src, dst = running_package(), installed_path()
    return bool(src and dst and src.resolve() == dst.resolve())


def setup_available() -> bool:
    return running_package() is not None


def frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def default_install_dir() -> Path:
    if wininstall.running_exe():
        return wininstall.default_dir()
    return macinstall.default_dir() if macinstall.running_bundle() else DEFAULT_DIR


def install_options() -> list[tuple[str, str, bool]]:
    """(key, label, checked by default) for the wizard's checkboxes."""
    if wininstall.running_exe():
        return wininstall.OPTIONS
    if macinstall.running_bundle():
        return macinstall.OPTIONS
    return [("menu", "Add to the applications menu", True),
            ("desktop", f"Create a desktop shortcut  ({desktop_dir()})", True),
            ("startup", "Start Jace Social when I log in (in the tray)", True),
            ("terminal", "Add the  jace-social  terminal command", True),
            ("appstream", "Show in GNOME Software, KDE Discover and other app centers", True)]


PART_DESCRIPTIONS = {
    "menu": "Added to your applications menu",
    "applications": "Added to Launchpad and Spotlight",
    "desktop": "Desktop shortcut created",
    "dock": "Added to the Dock",
    "startup": "Starts when you sign in to your computer",
    "terminal": "Run  jace-social  from a terminal",
    "appstream": "App center info registered",
    "unquarantine": "Removed the downloaded-from-internet flag",
    "startmenu": "Added to the Start menu",
    "apps": "Listed in Windows \"Installed apps\"",
}


def ask_running_copy_to_quit(status=print):
    """An installed copy that's open would lock its files (Windows) or keep running the
    old version, so ask it to quit first (it listens on a local socket, see app.py)."""
    from PySide6.QtCore import QCoreApplication, QElapsedTimer
    from PySide6.QtNetwork import QLocalSocket
    if QCoreApplication.instance() is None:
        ask_running_copy_to_quit.app = QCoreApplication([])     # QLocalSocket needs one
    s = QLocalSocket()
    s.connectToServer(SINGLE_INSTANCE_KEY)
    if not s.waitForConnected(500):
        return
    status("Closing the Jace Social that's open")
    s.write(b"quit")
    s.waitForBytesWritten(1000)
    s.disconnectFromServer()
    clock = QElapsedTimer()
    clock.start()
    while clock.elapsed() < 15_000:
        probe = QLocalSocket()
        probe.connectToServer(SINGLE_INSTANCE_KEY)
        if not probe.waitForConnected(300):
            break
        probe.abort()
        QCoreApplication.processEvents()
        time.sleep(0.3)
    else:
        raise RuntimeError("Jace Social is still open - quit it (right-click its tray icon → Quit) and try again")
    if sys.platform == "win32":
        time.sleep(1.5)                     # let Windows release its files


def startup_enabled() -> bool | None:
    """Does the app open when you sign in to your computer? None when it isn't installed."""
    path = installed_path()
    if not path:
        return None
    if sys.platform == "win32":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, wininstall.RUN_KEY) as k:
                winreg.QueryValueEx(k, APP_NAME)
            return True
        except OSError:
            return False
    if sys.platform == "darwin":
        return macinstall.LAUNCH_AGENT.exists()
    return AUTOSTART_FILE.exists()


def set_startup(on: bool):
    """Open (hidden in the tray) when you sign in, or stop doing that."""
    path = installed_path()
    if not path:
        raise RuntimeError("Install Jace Social first (open the download and finish setup)")
    if sys.platform == "win32":
        wininstall._set_startup(path if on else None)
    elif sys.platform == "darwin":
        macinstall._set_startup(path if on else None)
    elif on:
        _write(AUTOSTART_FILE, _desktop_entry(path, " --hidden").split("Actions=")[0])
    else:
        AUTOSTART_FILE.unlink(missing_ok=True)
    rec = install_record()
    parts = [p for p in rec.get("parts", []) if p != "startup"] + (["startup"] if on else [])
    write_json(RECORD, {**rec, "parts": parts})


SINGLE_INSTANCE_KEY = "jace-social-desktop"


def install_app(target_dir: Path, options: dict, status=print) -> Path:
    """Install on whichever platform we're running; returns the installed path."""
    ask_running_copy_to_quit(status)
    if wininstall.running_exe() or macinstall.running_bundle():
        mod = wininstall if wininstall.running_exe() else macinstall
        path, parts = mod.install(target_dir, options, status)
        write_json(RECORD, {"path": str(path), "version": APP_VERSION, "parts": parts})
        return path
    return install(target_dir, status=status, **{k: bool(options.get(k)) for k, _, _ in install_options()})


def _desktop_entry(exe: Path, args: str = "") -> str:
    return ("[Desktop Entry]\n"
            "Type=Application\n"
            f"Name={APP_NAME}\n"
            "GenericName=Chat\n"
            "Comment=Friends, chat, servers and voice calls, with Minecraft built in\n"
            f"Exec=\"{exe}\"{args} %U\n"
            f"Icon={APP_ID}\n"
            "Terminal=false\n"
            "Categories=Network;Chat;InstantMessaging;\n"
            f"MimeType=x-scheme-handler/{URL_SCHEME};\n"
            "Keywords=minecraft;friends;chat;voice;call;servers;\n"
            f"StartupWMClass={APP_ID}\n"
            "Actions=uninstall;\n\n"
            "[Desktop Action uninstall]\n"
            f"Name=Uninstall {APP_NAME}\n"
            f"Exec=\"{exe}\" --uninstall-gui\n")


def metainfo() -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>{APP_ID}</id>
  <name>{APP_NAME}</name>
  <summary>Friends, chat, servers and voice calls, with Minecraft built in</summary>
  <developer id="io.github.okjace"><name>{AUTHOR}</name></developer>
  <url type="homepage">{WEBSITE}</url>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>
  <description>
    <p>Jace Social keeps you in touch with your friends, on your desktop, in the browser,
       in Jace Launcher and inside Minecraft.</p>
    <ul>
      <li>Friends with online status and what they're playing</li>
      <li>Direct messages, group chats and servers with text channels</li>
      <li>Voice calls</li>
      <li>Sign in with Jace or with Minecraft</li>
    </ul>
  </description>
  <launchable type="desktop-id">{APP_ID}.desktop</launchable>
  <icon type="stock">{APP_ID}</icon>
  <categories><category>Network</category><category>Chat</category></categories>
  <keywords><keyword>minecraft</keyword><keyword>chat</keyword><keyword>friends</keyword></keywords>
  <content_rating type="oars-1.1"/>
  <releases><release version="{APP_VERSION}" date="{APP_RELEASE_DATE}"/></releases>
</component>
"""


def _register_links():
    """jacesocial:// links (from invite pages) open in this app."""
    if shutil.which("xdg-mime"):
        subprocess.run(["xdg-mime", "default", MENU_FILE.name, f"x-scheme-handler/{URL_SCHEME}"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def remove_duplicate_entries(appimage: Path | None = None) -> int:
    """Remove menu entries other tools made for our AppImage. AppImageLauncher (installed on
    many systems) watches ~/Applications and adds its own appimagekit_<hash>-Jace_Social.desktop,
    which showed up as a second "Jace Social (1)" next to ours. The AppImage now says
    X-AppImage-Integrate=false so that stops (see packaging/build_appimage.sh); this cleans up
    entries it made before. Other apps' entries are left alone. Never raises; returns how many."""
    try:
        paths = {str(p) for p in (appimage, installed_path(), running_appimage(), os.environ.get("APPIMAGE")) if p}
        apps = DATA_HOME / "applications"
        entries = sorted(apps.glob("appimagekit_*.desktop")) if apps.is_dir() else []
    except OSError:
        return 0
    removed = 0
    for f in entries:
        try:
            lines = f.read_text(errors="replace").splitlines()
        except OSError:
            continue
        runs = [ln.split("=", 1)[1] for ln in lines if ln.startswith(("Exec=", "TryExec="))]
        ours = any(p in r for p in paths for r in runs) or any(APP_ID in ln for ln in lines)
        if not ours:
            continue
        ident = next((ln.split("=", 1)[1].strip() for ln in lines if ln.startswith("X-AppImage-Identifier=")), "")
        try:
            f.unlink(missing_ok=True)
            removed += 1
        except OSError:
            continue
        if ident:                                  # its copies of our icon
            try:
                for icon in (DATA_HOME / "icons").rglob(f"appimagekit_{ident}_*"):
                    try:
                        icon.unlink(missing_ok=True)
                    except OSError:
                        pass
            except OSError:
                pass
    if removed:
        try:
            _refresh_menus()
        except OSError:
            pass
    return removed


def _refresh_menus():
    for cmd in (["update-desktop-database", str(MENU_FILE.parent)],
                ["gtk-update-icon-cache", "-q", "-t", str(DATA_HOME / "icons" / "hicolor")]):
        if shutil.which(cmd[0]):
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def _write(path: Path, text: str, executable=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    if executable:
        os.chmod(path, 0o755)


def install(target_dir: Path = DEFAULT_DIR, menu=True, desktop=True, startup=True, terminal=True, appstream=True,
            status=print) -> Path:
    src = running_appimage()
    if not src:
        raise RuntimeError("Not running from an AppImage - build one with packaging/build_appimage.sh")
    target_dir = Path(target_dir).expanduser()
    target_dir.mkdir(parents=True, exist_ok=True)
    exe = target_dir / APPIMAGE_NAME

    old = installed_path()
    status(f"Copying Jace Social to {target_dir}")
    if src.resolve() != exe.resolve():
        tmp = exe.with_name(exe.name + ".tmp")
        shutil.copy2(src, tmp)
        os.chmod(tmp, 0o755)
        os.replace(tmp, exe)
    if old and old.resolve() != exe.resolve() and old.resolve() != src.resolve():
        old.unlink(missing_ok=True)   # moved to a new location

    ICON_FILE.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ICON_SRC, ICON_FILE)
    entry = _desktop_entry(exe)
    done = []

    for p in (MENU_FILE, desktop_shortcut(), AUTOSTART_FILE, BIN_LINK, METAINFO_FILE):
        if p.is_symlink() or p.exists():
            p.unlink()

    if menu:
        status("Adding to the applications menu")
        _write(MENU_FILE, entry, executable=True)
        done.append("menu")
    if desktop:
        status("Creating desktop shortcut")
        sc = desktop_shortcut()
        _write(sc, entry, executable=True)
        # GNOME (Desktop Icons NG) only launches desktop files marked as trusted
        if shutil.which("gio"):
            subprocess.run(["gio", "set", str(sc), "metadata::trusted", "true"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        done.append("desktop")
    if startup:
        status("Starting Jace Social when you log in")
        _write(AUTOSTART_FILE, _desktop_entry(exe, " --hidden").split("Actions=")[0])
        done.append("startup")
    if terminal:
        status("Adding the 'jace-social' command")
        BIN_LINK.parent.mkdir(parents=True, exist_ok=True)
        BIN_LINK.symlink_to(exe)
        done.append("terminal")
    if appstream:
        status("Registering with software centers")
        _write(METAINFO_FILE, metainfo())
        done.append("appstream")

    _refresh_menus()
    if menu:
        _register_links()
    write_json(RECORD, {"path": str(exe), "version": APP_VERSION, "parts": done})
    remove_duplicate_entries(exe)
    status("Done")
    return exe


def uninstall(delete_running=False):
    """Remove the installed AppImage, menu entry and shortcuts.
    delete_running also deletes the AppImage file we're running from (e.g. the download)."""
    exe = installed_path()
    running = running_appimage() if delete_running else None
    remove_duplicate_entries(exe)                  # before the AppImage goes, while we can still match it
    for p in (MENU_FILE, desktop_shortcut(), AUTOSTART_FILE, ICON_FILE, BIN_LINK, METAINFO_FILE, exe, running):
        if p and (p.is_symlink() or p.exists()):
            p.unlink()
    RECORD.unlink(missing_ok=True)
    _refresh_menus()


# --- every platform -------------------------------------------------------------------

def windows_install_dir() -> Path | None:
    """Folder of the installed Windows app (or of the copy we're running, if it's not
    the downloaded setup .exe)."""
    exe = installed_path()
    if exe and exe.suffix.lower() == ".exe":
        return exe.parent
    run = wininstall.running_exe()
    return run.parent if run and not wininstall.is_setup_build() else None


def _mac_apps_to_delete() -> list[Path]:
    """The installed .app plus the copy we're running from, if that's a separate
    deletable copy (not a read-only disk image or Gatekeeper's translocated copy)."""
    apps = []
    for app in (installed_path(), macinstall.running_bundle()):
        if (app and app.suffix == ".app" and app not in apps and not macinstall.translocated(app)
                and not str(app).startswith("/Volumes/")):
            apps.append(app)
    return apps


def removal_summary() -> list[str]:
    """Human-readable list of what delete_app() will remove on this platform."""
    if wininstall.running_exe():
        items = []
        d = windows_install_dir()
        if d:
            items.append(f"the app in {d}")
        if wininstall.is_setup_build():
            items.append(f"this downloaded file ({wininstall.running_exe()})")
        return items + ["Start menu entry, desktop shortcut, startup entry, terminal command and the "
                        "Installed apps entry"]
    if macinstall.running_bundle():
        return [str(a) for a in _mac_apps_to_delete()] + ["Dock icon, desktop shortcut, login item and Terminal command"]
    items = []
    installed, running = installed_path(), running_appimage()
    if installed:
        items.append(f"the app at {installed}")
    if running and (not installed or running.resolve() != installed.resolve()):
        items.append(f"this AppImage file ({running})")
    items.append("menu entry, desktop shortcut, login item and terminal command")
    if not installed and not running and not frozen():
        items.append("(running from source: the source folder itself is left alone)")
    return items


def _remove_data(after_exit: bool):
    """Delete your sign-in and settings. The open app still uses some of those files,
    so from inside the app it finishes a moment after quitting."""
    if not after_exit:
        shutil.rmtree(DATA_DIR, ignore_errors=True)
    elif sys.platform == "win32":
        wininstall.after_exit(f'rmdir /s /q "{DATA_DIR}"')
    else:
        macinstall.remove_after_exit(DATA_DIR)


def delete_app(remove_data=False, after_exit=True):
    """Delete Jace Social on any platform. From the app, call it right before quitting:
    on Windows and macOS the actual removal finishes once this process exits."""
    if wininstall.running_exe():
        wininstall.uninstall(windows_install_dir())
        RECORD.unlink(missing_ok=True)
    elif macinstall.running_bundle():
        apps = _mac_apps_to_delete()
        macinstall.uninstall(apps[0] if apps else None)
        for extra in apps[1:]:
            macinstall.uninstall(extra)
        RECORD.unlink(missing_ok=True)
    else:
        from jace_social_app import desktopkeys
        for desk in desktopkeys.HANDLERS:          # the overlay key we added to a desktop's config
            if desk != "gnome" or desktopkeys.kind() == "gnome":
                desktopkeys.unbind(desk)
        uninstall(delete_running=True)
    if remove_data:
        _remove_data(after_exit)


def apply_windows_update(argv, status):
    """Run by the newly downloaded setup .exe: wait for the old app to quit, install
    over it with the same options as before, then start the updated app."""
    target = Path(argv[argv.index("--apply-update") + 1])
    if "--wait-pid" in argv:
        status("Waiting for Jace Social to close…")
        wininstall.wait_for_pid(int(argv[argv.index("--wait-pid") + 1]))
    parts = install_record().get("parts") or [k for k, _, d in wininstall.OPTIONS if d]
    exe = install_app(target, {k: True for k in parts}, status)
    if "--no-relaunch" not in argv:
        wininstall.relaunch(exe)
    return exe


HELP = f"""{APP_NAME} {APP_VERSION}
  --install            open the setup wizard
  --install --yes      install with the default options, no questions
  --uninstall          remove the app, its shortcuts and menu entries
  --uninstall --purge  also delete your sign-in and settings
  --hidden             start in the tray without opening the window
  --overlay            open or close the overlay (bind it to a key in desktops like niri)
  --help               show this"""


def handle_cli(argv) -> bool:
    """Handle the flags that don't need a window. Returns True if the app should exit."""
    if "--install" in argv and ("--yes" in argv or "-y" in argv):
        exe = install_app(default_install_dir(), {k: d for k, _, d in install_options()})
        print(f"Installed to {exe}")
        return True
    if "--update" in argv and ("--yes" in argv or "-y" in argv):
        from jace_social_app import updater
        updater.cli(argv)
        return True
    if "--apply-update" in argv and "--no-gui" in argv:
        apply_windows_update(argv, print)
        return True
    if "--uninstall" in argv:
        delete_app(remove_data="--purge" in argv, after_exit=False)
        print("Jace Social removed." + ("" if "--purge" in argv else
              " Your sign-in and settings were kept (add --purge to delete them too)."))
        return True
    if "--help" in argv or "-h" in argv:
        print(HELP)
        return True
    return False
