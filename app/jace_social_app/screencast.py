"""Screen sharing on Linux with Wayland.

The browser engine we ship (Qt WebEngine from PySide6) is built without Wayland screen capture: on
Wayland it finds no screens or windows ("Screen capturing is not available"). So the desktop app does it
itself, the way browsers do on Wayland:

1. the desktop's screen-sharing portal (org.freedesktop.portal.ScreenCast, over D-Bus with jeepney)
   asks you which screen or window to share, and hands us a PipeWire connection for it;
2. GStreamer (the system's gst-launch-1.0 with its PipeWire plugin, gst-plugin-pipewire) turns that into
   JPEG frames, at most 15 a second and at most 1920x1200;
3. a small web server on this computer only (127.0.0.1, an unguessable address per share) streams the
   frames to the page, which draws them on a canvas and sends that to the call (BRIDGE_JS replaces
   navigator.mediaDevices.getDisplayMedia).

Stopping (the page stops the track, or you stop sharing from the desktop) ends all three.
"""
from __future__ import annotations

import http.server
import os
import secrets
import shutil
import struct
import subprocess
import sys
import threading

PORTAL = ("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop")
MAX_W, MAX_H, FPS = 1920, 1200, 15


def needed() -> bool:
    """Linux with Wayland: the browser engine can't capture the screen itself."""
    return sys.platform.startswith("linux") and bool(os.environ.get("WAYLAND_DISPLAY"))


def _host_env() -> dict:
    from jace_social_app.jaceos import _host_env as env
    return env()


def missing() -> str | None:
    """What's missing for screen sharing, in words people can act on (None: all there)."""
    if not shutil.which("gst-launch-1.0"):
        return "Screen sharing needs GStreamer: install gstreamer and gst-plugin-pipewire (gstreamer1.0-pipewire on Debian/Ubuntu)."
    try:
        r = subprocess.run(["gst-inspect-1.0", "pipewiresrc"], capture_output=True, timeout=10, env=_host_env())
        if r.returncode != 0:
            return "Screen sharing needs GStreamer's PipeWire plugin: install gst-plugin-pipewire (gstreamer1.0-pipewire on Debian/Ubuntu)."
    except (OSError, subprocess.SubprocessError):
        pass
    return None


# --- JPEG frames out of gst-launch's output -------------------------------------------------------

def _frames(stream):
    """Yields whole JPEG images from a stream of JPEGs written one after another (walks the markers, so
    bytes inside an image that look like its end don't split it)."""
    buf = b""
    pos = 0
    while True:
        chunk = stream.read1(1 << 16) if hasattr(stream, "read1") else stream.read(1 << 16)
        if not chunk:
            return
        buf += chunk
        while True:
            start = buf.find(b"\xff\xd8", pos)
            if start < 0:
                buf, pos = buf[-1:], 0
                break
            end = _jpeg_end(buf, start)
            if end is None:
                buf, pos = buf[start:], 0
                break
            yield buf[start:end]
            buf, pos = buf[end:], 0


def _jpeg_end(b: bytes, start: int) -> int | None:
    """Where the JPEG at `start` ends (after its EOI), or None if it isn't all there yet."""
    i = start + 2
    n = len(b)
    while i + 4 <= n:
        if b[i] != 0xFF:
            i += 1
            continue
        marker = b[i + 1]
        if marker == 0xD9:                               # EOI
            return i + 2
        if marker == 0xFF or 0xD0 <= marker <= 0xD7 or marker == 0x01:
            i += 2 if marker != 0xFF else 1
            continue
        seg = struct.unpack(">H", b[i + 2:i + 4])[0]
        if marker != 0xDA:                               # a header segment: skip it whole
            i += 2 + seg
            continue
        i += 2 + seg                                     # SOS: then the image data, up to the next real marker
        while i + 1 < n:
            if b[i] == 0xFF and b[i + 1] != 0x00 and not 0xD0 <= b[i + 1] <= 0xD7:
                break
            i += 1
        else:
            return None
    return None


def _size(jpeg: bytes) -> tuple[int, int]:
    """(width, height) from a JPEG's frame header."""
    i = 2
    while i + 9 < len(jpeg):
        if jpeg[i] != 0xFF:
            i += 1
            continue
        marker = jpeg[i + 1]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack(">HH", jpeg[i + 5:i + 9])
            return w, h
        i += 2 + struct.unpack(">H", jpeg[i + 2:i + 4])[0]
    return 0, 0


# --- one share --------------------------------------------------------------------------------------

class Share:
    def __init__(self):
        self.id = secrets.token_hex(16)
        self.frame = b""
        self.seq = 0
        self.alive = True
        self.cond = threading.Condition()
        self.proc: subprocess.Popen | None = None
        self.conn = None
        self.session = None
        self.width = self.height = 0

    # the portal
    def _pick(self) -> tuple[int, int] | dict:
        """Ask the desktop which screen or window -> (PipeWire fd, node id), or {"error"/"cancelled"}."""
        from jeepney import DBusAddress, MatchRule, Properties, message_bus, new_method_call
        from jeepney.io.blocking import Proxy, open_dbus_connection

        try:
            conn = open_dbus_connection(bus="SESSION", enable_fds=True)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Couldn't reach your desktop ({e})"}
        self.conn = conn
        bus = Proxy(message_bus, conn)
        cast = DBusAddress(PORTAL[1], bus_name=PORTAL[0], interface="org.freedesktop.portal.ScreenCast")
        sender = conn.unique_name[1:].replace(".", "_")

        def prop(name, default):
            try:
                return conn.send_and_get_reply(Properties(cast).get(name), timeout=5).body[0][1]
            except Exception:  # noqa: BLE001
                return default

        if prop("version", 0) == 0:
            return {"error": "Your desktop has no screen-sharing portal: install xdg-desktop-portal and the one for your desktop (e.g. xdg-desktop-portal-wlr, -kde, -gnome or -hyprland)."}

        def request(method, signature, args, token):
            path = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
            rule = MatchRule(type="signal", interface="org.freedesktop.portal.Request", member="Response", path=path)
            bus.AddMatch(rule)
            with conn.filter(rule) as queue:
                conn.send_and_get_reply(new_method_call(cast, method, signature, args), timeout=10)
                while self.alive:
                    try:
                        return conn.recv_until_filtered(queue, timeout=1).body     # (code, results)
                    except TimeoutError:
                        continue
            return 1, {}

        tag = secrets.token_hex(4)
        code, res = request("CreateSession", "a{sv}", ({"handle_token": ("s", f"jace{tag}"),
                                                        "session_handle_token": ("s", f"jacecast{tag}")},), f"jace{tag}")
        if code != 0:
            return {"error": "Your desktop wouldn't start screen sharing"}
        self.session = res["session_handle"][1]

        types = prop("AvailableSourceTypes", 1) & 3 or 1                # 1 screens, 2 windows
        options = {"handle_token": ("s", f"jacesel{tag}"), "types": ("u", types), "multiple": ("b", False)}
        if prop("AvailableCursorModes", 0) & 2:
            options["cursor_mode"] = ("u", 2)                            # the pointer, drawn in
        code, _ = request("SelectSources", "oa{sv}", (self.session, options), f"jacesel{tag}")
        if code != 0:
            return {"cancelled": True} if code == 1 else {"error": "Your desktop wouldn't share the screen"}

        code, res = request("Start", "osa{sv}", (self.session, "", {"handle_token": ("s", f"jacestart{tag}")}), f"jacestart{tag}")
        if code == 1 or not self.alive:
            return {"cancelled": True}
        streams = res.get("streams", ("", []))[1] if code == 0 else []
        if not streams:
            return {"error": "Your desktop didn't share a screen or window"}
        node = int(streams[0][0])

        reply = conn.send_and_get_reply(new_method_call(cast, "OpenPipeWireRemote", "oa{sv}", (self.session, {})), timeout=10)
        fd = reply.body[0]
        fd = fd.to_raw_fd() if hasattr(fd, "to_raw_fd") else int(fd)
        return fd, node

    def start(self) -> dict:
        try:
            picked = self._pick()
        except Exception as e:  # noqa: BLE001
            picked = {"error": f"Screen sharing didn't start ({e})"}
        if isinstance(picked, dict):
            self.stop()
            return picked
        fd, node = picked
        pipeline = [
            "gst-launch-1.0", "-q",
            "pipewiresrc", f"fd={fd}", f"path={node}", "do-timestamp=true", "always-copy=true", "!",
            "videoconvert", "!", "videoscale", "!",
            f"video/x-raw,width=[1,{MAX_W}],height=[1,{MAX_H}],pixel-aspect-ratio=1/1", "!",
            "videorate", "drop-only=true", f"max-rate={FPS}", "!",
            "jpegenc", "quality=60", "!", "fdsink", "fd=1", "sync=false",
        ]
        try:
            self.proc = subprocess.Popen(pipeline, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                         stderr=subprocess.DEVNULL, pass_fds=(fd,), env=_host_env())
        except OSError as e:
            self.stop()
            return {"error": f"Couldn't start GStreamer ({e})"}
        finally:
            os.close(fd)
        threading.Thread(target=self._read, daemon=True).start()
        with self.cond:                                  # the first frame: its size, and proof it works
            self.cond.wait_for(lambda: self.seq > 0 or not self.alive, timeout=10)
        if not self.seq:
            self.stop()
            return {"error": "No picture came from your screen. " + (missing() or "Try sharing again.")}
        return {"id": self.id, "url": f"{_server_url()}/screen/{self.id}", "width": self.width, "height": self.height}

    def _read(self):
        try:
            for jpeg in _frames(self.proc.stdout):
                with self.cond:
                    if not self.seq:
                        self.width, self.height = _size(jpeg)
                    self.frame = jpeg
                    self.seq += 1
                    self.cond.notify_all()
        except (OSError, ValueError):
            pass
        self.stop()                                      # the picture ended (stopped from the desktop)

    def stop(self):
        with self.cond:
            if not self.alive and self.proc is None and self.conn is None:
                return
            self.alive = False
            self.cond.notify_all()
        proc, self.proc = self.proc, None
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
        conn, self.conn = self.conn, None
        if conn:
            try:
                if self.session:
                    from jeepney import DBusAddress, new_method_call
                    session = DBusAddress(self.session, bus_name=PORTAL[0], interface="org.freedesktop.portal.Session")
                    conn.send_and_get_reply(new_method_call(session, "Close"), timeout=2)
            except Exception:  # noqa: BLE001
                pass
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
        _shares.pop(self.id, None)


_shares: dict[str, Share] = {}


def start() -> dict:
    """Share a screen or window (asks which first) -> {id, url, width, height}, {"cancelled": true}
    or {"error": what's wrong}. Blocks while you choose: call it off the UI thread."""
    if not needed():
        return {"error": "Screen sharing this way is only for Linux with Wayland"}
    problem = missing()
    if problem:
        return {"error": problem}
    share = Share()
    _shares[share.id] = share
    return share.start()


def stop(share_id: str):
    share = _shares.get(share_id)
    if share:
        threading.Thread(target=share.stop, daemon=True).start()


def stop_all():
    for share in list(_shares.values()):
        share.stop()


# --- the page gets the frames from here -------------------------------------------------------------

class _Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):                       # quiet
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Methods", "GET")
        self.send_header("Cache-Control", "no-store")

    def do_OPTIONS(self):                                # (Chromium asks first: a public page reading 127.0.0.1)
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parts = self.path.strip("/").split("/")
        share = _shares.get(parts[1]) if len(parts) == 2 and parts[0] == "screen" else None
        if not share:
            self.send_error(404)
            return
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/octet-stream")
        self.end_headers()
        seen = 0
        try:
            while True:
                with share.cond:
                    share.cond.wait_for(lambda: share.seq != seen or not share.alive, timeout=5)
                    if not share.alive:
                        return
                    if share.seq == seen:
                        continue
                    seen, frame = share.seq, share.frame
                self.wfile.write(struct.pack(">I", len(frame)) + frame)    # length, then the JPEG
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return


_server: http.server.ThreadingHTTPServer | None = None
_server_lock = threading.Lock()


def _server_url() -> str:
    global _server
    with _server_lock:
        if _server is None:
            _server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
            _server.daemon_threads = True
            threading.Thread(target=_server.serve_forever, daemon=True).start()
        return f"http://127.0.0.1:{_server.server_address[1]}"
