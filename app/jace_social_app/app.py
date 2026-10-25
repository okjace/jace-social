"""The desktop window. It shows the Jace Social web app and adds what a browser can't:
Microsoft (Minecraft) sign-in, system notifications, a tray icon and an unread badge."""
import json
import os
import sys
import subprocess
import threading
import time
from pathlib import Path

from PySide6.QtCore import QObject, Property, QRect, Qt, QTimer, QUrl, Signal, Slot
from PySide6.QtGui import QAction, QCursor, QDesktopServices, QGuiApplication, QIcon, QKeySequence, QShortcut
from PySide6.QtNetwork import QLocalServer, QLocalSocket
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import (QWebEngineDesktopMediaRequest, QWebEnginePage, QWebEnginePermission, QWebEngineProfile, QWebEngineScript,
                                      QWebEngineSettings)
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import (QApplication, QDialog, QHBoxLayout, QLabel, QMainWindow, QMenu, QMessageBox, QPushButton,
                               QSystemTrayIcon, QVBoxLayout, QWidget)

from jace_social_app import APP_ID, APP_NAME, APP_VERSION, DATA_DIR, URL_SCHEME, desktop, hotkeys, macinstall, minecraft, updater, wininstall
from jace_social_app.installer import SetupWizard, confirm_uninstall, run_windows_update, update_app

BASE = os.environ.get("JACE_SOCIAL_URL", "https://jace-social.vercel.app").rstrip("/")
# pages that open inside the app; everything else goes to your normal browser
IN_APP_HOSTS = {QUrl(BASE).host(), "jaceo.vercel.app"}
ASSETS = desktop.ASSETS


# JavaScript put into every page: window.jaceDesktop, backed by the Python Bridge below.
BRIDGE_JS = """
(function () {
  const pending = {}; let next = 0;
  window.jaceDesktopPending = true;
  new QWebChannel(qt.webChannelTransport, function (ch) {
    const b = ch.objects.bridge;
    b.reply.connect(function (id, text) { const ok = pending[id]; delete pending[id]; if (ok) ok(JSON.parse(text)); });
    const call = function (fn) {
      const args = Array.prototype.slice.call(arguments, 1);
      return new Promise(function (ok) { const id = ++next; pending[id] = ok; b[fn].apply(b, [id].concat(args)); });
    };
    window.jaceDesktop = {
      version: b.version,
      signInMinecraft: function () { return call("signInMinecraft"); },
      linkMinecraft: function (token) { return call("linkMinecraft", token); },
      notify: function (title, body) { b.notify(String(title), String(body)); },
      setUnread: function (n) { b.setUnread(Number(n) || 0); },
      installed: b.installed,
      checkForUpdate: function () { return call("checkForUpdate"); },
      getAutoUpdateCheck: function () { return call("getAutoUpdateCheck"); },
      getDesktopSettings: function () { return call("getDesktopSettings"); },
      setStartup: function (on) { return call("setStartup", !!on); },
      setOverlayShortcut: function (combo) { return call("setOverlayShortcut", String(combo || "")); },
      configureOverlayShortcut: function () { return call("configureOverlayShortcut"); },
      setAutoUpdateCheck: function (on) { b.setAutoUpdateCheck(!!on); },
      applyUpdate: function () { b.applyUpdate(); },
      deleteApp: function () { b.deleteApp(); },
      quit: function () { b.quitApp(); },
    };
    window.dispatchEvent(new Event("jacedesktop"));
  });
})();
"""


def desktop_notification(title: str, body: str):
    """A notification through the freedesktop notification service (Linux without a tray icon)."""
    def send():
        try:
            from jeepney import DBusAddress, new_method_call
            from jeepney.io.blocking import open_dbus_connection
            with open_dbus_connection(bus="SESSION") as conn:
                notifications = DBusAddress("/org/freedesktop/Notifications", bus_name="org.freedesktop.Notifications",
                                            interface="org.freedesktop.Notifications")
                conn.send_and_get_reply(new_method_call(notifications, "Notify", "susssasa{sv}i", (
                    APP_NAME, 0, APP_ID, title, body[:300], [], {"desktop-entry": ("s", APP_ID)}, 6000)), timeout=5)
        except Exception:  # noqa: BLE001 - no notification service: nothing to show
            pass
    threading.Thread(target=send, daemon=True).start()


PREFS = DATA_DIR / "prefs.json"


def pretty_trigger(description: str) -> str:
    """The portal's "Press <Shift><Control>j" as "Ctrl+Shift+J"."""
    import re
    d = description.removeprefix("Press ").strip()
    mods = re.findall(r"<(\w+)>", d)
    key = re.sub(r"<\w+>", "", d).strip()
    names = {"Control": "Ctrl", "Primary": "Ctrl", "Shift": "Shift", "Alt": "Alt", "Super": "Super", "Meta": "Meta"}
    order = ["Ctrl", "Shift", "Alt", "Super", "Meta"]
    parts = sorted({names.get(m, m) for m in mods}, key=lambda m: order.index(m) if m in order else 9)
    return "+".join(parts + [key.upper() if len(key) == 1 else key]) if key else d


def pref(key: str, default=None):
    try:
        return json.loads(PREFS.read_text()).get(key, default)
    except (OSError, ValueError):
        return default


def set_pref(key: str, value):
    try:
        data = json.loads(PREFS.read_text())
    except (OSError, ValueError):
        data = {}
    data[key] = value
    try:
        PREFS.parent.mkdir(parents=True, exist_ok=True)
        PREFS.write_text(json.dumps(data))
    except OSError:
        pass


class MicrosoftLogin(QDialog):
    """Microsoft's sign-in page; finishes when it redirects with ?code=."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Sign in with Microsoft")
        self.resize(520, 680)
        self.url, self.redirect = minecraft.login_url()
        self.code = None
        self.error = None
        self.profile = QWebEngineProfile()                 # private: every sign-in can pick another account
        self.page = QWebEnginePage(self.profile)
        self.view = QWebEngineView(self)
        self.view.setPage(self.page)
        self.view.urlChanged.connect(self._changed)
        self.view.setUrl(QUrl(self.url))
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(self.view)

    def _changed(self, url: QUrl):
        s = url.toString()
        if not s.startswith(self.redirect) or self.code or self.error:
            return
        try:
            self.code = minecraft.code_from_redirect(s)
        except minecraft.AuthError as e:
            self.error = str(e)
        QTimer.singleShot(0, self.accept if self.code else self.reject)

    def done(self, result):
        self.view.urlChanged.disconnect(self._changed)
        self.view.setPage(None)
        self.page.deleteLater()
        super().done(result)


class Bridge(QObject):
    """What the web page can ask the desktop app for (see BRIDGE_JS)."""
    reply = Signal(int, str)

    def __init__(self, window: "Window"):
        super().__init__()
        self.window = window

    @Property(str, constant=True)
    def version(self):
        return APP_VERSION

    @Property(bool, constant=True)
    def installed(self):
        """Running a packaged build (it can update and delete itself), not from source."""
        return desktop.frozen()

    def _microsoft(self, rid: int, finish):
        """Show Microsoft sign-in, then run finish(account) off the UI thread and reply.
        The window opens without blocking (no exec()): this runs inside a call from the
        web page, and a nested event loop here stalls WebEngine, so the sign-in page
        would stay white."""
        dlg = MicrosoftLogin(self.window)
        dlg.setWindowModality(Qt.WindowModality.WindowModal)
        dlg.finished.connect(lambda result: self._microsoft_done(rid, finish, dlg, result))
        self._login = dlg                  # keep it alive while it's open
        dlg.open()

    def _microsoft_done(self, rid: int, finish, dlg: "MicrosoftLogin", result: int):
        self._login = None
        dlg.deleteLater()
        if result != QDialog.DialogCode.Accepted.value or not dlg.code:
            self.reply.emit(rid, json.dumps({"error": dlg.error or "Sign-in was cancelled"}))
            return
        code = dlg.code

        def work():
            try:
                out = finish(minecraft.minecraft_account(code))
            except minecraft.AuthError as e:
                out = {"error": str(e)}
            except Exception as e:  # noqa: BLE001 - always answer the page
                out = {"error": f"Something went wrong ({e.__class__.__name__})"}
            self.reply.emit(rid, json.dumps(out))
        threading.Thread(target=work, daemon=True).start()

    @Slot(int)
    def signInMinecraft(self, rid: int):
        self._microsoft(rid, lambda acc: minecraft.sign_in(BASE, acc))

    @Slot(int, str)
    def linkMinecraft(self, rid: int, token: str):
        self._microsoft(rid, lambda acc: minecraft.link(BASE, acc, token))

    @Slot(str, str)
    def notify(self, title: str, body: str):
        self.window.notify(title, body)

    @Slot(int)
    def setUnread(self, n: int):
        self.window.set_unread(n)

    @Slot(int)
    def checkForUpdate(self, rid: int):
        self.window.check_for_update(lambda r: self.reply.emit(rid, json.dumps(r)))

    @Slot(int)
    def getDesktopSettings(self, rid: int):
        w = self.window
        self.reply.emit(rid, json.dumps({
            "startup": desktop.startup_enabled(),
            "overlayShortcut": pref("overlay_shortcut", "") or "",
            "overlayError": w.hotkey_error,
            # Wayland: the keys the desktop actually uses (you can pick others in its dialog)
            "overlayBoundAs": pretty_trigger(pref("overlay_bound_as", "")) if hotkeys.on_wayland() else None,
            # Wayland: the desktop owns the keys (its dialog picks them, its settings change them)
            "overlayManagedByDesktop": hotkeys.on_wayland(),
            "shortcutsUnsupported": hotkeys.unsupported_reason(),
        }))

    @Slot(int, bool)
    def setStartup(self, rid: int, on: bool):
        try:
            desktop.set_startup(on)
            self.reply.emit(rid, json.dumps({"ok": True}))
        except Exception as e:  # noqa: BLE001
            self.reply.emit(rid, json.dumps({"error": str(e)}))

    @Slot(int, str)
    def setOverlayShortcut(self, rid: int, combo: str):
        err = self.window.set_overlay_shortcut(combo.strip())
        note = "Your desktop will ask you to allow it" if combo.strip() and hotkeys.on_wayland() and not err else None
        self.reply.emit(rid, json.dumps({"error": err} if err else {"ok": True, "note": note}))

    @Slot(int)
    def configureOverlayShortcut(self, rid: int):
        ok = self.window.hotkey.configure()
        self.reply.emit(rid, json.dumps({"ok": True} if ok else {"error": "Turn the shortcut on first"}))

    @Slot(int)
    def getAutoUpdateCheck(self, rid: int):
        self.reply.emit(rid, json.dumps(pref("auto_update_check", True) is not False))

    @Slot(bool)
    def setAutoUpdateCheck(self, on: bool):
        set_pref("auto_update_check", bool(on))

    # these open dialogs, so let the page's call return first (see _microsoft)
    @Slot()
    def applyUpdate(self):
        QTimer.singleShot(0, self.window.apply_update)

    @Slot()
    def quitApp(self):
        QTimer.singleShot(0, self.window.quit)

    @Slot()
    def deleteApp(self):
        QTimer.singleShot(0, self.window.delete_app)


class ScreenPicker(QDialog):
    """Which screen or window to share (the page asked for getDisplayMedia)."""

    def __init__(self, request, parent=None):
        from PySide6.QtCore import Qt as _Qt
        from PySide6.QtWidgets import QDialogButtonBox, QLabel, QListWidget, QListWidgetItem
        super().__init__(parent)
        self.request = QWebEngineDesktopMediaRequest(request)  # the signal's copy dies (and cancels) when the slot returns
        self.done_ = False
        self.setWindowTitle("Share your screen")
        self.resize(420, 420)
        lay = QVBoxLayout(self)
        lay.addWidget(QLabel("Choose what your friends will see:"))
        self.list = QListWidget()
        for kind, model, label in (("screen", request.screensModel(), "🖥️"), ("window", request.windowsModel(), "🪟")):
            for row in range(model.rowCount()):
                name = model.data(model.index(row, 0), _Qt.ItemDataRole.DisplayRole) or f"{kind.title()} {row + 1}"
                item = QListWidgetItem(f"{label}  {name}")
                item.setData(_Qt.ItemDataRole.UserRole, (kind, row))
                self.list.addItem(item)
        if self.list.count():
            self.list.setCurrentRow(0)
        self.list.itemDoubleClicked.connect(lambda _: self.accept())
        lay.addWidget(self.list, 1)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Cancel)
        share = buttons.addButton("Share", QDialogButtonBox.ButtonRole.AcceptRole)
        share.setDefault(True)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        lay.addWidget(buttons)
        self.finished.connect(self._finish)

    def _finish(self, result: int):
        from PySide6.QtCore import Qt as _Qt
        if self.done_:
            return
        self.done_ = True
        item = self.list.currentItem()
        if result == QDialog.DialogCode.Accepted.value and item:
            kind, row = item.data(_Qt.ItemDataRole.UserRole)
            model = self.request.screensModel() if kind == "screen" else self.request.windowsModel()
            (self.request.selectScreen if kind == "screen" else self.request.selectWindow)(model.index(row, 0))
        else:
            self.request.cancel()
        self.deleteLater()


class Page(QWebEnginePage):
    """Keeps Jace Social (and Jace sign-in) in the app; other links open in the browser."""

    # microphone, camera and screen sharing for calls - only for Jace Social itself
    CALL_PERMISSIONS = {
        QWebEnginePermission.PermissionType.MediaAudioCapture, QWebEnginePermission.PermissionType.MediaVideoCapture,
        QWebEnginePermission.PermissionType.MediaAudioVideoCapture, QWebEnginePermission.PermissionType.DesktopVideoCapture,
        QWebEnginePermission.PermissionType.DesktopAudioVideoCapture,
    }

    def __init__(self, profile, parent=None):
        super().__init__(profile, parent)
        self.permissionRequested.connect(self._permission)
        self.desktopMediaRequested.connect(self._pick_screen)
        self._picker = None

    def _permission(self, p: QWebEnginePermission):
        if p.permissionType() in self.CALL_PERMISSIONS and p.origin().host() == QUrl(BASE).host():
            p.grant()
        else:
            p.deny()

    def _pick_screen(self, request):
        """Screen sharing: let the person pick a screen or a window (like a browser does)."""
        if self.url().host() != QUrl(BASE).host():
            request.cancel()
            return
        self._picker = ScreenPicker(request, self.parent())
        self._picker.open()                     # not exec(): this runs inside a WebEngine callback

    def acceptNavigationRequest(self, url: QUrl, nav_type, is_main_frame: bool) -> bool:
        if is_main_frame and url.scheme() in ("http", "https") and url.host() not in IN_APP_HOSTS:
            QDesktopServices.openUrl(url)
            return False
        return super().acceptNavigationRequest(url, nav_type, is_main_frame)

    def createWindow(self, _type):
        # window.open / target=_blank: open in the normal browser instead of a new app window
        page = QWebEnginePage(self.profile(), self)
        page.urlChanged.connect(lambda u: (QDesktopServices.openUrl(u), page.deleteLater()))
        return page


class Overlay(QWidget):
    """Jace Social on top of your game: the overlay shortcut shows it, and again (or Esc / ✕)
    hides it. It borrows the main window's page, so it's the same Jace Social: calls and voice
    keep going. Works over windowed and borderless games (not exclusive fullscreen)."""
    closed = Signal()

    def __init__(self):
        super().__init__(None, Qt.WindowType.FramelessWindowHint | Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.Tool)
        self.setWindowTitle(f"{APP_NAME} overlay")
        self.setWindowOpacity(0.97)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        self.bar = QWidget()
        self.bar.setFixedHeight(28)
        self.bar.setStyleSheet("background: #111317; color: #8b919c;")
        bar = QHBoxLayout(self.bar)
        bar.setContentsMargins(10, 0, 2, 0)
        bar.addWidget(QLabel(f"{APP_NAME} · drag to move · Esc to hide"), 1)
        close = QPushButton("✕")
        close.setFlat(True)
        close.setFixedSize(26, 26)
        close.setStyleSheet("color: #e6e8ec; border: 0;")
        close.clicked.connect(self.hide)
        bar.addWidget(close)
        lay.addWidget(self.bar)
        self.bar.installEventFilter(self)
        self._drag = None
        QShortcut(QKeySequence("Escape"), self, self.hide)

    def eventFilter(self, obj, e):
        from PySide6.QtCore import QEvent
        if obj is self.bar:
            if e.type() == QEvent.Type.MouseButtonPress:
                self._drag = e.globalPosition().toPoint() - self.frameGeometry().topLeft()
            elif e.type() == QEvent.Type.MouseMove and self._drag is not None:
                self.move(e.globalPosition().toPoint() - self._drag)
            elif e.type() == QEvent.Type.MouseButtonRelease:
                self._drag = None
        return False

    def hideEvent(self, e):
        super().hideEvent(e)
        self.closed.emit()


class Window(QMainWindow):
    update_ready = Signal(dict, object)           # update check result, and what to do with it

    def __init__(self, url: str = BASE + "/app"):
        super().__init__()
        self.setWindowTitle(APP_NAME)
        self.resize(1200, 780)
        self.setMinimumSize(380, 480)
        icon = QIcon(str(ASSETS / "icon.png"))
        self.setWindowIcon(icon)
        self.quitting = False

        # a saved browser profile, so you stay signed in
        self.profile = QWebEngineProfile("jace-social", self)
        self.profile.setPersistentStoragePath(str(DATA_DIR / "web"))
        self.profile.setCachePath(str(DATA_DIR / "cache"))
        self.profile.setHttpUserAgent(self.profile.httpUserAgent() + f" JaceSocialDesktop/{APP_VERSION}")
        self.page = Page(self.profile, self)
        self.page.settings().setAttribute(QWebEngineSettings.WebAttribute.JavascriptCanOpenWindows, True)
        # so an incoming call can ring before you've clicked anything
        self.page.settings().setAttribute(QWebEngineSettings.WebAttribute.PlaybackRequiresUserGesture, False)
        # screen sharing in calls (off by default; the page's getDisplayMedia fails without it)
        self.page.settings().setAttribute(QWebEngineSettings.WebAttribute.ScreenCaptureEnabled, True)

        self.channel = QWebChannel(self.page)
        self.bridge = Bridge(self)
        self.channel.registerObject("bridge", self.bridge)
        self.page.setWebChannel(self.channel)
        script = QWebEngineScript()
        script.setName("jace-desktop")
        script.setSourceCode(_qwebchannel_js() + BRIDGE_JS)
        script.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
        script.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
        script.setRunsOnSubFrames(False)
        self.page.scripts().insert(script)

        self.view = QWebEngineView(self)
        self.view.setPage(self.page)
        self.view.loadFinished.connect(self._loaded)
        self.setCentralWidget(self.view)
        self.view.setUrl(QUrl(url))
        # F5 / Ctrl+R (Cmd+R): load the newest Jace Social (the app stays open for days)
        for keys in (QKeySequence.StandardKey.Refresh, QKeySequence("Ctrl+R")):
            QShortcut(keys, self, self.view.reload)
        QShortcut(QKeySequence.StandardKey.Quit, self, self.quit)          # Ctrl+Q / Cmd+Q
        QShortcut(QKeySequence("Ctrl+Q"), self, self.quit)

        self.tray = None
        if QSystemTrayIcon.isSystemTrayAvailable():
            self.tray = QSystemTrayIcon(icon, self)
            self.tray.setToolTip(APP_NAME)
            menu = QMenu()
            show = QAction("Open Jace Social", menu)
            show.triggered.connect(self.bring_up)
            update = QAction("Check for updates", menu)
            update.triggered.connect(lambda: self.check_for_update(self._update_dialog, fresh=True))
            quit_ = QAction("Quit", menu)
            quit_.triggered.connect(self.quit)
            reload_ = QAction("Reload", menu)
            reload_.triggered.connect(lambda: (self.view.reload(), self.bring_up()))
            overlay = QAction("Show overlay", menu)
            overlay.triggered.connect(lambda: QTimer.singleShot(0, self.toggle_overlay))
            menu.addAction(show)
            menu.addAction(overlay)
            menu.addAction(reload_)
            menu.addAction(update)
            menu.addSeparator()
            menu.addAction(quit_)
            self.tray.setContextMenu(menu)
            self.tray.activated.connect(lambda reason: self.bring_up()
                                        if reason == QSystemTrayIcon.ActivationReason.Trigger else None)
            self.tray.messageClicked.connect(self.bring_up)
            self.tray.show()

        # the overlay and its shortcut (Settings -> Desktop app)
        self.overlay: Overlay | None = None
        self._main_was_visible = False
        self.hotkey = hotkeys.HotKey(self)
        self.hotkey.pressed.connect(self.toggle_overlay)
        self.hotkey.failed.connect(self._shortcut_failed)
        self.hotkey.bound.connect(self._shortcut_bound)
        self.hotkey_error = None
        if pref("overlay_shortcut"):
            self.set_overlay_shortcut(pref("overlay_shortcut"), save=False)

        # like Jace Launcher: look for a new version right after starting (and every few hours
        # while the app stays open in the tray), and ask about each new version once
        self.update = None              # updater.check() result when a newer version is out
        self._checked = 0.0
        self._ask_when_shown = False
        self.update_ready.connect(lambda r, cb: cb(r))
        if pref("auto_update_check", True) is not False and not updater.unsupported_reason():
            QTimer.singleShot(3_000, lambda: self.check_for_update(self._update_notice, fresh=True))
            self._update_timer = QTimer(self, interval=3 * 3600_000)
            self._update_timer.timeout.connect(lambda: self.check_for_update(self._update_notice, fresh=True))
            self._update_timer.start()

    def check_for_update(self, done, fresh=False):
        """Ask GitHub off the UI thread (at most every 10 minutes unless fresh);
        done({current, latest, newer} or {error}) runs on the UI thread."""
        def result():
            u = self.update
            return {"current": APP_VERSION, "latest": u["version"] if u else APP_VERSION, "newer": bool(u)}
        if not fresh and time.monotonic() - self._checked < 600:
            done(result())
            return

        def work():
            try:
                self.update = updater.check()
                self._checked = time.monotonic()
                r = result()
            except Exception:  # noqa: BLE001 - offline, rate limited, ...
                r = {"error": "Couldn't check for updates - try again later", "current": APP_VERSION}
            self.update_ready.emit(r, done)
        threading.Thread(target=work, daemon=True).start()

    def apply_update(self):
        """Download the new version, swap it in and restart (asks first when it can't)."""
        if not self.update:
            return
        why = updater.unsupported_reason()
        if why:
            QMessageBox.information(self, APP_NAME, f"{why}\n\nYou can also download it from the website.")
            QDesktopServices.openUrl(QUrl(self.update.get("page") or updater.RELEASES))
            return
        if update_app(self.update, self):
            self.quit()

    def delete_app(self):
        if confirm_uninstall(self):
            self.quit()

    def _update_notice(self, r: dict):
        """A newer version turned up on its own (not from Settings): ask once per version."""
        if not r.get("newer") or pref("asked_about") == r["latest"]:
            return
        if self.tray:
            self.tray.showMessage(APP_NAME, f"{APP_NAME} {r['latest']} is out.", self.windowIcon(), 8000)
        if self.isVisible() and not self.isMinimized():
            self._ask_update()
        else:
            self._ask_when_shown = True                 # in the tray: ask when the window comes back

    def _ask_update(self):
        """Like Jace Launcher's: Update now / Later, with what's new."""
        self._ask_when_shown = False
        info = self.update
        if not info:
            return
        set_pref("asked_about", info["version"])
        box = QMessageBox(self)
        box.setWindowTitle(f"Update {APP_NAME}")
        box.setText(f"<b>Update to {APP_NAME} {info['version']}?</b><br>"
                    f"You have {updater.current_version()}. The app restarts when the update is ready. You stay signed in.")
        if info.get("notes"):
            box.setDetailedText(info["notes"])
        go = box.addButton("Update now", QMessageBox.ButtonRole.AcceptRole)
        box.addButton("Later", QMessageBox.ButtonRole.RejectRole)
        box.setWindowModality(Qt.WindowModality.WindowModal)
        box.finished.connect(lambda _r: box.clickedButton() is go and QTimer.singleShot(0, self.apply_update))
        box.open()

    def _update_dialog(self, r: dict):
        if r.get("error"):
            QMessageBox.warning(self, APP_NAME, r["error"])
        elif not r["newer"]:
            QMessageBox.information(self, APP_NAME, f"You have the newest version ({APP_VERSION}).")
        elif QMessageBox.question(self, APP_NAME, f"{APP_NAME} {r['latest']} is out (you have {APP_VERSION}).\n\n"
                                  "Update now? It takes a minute, then the app restarts.") \
                == QMessageBox.StandardButton.Yes:
            self.apply_update()

    def _loaded(self, ok: bool):
        if not ok:
            self.view.setHtml(f"""<body style="background:#111317;color:#e6e8eb;font:16px system-ui;display:grid;
                place-items:center;height:90vh"><div style="text-align:center"><h2 style="color:#3ddc84">Can't reach Jace Social</h2>
                <p>Check your internet connection.</p><button onclick="location.href='{BASE}/app'"
                style="padding:10px 18px;border-radius:9px;border:0;background:#3ddc84;font-weight:700">Try again</button></div>""",
                              QUrl(BASE + "/"))

    def notify(self, title: str, body: str):
        if not self.isActiveWindow():
            if self.tray:
                self.tray.showMessage(title, body, self.windowIcon(), 6000)
            elif sys.platform.startswith("linux"):
                desktop_notification(title, body)       # no tray (GNOME): the desktop's own notifications
        QApplication.alert(self)

    def set_unread(self, n: int):
        self.setWindowTitle(f"({n}) {APP_NAME}" if n else APP_NAME)
        if self.tray:
            self.tray.setToolTip(f"{APP_NAME} - {n} unread" if n else APP_NAME)

    def open_link(self, link: str):
        """jacesocial://invite/<code> (from an invite page): show that invite in the app."""
        url = QUrl(link)
        if url.scheme() != URL_SCHEME:
            return
        parts = [p for p in (url.host() + url.path()).split("/") if p]
        if len(parts) == 2 and parts[0] == "invite" and all(c.isalnum() or c in "-_" for c in parts[1]) and len(parts[1]) <= 32:
            self.view.setUrl(QUrl(f"{BASE}/invite/{parts[1]}"))
        self.bring_up()

    # -- the overlay
    def set_overlay_shortcut(self, combo: str, save=True) -> str | None:
        """Listen for this shortcut ("" turns it off); returns why it can't."""
        try:
            self.hotkey.set(combo)
            self.hotkey_error = None
        except (ValueError, RuntimeError) as e:
            self.hotkey_error = str(e)
            return str(e)
        except Exception as e:  # noqa: BLE001 - e.g. macOS without Accessibility permission
            self.hotkey_error = f"Couldn't set the shortcut ({e})"
            return self.hotkey_error
        if save:
            set_pref("overlay_shortcut", combo)
        return None

    def _shortcut_failed(self, why: str):
        self.hotkey_error = why
        if self.tray:
            self.tray.showMessage(APP_NAME, f"Overlay shortcut: {why}", self.windowIcon(), 6000)

    def _shortcut_bound(self, description: str):
        self.hotkey_error = None
        set_pref("overlay_bound", pref("overlay_shortcut", ""))
        if description:
            set_pref("overlay_bound_as", description)

    def toggle_overlay(self, activation_token: str = ""):
        if self.overlay and self.overlay.isVisible():
            self.overlay.hide()
            return
        if hotkeys.on_wayland():
            # Wayland only brings a window to the front with the token the desktop gave with the
            # key press, and Qt uses it when a window first appears: so a fresh overlay each time
            if activation_token:
                os.environ["XDG_ACTIVATION_TOKEN"] = activation_token
            if self.overlay is not None:
                self.overlay.deleteLater()
                self.overlay = None
        if self.overlay is None:
            self.overlay = Overlay()
            self.overlay.setWindowIcon(self.windowIcon())
            self.overlay.closed.connect(self._overlay_closed)
        self._main_was_visible = self.isVisible() and not self.isMinimized()
        view = self.takeCentralWidget()                 # the same page moves into the overlay
        self.overlay.layout().addWidget(view)
        view.show()
        geo = pref("overlay_geometry")
        screen = QGuiApplication.screenAt(QCursor.pos()) or QGuiApplication.primaryScreen()
        area = screen.availableGeometry()
        if geo and len(geo) == 4 and area.intersects(QRect(*geo)):
            self.overlay.setGeometry(*geo)
        else:
            w, h = 420, min(720, area.height() - 80)
            self.overlay.setGeometry(area.right() - w - 24, area.top() + 40, w, h)
        if self._main_was_visible:
            self.hide()
        self.overlay.show()
        self.overlay.raise_()
        self.overlay.activateWindow()

    def _overlay_closed(self):
        g = self.overlay.geometry()
        set_pref("overlay_geometry", [g.x(), g.y(), g.width(), g.height()])
        if self.centralWidget() is None:                # give the page back to the main window
            self.overlay.layout().removeWidget(self.view)
            self.setCentralWidget(self.view)
            self.view.show()
        if self._main_was_visible:
            self._main_was_visible = False
            self.show()

    def bring_up(self):
        if self.overlay and self.overlay.isVisible():
            self.overlay.hide()                         # the page goes back to the main window
        self.show()
        self.setWindowState((self.windowState() & ~Qt.WindowState.WindowMinimized) | Qt.WindowState.WindowActive)
        self.raise_()
        self.activateWindow()

    def showEvent(self, e):
        super().showEvent(e)
        if getattr(self, "_ask_when_shown", False):     # a new version turned up while the window was in the tray
            QTimer.singleShot(800, self._ask_update)

    def quit(self):
        self.quitting = True
        # stop answering "already open?" right away: opening Jace Social again starts a fresh copy
        # instead of asking this one, which is going away
        server = getattr(QApplication.instance(), "single_instance", None)
        if server is not None:
            server.close()
        _forget_pid()
        # Qt WebEngine sometimes hangs while shutting down (seen on Linux): then the app never
        # quit and couldn't be opened again until a restart. Give it a few seconds, then go.
        _exit_soon(5)
        try:
            self.hotkey.stop()
        except Exception:  # noqa: BLE001 - quitting anyway
            pass
        QApplication.quit()

    def closeEvent(self, e):
        # keep running in the background (like Discord), so messages still pop up: in the tray,
        # or without one (GNOME has none) just hidden - opening Jace Social again shows it.
        # The page stays as it is (deleting it here left a white window when it came back).
        if not self.quitting:
            e.ignore()
            self.hide()
            if not getattr(self, "_told", False):
                self._told = True
                if self.tray:
                    self.tray.showMessage(APP_NAME, "Still running here. Right-click the icon to quit.",
                                          self.windowIcon(), 4000)
                else:
                    self.notify(APP_NAME, "Still running in the background, so messages reach you. "
                                          "Quit with Ctrl+Q or in Settings.")
            return
        self.view.setPage(None)
        self.page.deleteLater()
        super().closeEvent(e)


PID_FILE = DATA_DIR / "running.pid"


def _exit_soon(seconds: float):
    t = threading.Timer(seconds, lambda: os._exit(0))
    t.daemon = True
    t.start()


def _forget_pid():
    try:
        if PID_FILE.read_text().strip() == str(os.getpid()):
            PID_FILE.unlink()
    except OSError:
        pass


def _stop_stuck_copy() -> bool:
    """A copy that's open but doesn't answer (stuck quitting): stop it. True if there was one."""
    try:
        pid = int(PID_FILE.read_text().strip())
    except (OSError, ValueError):
        return False                     # no file: a version from before this, which doesn't answer back
    if pid == os.getpid():
        return False
    if sys.platform.startswith("linux"):
        try:
            cmd = Path(f"/proc/{pid}/cmdline").read_bytes().lower()
        except OSError:
            cmd = b""                    # already gone
        if cmd and b"jace" not in cmd:
            return True                  # that number belongs to something else now: just start
    try:
        import signal
        os.kill(pid, signal.SIGTERM if sys.platform == "win32" else signal.SIGKILL)
    except OSError:
        pass
    return True


def _qwebchannel_js() -> str:
    from PySide6.QtCore import QFile, QIODevice
    f = QFile(":/qtwebchannel/qwebchannel.js")
    if f.open(QIODevice.OpenModeFlag.ReadOnly):
        return bytes(f.readAll()).decode()
    raise RuntimeError("qwebchannel.js is missing from this Qt build")


class LinkApp(QApplication):
    """macOS delivers jacesocial:// links as open-URL events instead of arguments."""

    def __init__(self, argv):
        super().__init__(argv)
        self.window = None
        self.pending_links: list[str] = []

    def event(self, e):
        from PySide6.QtCore import QEvent
        if e.type() == QEvent.Type.FileOpen and e.url().scheme() == URL_SCHEME:
            link = e.url().toString()
            if self.window:
                self.window.open_link(link)
            else:
                self.pending_links.append(link)
            return True
        return super().event(e)


def self_test(app) -> int:
    """Used by CI on packaged builds: prove the bundle starts (Qt, WebEngine, the bridge
    script and the bundled assets), then exit. Exit code 0 = OK."""
    results = []
    try:
        assert desktop.ICON_SRC.is_file(), f"missing icon {desktop.ICON_SRC}"
        assert _qwebchannel_js(), "qwebchannel.js missing"
        # the overlay shortcut's library is bundled (it loads its platform's code by name)
        if sys.platform.startswith("linux"):
            from Xlib import XK, display  # noqa: F401
            assert XK.string_to_keysym("F12"), "Xlib keysyms missing"
            from jeepney.io.blocking import open_dbus_connection  # noqa: F401  (Wayland: the portal)
        elif sys.platform == "darwin":
            hk = hotkeys.HotKey()                        # really register one (and let it go) with macOS
            hk.set("Ctrl+Alt+Shift+F12")
            hk.stop()
        else:
            from pynput import keyboard  # noqa: F401
        w = Window(url="about:blank")
        w.show()
        for _ in range(20):
            app.processEvents()
            time.sleep(0.05)
        w.quitting = True
        w.close()
        results.append(f"{APP_NAME} {APP_VERSION}")
        results.append("SELF-TEST OK")
        code = 0
    except Exception as e:  # noqa: BLE001
        results.append(f"SELF-TEST FAILED: {e!r}")
        code = 1
    out = os.environ.get("JACE_SELF_TEST_OUT")
    if out:  # windowed Windows builds have no stdout, so CI reads this file
        with open(out, "w") as f:
            f.write("\n".join(results))
    print("\n".join(results))
    return code


def should_run_setup(argv) -> bool:
    if "--install" in argv:
        return True
    # the downloaded AppImage / .app / .exe must be installed before it can be used
    return bool(desktop.setup_available() and not desktop.running_installed_copy())


def start_installed(installed: Path):
    """Start the freshly installed copy and remove the downloaded one."""
    if macinstall.running_bundle():
        macinstall.relaunch_installed(installed, macinstall.running_bundle())
    elif wininstall.running_exe():
        wininstall.relaunch(installed, delete_after=wininstall.running_exe())
    else:
        subprocess.Popen([str(installed)], start_new_session=True, env=updater.clean_env())
        downloaded = desktop.running_appimage()
        if downloaded and downloaded.resolve() != installed.resolve():
            downloaded.unlink(missing_ok=True)   # fine on Linux: the running image stays mounted


def close_splash():
    """Close the PyInstaller splash screen (only the Windows download has one)."""
    if "_PYI_SPLASH_IPC" not in os.environ:
        return
    try:
        import pyi_splash
        pyi_splash.close()
    except Exception:  # noqa: BLE001
        pass


def running_under_wine() -> bool:
    """Wine (Bottles, Lutris, Soda) has a wine_get_version export in its ntdll."""
    if sys.platform != "win32":
        return False
    import ctypes
    try:
        return hasattr(ctypes.WinDLL("ntdll"), "wine_get_version")
    except OSError:
        return False


def add_chromium_flags(*flags: str):
    os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = " ".join([os.environ.get("QTWEBENGINE_CHROMIUM_FLAGS", ""), *flags]).strip()


# Some graphics drivers can't show Chromium's GPU-composited page (seen: a new Intel chip with
# Mesa on GNOME/Wayland): the page loads but the window stays blank, and Qt logs this. Then the
# app remembers to composite in software on this computer and restarts once.
BLANK_PAGE_SIGN = "is not a Vulkan texture"


def setup_page_drawing() -> bool:
    """Call before the first web page. Returns True when it's watching for the blank-page problem."""
    # the page keeps running at full speed while the window is hidden in the tray or behind others:
    # Chromium otherwise slows a hidden page's timers, its live connection dropped, and messages and
    # calls that came in meanwhile made no sound
    add_chromium_flags("--disable-background-timer-throttling", "--disable-renderer-backgrounding",
                       "--disable-backgrounding-occluded-windows")
    if running_under_wine():
        # Chromium's GPU compositor crashes on Wine without a real GPU driver (seen with
        # Soda), so draw the web page in software there; real Windows keeps the GPU
        add_chromium_flags("--disable-gpu")
        return False
    if pref("software_compositing") or os.environ.get("JACE_SOFTWARE_COMPOSITING"):
        add_chromium_flags("--disable-gpu-compositing")
        return False
    if not sys.platform.startswith("linux"):
        return False
    from PySide6.QtCore import qInstallMessageHandler
    state = {"restarting": False, "previous": None}

    def handler(mode, context, message):
        if BLANK_PAGE_SIGN in message and not state["restarting"]:
            state["restarting"] = True
            set_pref("software_compositing", True)
            print("[Jace Social] this graphics driver can't show the page with GPU compositing: restarting in software", flush=True)
            QTimer.singleShot(0, restart_self)
        if state["previous"]:
            state["previous"](mode, context, message)
        else:
            sys.stderr.write(message + "\n")
    state["previous"] = qInstallMessageHandler(handler)
    return True


def restart_self():
    """Start this same app again in place (same process id, same arguments)."""
    args = sys.argv[1:] if getattr(sys, "frozen", False) else sys.orig_argv[1:]
    sys.stdout.flush()
    os.execv(sys.executable, [sys.executable, *args])


def main():
    close_splash()
    setup_page_drawing()
    argv = sys.argv[1:]
    if desktop.handle_cli(argv):
        return
    QApplication.setApplicationName("jace-social")
    QApplication.setApplicationDisplayName(APP_NAME)
    QApplication.setOrganizationName("jace-social")
    QApplication.setDesktopFileName(APP_ID)
    app = LinkApp(sys.argv)
    app.setStyle("Fusion")
    app.setWindowIcon(QIcon(str(desktop.ICON_SRC)))
    if "--self-test" in argv:
        sys.exit(self_test(app))
    if "--uninstall-gui" in argv:
        confirm_uninstall()
        return
    if "--apply-update" in argv:
        run_windows_update(argv)
        return
    if should_run_setup(argv):
        wiz = SetupWizard()
        if wiz.exec() != QDialog.DialogCode.Accepted:
            return                       # setup cancelled: nothing runs uninstalled
        installed = desktop.installed_path()
        if installed and not desktop.running_installed_copy():
            # we're the download: start the installed app (if asked) and quit
            if wiz.launch_after():
                start_installed(installed)
            elif desktop.running_appimage():
                desktop.running_appimage().unlink(missing_ok=True)
            elif wininstall.is_setup_build():
                wininstall.after_exit(f'del /f /q "{wininstall.running_exe()}"')
            return
        if not wiz.launch_after():
            return
    app.setQuitOnLastWindowClosed(False)

    # one copy at a time: a second launch brings the first window up (and hands over a
    # jacesocial:// link it was opened with); setup or an update asks it to quit
    # (see desktop.ask_running_copy_to_quit)
    link = next((a for a in argv if a.startswith(f"{URL_SCHEME}://")), None)
    key = desktop.SINGLE_INSTANCE_KEY
    probe = QLocalSocket()
    probe.connectToServer(key)
    if probe.waitForConnected(300):
        probe.write(f"open {link}".encode() if link else b"show")
        probe.waitForBytesWritten(300)
        # the open copy answers "ok"; one that doesn't is stuck (it hung while quitting), so stop it
        # and start fresh - before, Jace Social then couldn't be opened until a restart
        if (probe.waitForReadyRead(2000) and bytes(probe.readAll()).startswith(b"ok")) or not _stop_stuck_copy():
            return
        probe.abort()
        time.sleep(0.5)
    QLocalServer.removeServer(key)
    server = QLocalServer()
    server.listen(key)
    app.single_instance = server
    try:
        PID_FILE.parent.mkdir(parents=True, exist_ok=True)
        PID_FILE.write_text(str(os.getpid()))
    except OSError:
        pass
    if desktop.running_appimage() and desktop.running_installed_copy():
        desktop.remove_duplicate_entries()       # AppImageLauncher's "Jace Social (1)" from before 1.0.8

    try:
        win = Window()
    except Exception as e:  # noqa: BLE001
        QMessageBox.critical(None, APP_NAME, f"Jace Social couldn't start:\n{e}")
        raise

    def connected():
        sock = server.nextPendingConnection()
        if sock is None:
            return

        def got():
            msg = bytes(sock.readAll()).decode(errors="replace")
            if msg.startswith("quit"):
                win.quit()
                return
            sock.write(b"ok")                    # "I'm here and awake" (see the probe above)
            sock.flush()
            if msg.startswith("open "):
                win.open_link(msg[5:].strip())
            else:
                win.bring_up()
        sock.readyRead.connect(got)
        if sock.bytesAvailable():
            got()
    server.newConnection.connect(connected)
    app.window = win
    if "--hidden" not in argv:
        win.show()
    if link:
        win.open_link(link)
    for pending in app.pending_links:            # macOS can hand links over before the window exists
        win.open_link(pending)
    code = app.exec()
    _forget_pid()
    _exit_soon(5)                                # (in case shutting Qt down hangs after this)
    sys.exit(code)
