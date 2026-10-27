"""Publish a desktop app (app-v*) or phone app (mobile-v*) GitHub release to Jace Store as download links.

    python packaging/publish_app.py app-v1.0.0 [--dry-run]
    python packaging/publish_app.py mobile-v1.0.0 [--dry-run]

Files stay on GitHub; the store lists them as direct downloads. The changelog
comes from app/CHANGELOG.md (mobile/CHANGELOG.md). Needs Node and JACE_STORE_TOKEN. If the Jace Store
project doesn't exist yet, it's skipped with a warning.
"""
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "packaging" / "jace-store.mjs"
REPO = "okjace/jace-social"
KINDS = {   # tag prefix: (Jace Store project, changelog, title, files)
    "app-v": ("jace-social-desktop", "app/CHANGELOG.md", "Jace Social", [
        # (file ending, label, Jace Store platform); this order is the order on the store
        ("-windows-x64.exe", "Windows", "windows"),
        ("-macos-arm64.app.zip", "macOS (Apple Silicon)", "macos"),
        ("-macos-x86_64.app.zip", "macOS (Intel)", "macos"),
        ("-x86_64.AppImage", "Linux", "linux"),
    ]),
    "mobile-v": ("jace-social-mobile", "mobile/CHANGELOG.md", "Jace Social Mobile", [
        ("-android.apk", "Android", "android"),
        ("-ios-unsigned.ipa", "iPhone (sideload)", "ios"),
        ("-ios12-unsigned.ipa", "iPhone, iOS 12 to 15 (sideload)", "ios"),
    ]),
}


def main():
    tag = sys.argv[1]
    dry = "--dry-run" in sys.argv
    prefix = next((p for p in KINDS if tag.startswith(p)), None)
    if not prefix:
        sys.exit(f"{tag}: expected app-v* or mobile-v*")
    SLUG, changelog_file, title, FILES = KINDS[prefix]
    version = tag.removeprefix(prefix)
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "jace-social-publish"}
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:       # signed in, GitHub's limit is per repo instead of per (shared) runner address
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/releases/tags/{tag}", headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        assets = json.load(r).get("assets", [])
    found = [(a, label, plat) for end, label, plat in FILES for a in assets if a["name"].endswith(end)]
    links = [f"{a['browser_download_url']}|{label}" for a, label, _ in found]
    platforms = ",".join(dict.fromkeys(plat for _, _, plat in found))
    if not links:
        sys.exit(f"{tag}: no downloads in the GitHub release")
    text = (ROOT / changelog_file).read_text(encoding="utf-8")
    m = re.search(rf"^## {re.escape(version)}\s*\n(.*?)(?=^## |\Z)", text, re.S | re.M)
    changelog = m.group(1).strip() if m else f"https://github.com/{REPO}/releases/tag/{tag}"

    res = subprocess.run(["node", str(CLI), "project", SLUG, "--json"], capture_output=True, text=True)
    if res.returncode != 0:
        why = (res.stderr or res.stdout).strip()
        if "not found" in why.lower() or "404" in why:
            print(f"::warning::Jace Store project '{SLUG}' not found - create it first. Skipping.")
            return
        sys.exit(f"Couldn't reach Jace Store: {why[:500]}")      # fail the step, so it shows and can be run again
    if version in {v["version_number"] for v in json.loads(res.stdout).get("versions", [])}:
        print(f"{version} is already on Jace Store")
        return
    cmd = ["node", str(CLI), "publish", SLUG, "--version", version, "--name", f"{title} {version}",
           "--changelog", changelog, "--loaders", platforms, "--primary-link", "--json"]
    for link in links:
        cmd += ["--link", link]
    print(" ".join(cmd[:8]), f"... {len(links)} downloads")
    if not dry:
        subprocess.run(cmd, check=True)


if __name__ == "__main__":
    main()
