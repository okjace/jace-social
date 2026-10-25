"""Jace Social desktop app: the Jace Social web app in its own window, plus Minecraft sign-in."""
import os
import sys
from pathlib import Path

APP_NAME = "Jace Social"
APP_VERSION = "1.0.14"
APP_RELEASE_DATE = "2026-10-09"
APP_ID = "io.github.jace_deb.JaceSocial"
AUTHOR = "jace.deb"
GITHUB_REPO = "okjace/jace-social"
GITHUB_URL = f"https://github.com/{GITHUB_REPO}"
WEBSITE = "https://jace-social.vercel.app/"
URL_SCHEME = "jacesocial"          # jacesocial://invite/<code> opens an invite in the app


def _data_dir() -> Path:
    """Your sign-in, settings and the install record. It lives outside the app folder,
    so updating, reinstalling or moving the app keeps it (JACE_SOCIAL_HOME overrides it)."""
    if os.environ.get("JACE_SOCIAL_HOME"):
        return Path(os.environ["JACE_SOCIAL_HOME"])
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "Jace Social"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Jace Social"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "jace-social"


DATA_DIR = _data_dir()
