"""Signing in with the computer's Jace account on Jace OS.

Jace OS ships `jace-account`: `--json` says whether the computer is signed in to Jace, and
`--token-for <client_id>` trades the computer's Jace token for one issued to another official Jace
app (Jace's OAuth token exchange). When the app starts on Linux, isn't signed in, and the setting is
on (Settings -> Desktop app; on unless turned off), the sign-in page asks for this (the bridge's
signInJaceOS): we get a Jace token for Jace Social, the server checks it with Jace
(server/app/api/v1/auth/jace/os) and answers with a normal Jace Social session.

Anything that doesn't work (not Jace OS, not signed in there, Jace or the server unreachable, an
old Jace) just returns {} and the normal sign-in shows - never an error. Tokens are never logged.
Standard library only.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

TOOL = "jace-account"


def available() -> bool:
    """Is this Jace OS (Linux with jace-account on PATH)?"""
    return sys.platform.startswith("linux") and shutil.which(TOOL) is not None


def _host_env() -> dict:
    """The environment for a program of the computer's own: without what PyInstaller and the
    AppImage put in ours (their libraries would break the system's Python)."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("_PYI", "_MEI"))}
    for name in ("LD_LIBRARY_PATH", "LD_PRELOAD"):
        orig = env.pop(f"{name}_ORIG", None)
        if orig is not None:
            env[name] = orig
        elif getattr(sys, "frozen", False):
            env.pop(name, None)
    for name in ("PYTHONHOME", "PYTHONPATH", "QT_PLUGIN_PATH", "QML2_IMPORT_PATH"):
        env.pop(name, None)
    return env


def _tool(*args: str, timeout: float) -> dict:
    """Run jace-account, -> its JSON answer ({} if it failed in any way)."""
    try:
        r = subprocess.run([TOOL, *args], capture_output=True, text=True, timeout=timeout, env=_host_env())
        out = json.loads(r.stdout or "{}")
        return out if isinstance(out, dict) and r.returncode == 0 else {}
    except (OSError, subprocess.SubprocessError, ValueError):
        return {}


def _api(base: str, method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", "User-Agent": "JaceSocialDesktop"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read() or b"{}")
    except (urllib.error.URLError, OSError, ValueError):
        return {}


def sign_in(base: str) -> dict:
    """The computer's Jace account -> {"token": <Jace Social session>} (with the rest of the
    session), or {} when that can't be done (then the normal sign-in shows)."""
    if not available():
        return {}
    if not _tool("--json", timeout=10).get("signed_in"):
        return {}
    info = _api(base, "GET", "/api/v1/auth/jace/os")
    client_id = info.get("client_id")
    if not isinstance(client_id, str) or not client_id:
        return {}
    got = _tool("--token-for", client_id, "--scope", str(info.get("scope") or "profile messages"), timeout=30)
    access = got.get("access_token")
    if not isinstance(access, str) or not access:
        return {}
    session = _api(base, "POST", "/api/v1/auth/jace/os", {"access_token": access})
    return session if isinstance(session.get("token"), str) else {}
