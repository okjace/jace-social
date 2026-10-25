"""The overlay shortcut on Linux desktops that don't let apps set shortcuts themselves (no
GlobalShortcuts portal): Jace Social adds the key to the desktop's own config, set to run
`<this app> --overlay` (which toggles the overlay in the open copy, see app.py), and the desktop
reloads it.

  niri       ~/.config/niri/jace-social.kdl, included from config.kdl
  Hyprland   ~/.config/hypr/jace-social.conf, sourced from hyprland.conf
  Sway       ~/.config/sway/jace-social, included from its config
  COSMIC     its custom shortcuts file
  Wayfire    the [command] section of wayfire.ini
  labwc      a <keybind> in rc.xml
  GNOME      a custom shortcut (gsettings) - only when the portal isn't there (GNOME before 48)

GNOME 48+ and KDE use the portal instead (hotkeys.py), and X11 desktops XGrabKey. Everything we add is
marked "Jace Social", so changing or turning off the shortcut replaces or removes just that.
"""
from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

MARK = "Jace Social overlay"
HOME = Path.home()
CONFIG = Path(os.environ.get("XDG_CONFIG_HOME") or HOME / ".config")
PUNCT = {"-": "minus", "=": "equal", "[": "bracketleft", "]": "bracketright", ";": "semicolon", "'": "apostrophe",
         ",": "comma", ".": "period", "/": "slash", "\\": "backslash", "`": "grave"}
NAMES = {"space": "space", "tab": "Tab", "grave": "grave", "escape": "Escape"}


def kind() -> str | None:
    """Which desktop we add the key to ourselves, or None (the portal, X11, or one we don't know)."""
    if not sys.platform.startswith("linux"):
        return None
    desk = os.environ.get("XDG_CURRENT_DESKTOP", "").lower()
    if os.environ.get("NIRI_SOCKET") or "niri" in desk:
        return "niri"
    if os.environ.get("HYPRLAND_INSTANCE_SIGNATURE") or "hyprland" in desk:
        return "hyprland"
    if os.environ.get("SWAYSOCK") or "sway" in desk:
        return "sway"
    if "cosmic" in desk:
        return "cosmic"
    if os.environ.get("WAYFIRE_SOCKET") or "wayfire" in desk:
        return "wayfire"
    if os.environ.get("LABWC_PID") or "labwc" in desk:
        return "labwc"
    if "gnome" in desk and os.environ.get("WAYLAND_DISPLAY"):
        from jace_social_app import hotkeys
        if not hotkeys.portal_available() and shutil.which("gsettings"):
            return "gnome"
    return None


NICE = {"niri": "niri", "hyprland": "Hyprland", "sway": "Sway", "cosmic": "COSMIC", "wayfire": "Wayfire",
        "labwc": "labwc", "gnome": "GNOME"}


def command() -> list[str]:
    """What the desktop runs: this app with --overlay."""
    exe = os.environ.get("APPIMAGE")
    if exe:
        return [exe, "--overlay"]
    if getattr(sys, "frozen", False):
        return [sys.executable, "--overlay"]
    return [sys.executable, "-m", "jace_social_app", "--overlay"]


def keysym(key: str) -> str:
    """hotkeys.parse's key -> its X keysym name ("j", "F5", "space", "grave", "minus")."""
    if len(key) > 1 and key[0] == "f" and key[1:].isdigit():
        return key.upper()
    return NAMES.get(key) or PUNCT.get(key) or key.lower()


def pretty(mods: set[str], key: str) -> str:
    names = {"ctrl": "Ctrl", "shift": "Shift", "alt": "Alt", "meta": "Super"}
    return "+".join([names[m] for m in ("meta", "ctrl", "alt", "shift") if m in mods] + [key.upper() if len(key) == 1 else key.capitalize()])


def _write(path: Path, text: str) -> bool:
    """Write if it changed (so the desktop doesn't reload for nothing). True if it did."""
    try:
        if path.read_text() == text:
            return False
    except OSError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return True


def _ensure_line(config: Path, line: str):
    """Add a line (an include) to the user's config once, at the end, with a comment saying why."""
    text = config.read_text() if config.exists() else ""
    if line in text:
        return
    comment = "//" if config.suffix == ".kdl" else "#"
    _write(config, text + ("" if not text or text.endswith("\n") else "\n") + f"\n{comment} {MARK}\n{line}\n")


def _drop_line(config: Path, line: str):
    try:
        text = config.read_text()
    except OSError:
        return
    new = re.sub(rf"\n?(//|#) {re.escape(MARK)}\n{re.escape(line)}\n", "\n", text)
    if new != text:
        _write(config, new)


def _run(*cmd: str):
    from jace_social_app import updater
    try:
        subprocess.run(cmd, env=updater.clean_env(), timeout=10, capture_output=True)
    except (OSError, subprocess.SubprocessError):
        pass


# --- niri -----------------------------------------------------------------------------------
def _niri_conflict(mods: set[str], key: str) -> str | None:
    """Someone else's bind on these keys in the niri config: its file, or None."""
    want = {*({"meta": "super"}.get(m, m) for m in mods), keysym(key).lower()}
    for f in (CONFIG / "niri").rglob("*.kdl"):
        if f.name == "jace-social.kdl":
            continue
        try:
            lines = f.read_text().splitlines()
        except OSError:
            continue
        for ln in lines:
            m = re.match(r"\s*([A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*)\s.*\{", ln)
            if not m or "--overlay" in ln or ln.lstrip().startswith("//"):
                continue
            parts = {"super" if p.lower() in ("mod", "win") else "ctrl" if p.lower() == "control" else p.lower()
                     for p in m.group(1).split("+")}
            if parts == want:
                return str(f).replace(str(HOME), "~")
    return None


def _niri_bind(mods, key):
    conflict = _niri_conflict(mods, key)
    if conflict:
        raise RuntimeError(f"{pretty(mods, key)} is already used in niri ({conflict}) - pick other keys")
    names = {"ctrl": "Ctrl", "shift": "Shift", "alt": "Alt", "meta": "Super"}
    combo = "+".join([names[m] for m in ("meta", "ctrl", "alt", "shift") if m in mods] + [keysym(key).upper() if len(key) == 1 and key.isalpha() else keysym(key)])
    cmd = " ".join(f'"{a}"' for a in (x.replace("\\", "\\\\").replace('"', '\\"') for x in command()))
    changed = _write(CONFIG / "niri" / "jace-social.kdl",
                     f"// {MARK}: added by Jace Social, which changes or removes it (Settings -> Desktop app)\n"
                     f'binds {{\n    {combo} hotkey-overlay-title="{MARK}" {{ spawn {cmd}; }}\n}}\n')
    _ensure_line(CONFIG / "niri" / "config.kdl", 'include "jace-social.kdl"')
    if changed:
        _run("niri", "msg", "action", "load-config-file")


def _niri_unbind():
    _drop_line(CONFIG / "niri" / "config.kdl", 'include "jace-social.kdl"')
    (CONFIG / "niri" / "jace-social.kdl").unlink(missing_ok=True)
    _run("niri", "msg", "action", "load-config-file")


# --- Hyprland --------------------------------------------------------------------------------
def _hypr_bind(mods, key):
    names = {"ctrl": "CTRL", "shift": "SHIFT", "alt": "ALT", "meta": "SUPER"}
    m = " ".join(names[x] for x in ("meta", "ctrl", "alt", "shift") if x in mods)
    changed = _write(CONFIG / "hypr" / "jace-social.conf",
                     f"# {MARK}: added by Jace Social, which changes or removes it (Settings -> Desktop app)\n"
                     f"bind = {m}, {keysym(key)}, exec, {shlex.join(command())}\n")
    _ensure_line(CONFIG / "hypr" / "hyprland.conf", f"source = {CONFIG / 'hypr' / 'jace-social.conf'}")
    if changed:
        _run("hyprctl", "reload")


def _hypr_unbind():
    _drop_line(CONFIG / "hypr" / "hyprland.conf", f"source = {CONFIG / 'hypr' / 'jace-social.conf'}")
    (CONFIG / "hypr" / "jace-social.conf").unlink(missing_ok=True)
    _run("hyprctl", "reload")


# --- Sway ------------------------------------------------------------------------------------
def _sway_config() -> Path:
    for p in (CONFIG / "sway" / "config", HOME / ".sway" / "config"):
        if p.exists():
            return p
    raise RuntimeError("Sway uses its built-in config here - copy /etc/sway/config to ~/.config/sway/config first")


def _sway_bind(mods, key):
    config = _sway_config()
    names = {"ctrl": "Ctrl", "shift": "Shift", "alt": "Mod1", "meta": "Mod4"}
    combo = "+".join([names[x] for x in ("meta", "ctrl", "alt", "shift") if x in mods] + [keysym(key)])
    changed = _write(config.parent / "jace-social",
                     f"# {MARK}: added by Jace Social, which changes or removes it (Settings -> Desktop app)\n"
                     f"bindsym {combo} exec {shlex.join(command())}\n")
    _ensure_line(config, f"include {config.parent / 'jace-social'}")
    if changed:
        _run("swaymsg", "reload")


def _sway_unbind():
    try:
        config = _sway_config()
    except RuntimeError:
        return
    _drop_line(config, f"include {config.parent / 'jace-social'}")
    (config.parent / "jace-social").unlink(missing_ok=True)
    _run("swaymsg", "reload")


# --- COSMIC ----------------------------------------------------------------------------------
COSMIC = CONFIG / "cosmic" / "com.system76.CosmicSettings.Shortcuts" / "v1" / "custom"


def _cosmic_strip(text: str) -> str:
    return re.sub(rf"\n[ \t]*// {re.escape(MARK)}\n[^\n]*\n", "\n", text)


def _cosmic_bind(mods, key):
    names = {"ctrl": "Ctrl", "shift": "Shift", "alt": "Alt", "meta": "Super"}
    m = ", ".join(names[x] for x in ("meta", "ctrl", "alt", "shift") if x in mods)
    entry = f'    // {MARK}\n    (modifiers: [{m}], key: "{keysym(key)}"): Spawn("{shlex.join(command()).replace(chr(34), chr(92) + chr(34))}"),\n'
    text = _cosmic_strip(COSMIC.read_text()) if COSMIC.exists() else "{\n}\n"
    end = text.rstrip().rfind("}")
    if end < 0:
        raise RuntimeError("Couldn't read COSMIC's shortcuts file")
    body = text[:end].rstrip()
    sep = "" if body.endswith(("{", ",")) else ","
    _write(COSMIC, f"{body}{sep}\n{entry}}}\n")


def _cosmic_unbind():
    if COSMIC.exists():
        _write(COSMIC, _cosmic_strip(COSMIC.read_text()))


# --- Wayfire ---------------------------------------------------------------------------------
WAYFIRE = CONFIG / "wayfire.ini"


def _wayfire_strip(text: str) -> str:
    return re.sub(r"(?m)^(binding|command)_jace_social_overlay *=.*\n?", "", text)


def _wayfire_bind(mods, key):
    names = {"ctrl": "<ctrl>", "shift": "<shift>", "alt": "<alt>", "meta": "<super>"}
    evdev = {"`": "GRAVE", "-": "MINUS", "=": "EQUAL", "[": "LEFTBRACE", "]": "RIGHTBRACE", ";": "SEMICOLON",
             "'": "APOSTROPHE", ",": "COMMA", ".": "DOT", "/": "SLASH", "\\": "BACKSLASH"}
    k = "KEY_" + (evdev.get(key) or {"grave": "GRAVE", "escape": "ESC"}.get(key) or key.upper())
    combo = " ".join([names[x] for x in ("meta", "ctrl", "alt", "shift") if x in mods] + [k])
    lines = f"binding_jace_social_overlay = {combo}\ncommand_jace_social_overlay = {shlex.join(command())}\n"
    text = _wayfire_strip(WAYFIRE.read_text()) if WAYFIRE.exists() else ""
    if re.search(r"(?m)^\[command\]\s*$", text):
        text = re.sub(r"(?m)^\[command\]\s*\n", lambda m: m.group(0) + lines, text, count=1)
    else:
        text += ("" if not text or text.endswith("\n") else "\n") + "\n[command]\n" + lines
    _write(WAYFIRE, text)                                # Wayfire reloads wayfire.ini by itself


def _wayfire_unbind():
    if WAYFIRE.exists():
        _write(WAYFIRE, _wayfire_strip(WAYFIRE.read_text()))


# --- labwc -----------------------------------------------------------------------------------
LABWC = CONFIG / "labwc" / "rc.xml"


def _labwc_strip(text: str) -> str:
    return re.sub(rf"\s*<!-- {re.escape(MARK)} -->\s*<keybind [^>]*>.*?</keybind>", "", text, flags=re.S)


def _labwc_bind(mods, key):
    names = {"ctrl": "C-", "shift": "S-", "alt": "A-", "meta": "W-"}
    combo = "".join(names[x] for x in ("meta", "ctrl", "alt", "shift") if x in mods) + keysym(key)
    from xml.sax.saxutils import quoteattr
    bind = (f'\n    <!-- {MARK} -->\n    <keybind key="{combo}"><action name="Execute" command={quoteattr(shlex.join(command()))} /></keybind>')
    text = _labwc_strip(LABWC.read_text()) if LABWC.exists() else (
        '<?xml version="1.0"?>\n<labwc_config>\n  <keyboard>\n    <default />\n  </keyboard>\n</labwc_config>\n')
    if "</keyboard>" in text:                         # after <default /> and the user's own keys
        i = text.rfind("</keyboard>")
        text = text[:i].rstrip() + bind + "\n  " + text[i:]
    elif "</labwc_config>" in text:
        text = text.replace("</labwc_config>", f"  <keyboard>\n    <default />{bind}\n  </keyboard>\n</labwc_config>", 1)
    else:
        raise RuntimeError("Couldn't read labwc's rc.xml")
    if _write(LABWC, text):
        _run("labwc", "--reconfigure")


def _labwc_unbind():
    if LABWC.exists() and _write(LABWC, _labwc_strip(LABWC.read_text())):
        _run("labwc", "--reconfigure")


# --- GNOME (before 48) -----------------------------------------------------------------------
GNOME_LIST = "org.gnome.settings-daemon.plugins.media-keys"
GNOME_PATH = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/jace-social/"


def _gsettings(*args: str) -> str:
    from jace_social_app import updater
    r = subprocess.run(["gsettings", *args], env=updater.clean_env(), timeout=10, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"GNOME didn't take the shortcut ({r.stderr.strip() or r.returncode})")
    return r.stdout.strip()


def _gnome_paths() -> list[str]:
    raw = _gsettings("get", GNOME_LIST, "custom-keybindings")
    return re.findall(r"'([^']+)'", raw)


def _gnome_bind(mods, key):
    names = {"ctrl": "<Control>", "shift": "<Shift>", "alt": "<Alt>", "meta": "<Super>"}
    binding = "".join(names[x] for x in ("meta", "ctrl", "alt", "shift") if x in mods) + keysym(key)
    schema = f"{GNOME_LIST}.custom-keybinding:{GNOME_PATH}"
    _gsettings("set", schema, "name", MARK)
    _gsettings("set", schema, "command", shlex.join(command()))
    _gsettings("set", schema, "binding", binding)
    paths = _gnome_paths()
    if GNOME_PATH not in paths:
        _gsettings("set", GNOME_LIST, "custom-keybindings", str(paths + [GNOME_PATH]))


def _gnome_unbind():
    try:
        paths = _gnome_paths()
        if GNOME_PATH in paths:
            _gsettings("set", GNOME_LIST, "custom-keybindings", str([p for p in paths if p != GNOME_PATH]) if len(paths) > 1 else "@as []")
        _gsettings("reset-recursively", f"{GNOME_LIST}.custom-keybinding:{GNOME_PATH}")
    except (RuntimeError, OSError, subprocess.SubprocessError):
        pass


HANDLERS = {"niri": (_niri_bind, _niri_unbind), "hyprland": (_hypr_bind, _hypr_unbind), "sway": (_sway_bind, _sway_unbind),
            "cosmic": (_cosmic_bind, _cosmic_unbind), "wayfire": (_wayfire_bind, _wayfire_unbind),
            "labwc": (_labwc_bind, _labwc_unbind), "gnome": (_gnome_bind, _gnome_unbind)}


def bind(desk: str, mods: set[str], key: str) -> str:
    """Add (or change) the overlay key in this desktop's config. -> how to describe it. Raises RuntimeError."""
    try:
        HANDLERS[desk][0](mods, key)
    except RuntimeError:
        raise
    except Exception as e:  # noqa: BLE001 - a config we couldn't read or write
        raise RuntimeError(f"Couldn't add the shortcut to {NICE[desk]}'s settings ({e})") from e
    return pretty(mods, key)


def unbind(desk: str):
    """Take our key out of that desktop's config again."""
    try:
        HANDLERS[desk][1]()
    except Exception:  # noqa: BLE001 - best effort
        pass


def manual_hint() -> str:
    """For a desktop we don't know: what to bind by hand."""
    return ("Your desktop doesn't let apps set shortcuts. Add one in its keyboard settings that runs: "
            + shlex.join(command()))
