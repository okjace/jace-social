"""One-click updates from GitHub Releases.

check()  -> info about a newer release (or None)
apply()  -> downloads the right file for this platform and arranges for it to
            replace the running app; the caller must quit right afterwards.

  Linux    the AppImage file is replaced in place, then restarted once we've quit
  macOS    the new .app is unzipped, swapped in once we quit, then opened
  Windows  the new .exe is started with --apply-update; once we quit it installs
           itself over the old app with the same options and starts it
"""
import os
import platform
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import requests

from jace_social_app import APP_VERSION, GITHUB_REPO, GITHUB_URL, desktop, macinstall

RELEASES = f"{GITHUB_URL}/releases"
TAG_PREFIX = "app-v"          # the repo also has mod releases; desktop app tags look like app-v1.2.3


def current_version() -> str:
    # JACE_FAKE_VERSION lets CI test the update flow against a real release
    return os.environ.get("JACE_FAKE_VERSION") or APP_VERSION


def parse_version(v: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3])


def asset_suffix() -> str | None:
    if sys.platform == "win32":
        return "-windows-x64.exe"
    if sys.platform == "darwin":
        return f"-macos-{'arm64' if platform.machine() == 'arm64' else 'x86_64'}.app.zip"
    if sys.platform.startswith("linux"):
        return "-x86_64.AppImage"
    return None


def update_target() -> Path | None:
    """What gets replaced: the installed copy, else the package we're running from."""
    if not desktop.frozen():
        return None
    target = desktop.installed_path() or desktop.running_package()
    if target and sys.platform == "darwin" and macinstall.translocated(target):
        return None
    return target


def unsupported_reason() -> str | None:
    if not desktop.frozen():
        return "You're running from source - update with  git pull."
    if asset_suffix() is None:
        return "Updates aren't available for this platform."
    target = update_target()
    if target is None:
        return "Install Jace Social first (open the download and finish setup), then update."
    if not os.access(target.parent, os.W_OK):
        return f"Can't write to {target.parent}."
    return None


def _headers() -> dict:
    h = {"Accept": "application/vnd.github+json", "User-Agent": f"JaceSocialDesktop/{APP_VERSION}"}
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _latest_release() -> dict | None:
    """The newest desktop app release. The GitHub API allows only 60 anonymous requests
    an hour per IP address (shared networks hit that), so if it refuses, read the tag
    from github.com's /releases/latest redirect and build the download link from the
    release file naming instead."""
    try:
        r = requests.get(f"https://api.github.com/repos/{GITHUB_REPO}/releases", params={"per_page": 30},
                         headers=_headers(), timeout=20)
        r.raise_for_status()
        apps = [rel for rel in r.json() if rel.get("tag_name", "").startswith(TAG_PREFIX)
                and not rel.get("draft") and not rel.get("prerelease")]
        return max(apps, key=lambda rel: parse_version(rel["tag_name"]), default=None)
    except (requests.RequestException, ValueError):
        r = requests.head(f"https://github.com/{GITHUB_REPO}/releases/latest", allow_redirects=True, timeout=20)
        tag = r.url.rstrip("/").rsplit("/", 1)[-1]
        if not tag.startswith(TAG_PREFIX):
            raise
        ver = tag[len(TAG_PREFIX):]
        name = f"JaceSocial-{ver}{asset_suffix() or ''}"
        return {"tag_name": tag, "body": "", "html_url": f"https://github.com/{GITHUB_REPO}/releases/tag/{tag}",
                "assets": [{"name": name, "size": None,
                            "browser_download_url": f"https://github.com/{GITHUB_REPO}/releases/download/{tag}/{name}"}]}


def check() -> dict | None:
    """Return {version, notes, url, size, page} if a newer release exists, else None."""
    rel = _latest_release()
    latest = (rel or {}).get("tag_name", "")[len(TAG_PREFIX):]
    if not latest or parse_version(latest) <= parse_version(current_version()):
        return None
    suffix = asset_suffix()
    asset = next((a for a in rel.get("assets", []) if suffix and a["name"].endswith(suffix)), None)
    return {"version": latest, "notes": rel.get("body") or "", "page": rel.get("html_url", ""),
            "url": asset and asset["browser_download_url"], "size": asset and asset["size"]}


def clean_env() -> dict:
    """Environment for starting another copy of the app without PyInstaller's
    internal variables (otherwise the new copy thinks it's our child process)."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("_PYI", "_MEI"))}
    env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    env["APPIMAGELAUNCHER_DISABLE"] = "1"          # (see desktop.LAUNCH_ENV)
    return env


def download(url: str, dest: Path, progress=None) -> Path:
    with requests.get(url, stream=True, timeout=60, headers={"User-Agent": f"JaceSocialDesktop/{APP_VERSION}"}) as r:
        r.raise_for_status()
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(1 << 16):
                f.write(chunk)
                done += len(chunk)
                if progress:
                    progress(done, total)
    return dest


def cli(argv) -> None:
    """--update --yes [--no-relaunch]: update without the GUI (used by tests)."""
    reason = unsupported_reason()
    if reason:
        print(reason)
        sys.exit(1)
    info = check()
    if not info:
        print(f"Up to date ({current_version()})")
        return
    print(f"Updating {current_version()} -> {info['version']}")
    apply(info, print, relaunch="--no-relaunch" not in argv, extra_args=[a for a in ("--no-gui",) if a in argv])
    print("Update staged")


def apply(info: dict, status=print, progress=None, relaunch=True, extra_args=()) -> None:
    """Download and stage the update. The caller then quits the app."""
    reason = unsupported_reason()
    if reason:
        raise RuntimeError(reason)
    if not info.get("url"):
        raise RuntimeError("This release has no download for your computer.")
    target = update_target()
    status(f"Downloading Jace Social {info['version']}…")
    me = str(os.getpid())

    if sys.platform.startswith("linux"):
        new = target.with_name(target.name + ".new")
        download(info["url"], new, progress)
        new.chmod(0o755)
        os.replace(new, target)          # safe while running: the old file stays mounted
        if relaunch:                     # once we're gone, so the new copy isn't "already open"
            subprocess.Popen(["/bin/sh", "-c", 'while kill -0 "$0" 2>/dev/null; do sleep 0.3; done; exec "$1"',
                              me, str(target)], start_new_session=True, env=clean_env(),
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return

    work = Path(tempfile.mkdtemp(prefix="jace-social-update-"))
    if sys.platform == "darwin":
        archive = download(info["url"], work / "update.app.zip", progress)
        status("Unpacking…")
        subprocess.run(["ditto", "-x", "-k", str(archive), str(work / "new")], check=True)
        new_app = work / "new" / macinstall.BUNDLE
        # Copy next to the old app first (same volume), then swap with an instant rename,
        # so the app is never half-copied even if this is interrupted.
        script = ('while kill -0 "$0" 2>/dev/null; do sleep 0.5; done; '
                  'rm -rf "$1.new" && ditto "$2" "$1.new" && xattr -dr com.apple.quarantine "$1.new" '
                  '&& rm -rf "$1.old" && mv "$1" "$1.old" && mv "$1.new" "$1" && rm -rf "$1.old"'
                  + ('; open "$1"' if relaunch else ''))
        subprocess.Popen(["/bin/sh", "-c", script, me, str(target), str(new_app)],
                         start_new_session=True, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return

    # Windows: the new release .exe installs itself over the old one after we exit
    exe = download(info["url"], work / f"JaceSocial-{info['version']}-windows-x64.exe", progress)
    args = [str(exe), "--apply-update", str(target.parent), "--wait-pid", me, *extra_args]
    if not relaunch:
        args.append("--no-relaunch")
    subprocess.Popen(args, creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
                     close_fds=True, cwd=str(work), env=clean_env())
