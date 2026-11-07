"""Microsoft -> Xbox -> Minecraft sign-in, then proving the account to Jace Social.

The Minecraft token stays on this computer: Jace Social only asks Mojang whether we
"joined" its one-time server id (the same check a Minecraft server does).
"""
import time
import urllib.parse

import requests

# The public client the official launcher uses with the login.live.com desktop redirect
# (no Azure app registration needed). Same as Jace Launcher.
LIVE_CLIENT_ID = "00000000402b5328"
LIVE_REDIRECT = "https://login.live.com/oauth20_desktop.srf"
LIVE_SCOPE = "service::user.auth.xboxlive.com::MBI_SSL"
LIVE_AUTHORIZE = "https://login.live.com/oauth20_authorize.srf"
LIVE_TOKEN = "https://login.live.com/oauth20_token.srf"
MC = "https://api.minecraftservices.com"

session = requests.Session()
session.headers["User-Agent"] = "JaceSocial/1.0"
# A kept-open connection the server closed after a pause fails the next request ("Can't reach..." now
# and then): try those again on a new connection (only connection failures; nothing was answered yet).
_retry = requests.adapters.HTTPAdapter(max_retries=requests.adapters.Retry(
    total=2, connect=2, read=1, status=0, other=0, allowed_methods=None, backoff_factor=0.3, raise_on_status=False))
session.mount("https://", _retry)
session.mount("http://", _retry)


class AuthError(Exception):
    pass


def login_url() -> tuple[str, str]:
    """(page to show, redirect prefix that carries ?code=)."""
    q = {"client_id": LIVE_CLIENT_ID, "response_type": "code", "scope": LIVE_SCOPE,
         "redirect_uri": LIVE_REDIRECT, "prompt": "select_account"}
    return f"{LIVE_AUTHORIZE}?{urllib.parse.urlencode(q)}", LIVE_REDIRECT


def code_from_redirect(url: str) -> str | None:
    qs = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    if "error" in qs:
        raise AuthError(qs.get("error_description", qs["error"])[0])
    return qs.get("code", [None])[0]


def minecraft_account(code: str) -> dict:
    """Microsoft code -> {access_token, uuid, name} of the Minecraft: Java Edition account."""
    r = session.post(LIVE_TOKEN, timeout=30, data={
        "client_id": LIVE_CLIENT_ID, "redirect_uri": LIVE_REDIRECT, "scope": LIVE_SCOPE,
        "code": code, "grant_type": "authorization_code"})
    if r.status_code != 200:
        raise AuthError("Microsoft sign-in failed - try again")
    ms = r.json()["access_token"]
    r = session.post("https://user.auth.xboxlive.com/user/authenticate", timeout=30, json={
        "Properties": {"AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com", "RpsTicket": ms},
        "RelyingParty": "http://auth.xboxlive.com", "TokenType": "JWT"})
    if r.status_code != 200:
        raise AuthError(f"Xbox Live sign-in failed ({r.status_code})")
    xbl = r.json()
    uhs = xbl["DisplayClaims"]["xui"][0]["uhs"]
    r = session.post("https://xsts.auth.xboxlive.com/xsts/authorize", timeout=30, json={
        "Properties": {"SandboxId": "RETAIL", "UserTokens": [xbl["Token"]]},
        "RelyingParty": "rp://api.minecraftservices.com/", "TokenType": "JWT"})
    if r.status_code != 200:
        err = r.json().get("XErr") if r.content else None
        raise AuthError({2148916233: "This Microsoft account has no Xbox profile. Sign in at xbox.com first.",
                         2148916235: "Xbox Live isn't available in your country.",
                         2148916238: "This is a child account - an adult has to add it to a Microsoft family."}
                        .get(err, f"Xbox sign-in failed ({err or r.status_code})"))
    r = session.post(f"{MC}/authentication/login_with_xbox", timeout=30,
                     json={"identityToken": f"XBL3.0 x={uhs};{r.json()['Token']}"})
    if r.status_code != 200:
        raise AuthError(f"Minecraft sign-in failed ({r.status_code})")
    token = r.json()["access_token"]
    r = session.get(f"{MC}/minecraft/profile", headers={"Authorization": f"Bearer {token}"}, timeout=30)
    if r.status_code == 404:
        raise AuthError("This Microsoft account doesn't own Minecraft: Java Edition.")
    if r.status_code != 200:
        raise AuthError(f"Couldn't read the Minecraft profile ({r.status_code})")
    p = r.json()
    return {"access_token": token, "uuid": p["id"], "name": p["name"], "at": time.time()}


def _api(base: str, method: str, path: str, body=None, token: str | None = None) -> dict:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        try:
            r = session.request(method, base + path, json=body, headers=headers, timeout=20)
        except requests.ConnectionError:
            # usually a kept-open connection the server had already closed after a pause: once more, on a new one
            r = session.request(method, base + path, json=body, headers=headers, timeout=20)
    except requests.RequestException as e:
        raise AuthError("Can't reach Jace Social - check your internet connection") from e
    d = r.json() if r.content else {}
    if not r.ok:
        raise AuthError(d.get("error") or f"Jace Social error ({r.status_code})")
    return d


def _join(base: str, acc: dict) -> str:
    """Get a one-time server id and 'join' it with Mojang. Returns the server id."""
    sid = _api(base, "POST", "/api/v1/auth/start")["server_id"]
    r = session.post("https://sessionserver.mojang.com/session/minecraft/join", timeout=20, json={
        "accessToken": acc["access_token"], "selectedProfile": acc["uuid"], "serverId": sid})
    if r.status_code not in (200, 204):
        raise AuthError("Mojang didn't accept the sign-in - try again in a minute")
    return sid


def sign_in(base: str, acc: dict) -> dict:
    """Sign in to Jace Social with this Minecraft account -> {token, ...}."""
    sid = _join(base, acc)
    return _api(base, "POST", "/api/v1/auth/finish", {"name": acc["name"], "server_id": sid})


def link(base: str, acc: dict, token: str) -> dict:
    """Link this Minecraft account to the signed-in Jace account."""
    sid = _join(base, acc)
    return _api(base, "POST", "/api/v1/link/minecraft", {"name": acc["name"], "server_id": sid}, token)
