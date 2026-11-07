"""Signing in with the computer's Jace account on Jace OS.

Jace OS ships `jace-account`: `--json` says whether the computer is signed in to Jace, and
`--token-for <client_id>` trades the computer's Jace token for one issued to another official Jace
app (Jace's OAuth token exchange). Each time the sign-in page shows on Jace OS (and the setting is on:
Settings -> Desktop app), it asks "Sign in as @<you>?" with the computer's account (account()); on
yes (sign_in): we get a Jace token for Jace Social, the server checks it with Jace
(server/app/api/v1/auth/jace/os) and answers with a normal Jace Social session.

Not Jace OS, or not signed in there: no question, just the normal sign-in. After you said yes,
something failing comes back as {"error": "..."} saying which step. Tokens are never logged or
shown. Standard library only.
"""
from __future__ import annotations

import json
import os
import shutil
import ssl
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


def _tls() -> ssl.SSLContext:
    """Certificates to check Jace Social's with: the bundled certifi ones (the bundled OpenSSL looks
    for the system's in Ubuntu's folder, which Jace OS and other Linuxes don't have), plus the system's."""
    ctx = ssl.create_default_context()
    try:
        import certifi
        ctx.load_verify_locations(cafile=certifi.where())
    except (ImportError, OSError, ssl.SSLError):
        pass
    for path in ("/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/cert.pem", "/etc/pki/tls/certs/ca-bundle.crt"):
        if os.path.isfile(path):
            try:
                ctx.load_verify_locations(cafile=path)
                break
            except (OSError, ssl.SSLError):
                pass
    return ctx


def _api(base: str, method: str, path: str, body: dict | None = None) -> dict:
    """-> the JSON answer; {"error": ...} (the server's own words when it gave some) if it failed."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", "User-Agent": "JaceSocialDesktop"})
    try:
        with urllib.request.urlopen(req, timeout=20, context=_tls()) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            said = json.loads(e.read() or b"{}").get("error")
        except (ValueError, OSError):
            said = None
        return {"error": str(said) if said else f"Jace Social answered {e.code}"}
    except urllib.error.URLError as e:
        if isinstance(e.reason, ssl.SSLError):
            return {"error": "Couldn't check Jace Social's security certificate"}
        return {"error": "Can't reach Jace Social - check your internet connection"}
    except (OSError, ValueError):
        return {"error": "Can't reach Jace Social - check your internet connection"}


def account() -> dict:
    """The computer's Jace account: {"username", "name", "picture"}, or {} (not Jace OS / signed out)."""
    if not available():
        return {}
    acct = _tool("--json", timeout=10)
    user = acct.get("user") if acct.get("signed_in") else None
    if not isinstance(user, dict) or not user.get("username"):
        return {}
    return {"username": str(user["username"]), "name": str(user.get("display_name") or user.get("name") or user["username"]),
            "picture": user.get("picture") if isinstance(user.get("picture"), str) else None}


def sign_in(base: str) -> dict:
    """The computer's Jace account -> {"token": <Jace Social session>} (with the rest of the
    session), or {"error": what went wrong} (never with a token in it)."""
    if not available():
        return {"error": "This isn't Jace OS (there's no jace-account here)"}
    if not _tool("--json", timeout=10).get("signed_in"):
        return {"error": "This computer isn't signed in to Jace"}
    info = _api(base, "GET", "/api/v1/auth/jace/os")
    client_id = info.get("client_id")
    if not isinstance(client_id, str) or not client_id:
        return {"error": info.get("error") or "Jace Social can't take Jace OS sign-ins right now"}
    got = _tool("--token-for", client_id, "--scope", str(info.get("scope") or "profile messages"), timeout=30)
    access = got.get("access_token")
    if not isinstance(access, str) or not access:
        return {"error": "Jace didn't give this computer a sign-in for Jace Social - try Sign in with Jace instead"}
    session = _api(base, "POST", "/api/v1/auth/jace/os", {"access_token": access})
    if isinstance(session.get("token"), str):
        return session
    return {"error": session.get("error") or "Jace Social didn't accept the sign-in"}
