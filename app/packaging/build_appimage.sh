#!/usr/bin/env bash
# Build dist/JaceSocial-<version>-x86_64.AppImage
#   1. PyInstaller bundles Python + PySide6 + the app into a folder
#   2. we lay out an AppDir (AppRun, desktop file, icon, AppStream metadata)
#   3. appimagetool turns that into a single AppImage file
# Uses .venv/bin/python if there is one, else $PYTHON or python3 (with requirements.txt
# and pyinstaller installed).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
if [ -x .venv/bin/python ]; then PY="$ROOT/.venv/bin/python"; else PY="${PYTHON:-python3}"; fi
APP_ID="$("$PY" -c 'import jace_social_app as a; print(a.APP_ID)')"
VERSION="$("$PY" -c 'import jace_social_app as a; print(a.APP_VERSION)')"
BUILD="$ROOT/build/appimage"
APPDIR="$BUILD/AppDir"
TOOL="$ROOT/build/appimagetool"

"$PY" -m PyInstaller --version >/dev/null 2>&1 || "$PY" -m pip install -q pyinstaller
if [ ! -x "$TOOL" ]; then
  mkdir -p "$(dirname "$TOOL")"
  curl -sSL -o "$TOOL" https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
  chmod +x "$TOOL"
fi

echo "==> PyInstaller"
rm -rf "$BUILD"
"$PY" -m PyInstaller --noconfirm --clean --log-level WARN \
  --name jace-social --windowed \
  --distpath "$BUILD/dist" --workpath "$BUILD/work" --specpath "$BUILD" \
  --paths "$ROOT" \
  --add-data "$ROOT/assets:assets" \
  --hidden-import PySide6.QtWebEngineWidgets --hidden-import PySide6.QtWebEngineCore \
  --hidden-import PySide6.QtWebChannel \
  "$ROOT/packaging/entry.py"

# Qt >= 6.5 needs libxcb-cursor on X11 but many distros don't install it.
# Put it next to Qt's own libs (their RUNPATH is $ORIGIN) so it's always found.
QTLIB="$(find "$BUILD/dist/jace-social" -type d -path '*PySide6/Qt/lib' | head -1)"
XCBC="$(ldconfig -p | awk '/libxcb-cursor.so.0 /{print $NF; exit}')"
if [ -n "$XCBC" ]; then cp -L "$XCBC" "$QTLIB/libxcb-cursor.so.0"; else echo "warning: libxcb-cursor0 not bundled (install libxcb-cursor0)"; fi

# PyInstaller also copies system libraries from the build machine (GLib, GTK, X11/XCB,
# Mesa's helpers, libstdc++, NSS...). Every desktop has its own, and they have to match
# its graphics driver: a newer distro's Mesa loaded next to Ubuntu 22.04's libstdc++ or
# libgbm can't start OpenGL, and Qt aborts with "Could not initialize GLX". So drop them
# and use the computer's own, like the AppImage project's excludelist. Python's and Qt's
# own libraries stay, and so do the XCB extension libraries, which minimal distros may lack.
HOST_LIBS=(
  libstdc++.so.* libgcc_s.so.* libatomic.so.* libGL.so.* libGLX.so.* libGLdispatch.so.* libOpenGL.so.* \
  libEGL.so.* libdrm.so.* libgbm.so.* libxshmfence.so.* libepoxy.so.* libX11.so.* libX11-xcb.so.* libXau.so.* \
  libXdmcp.so.* libXext.so.* libXfixes.so.* libXi.so.* libXrender.so.* libXrandr.so.* libXcursor.so.* \
  libXinerama.so.* libXcomposite.so.* libXdamage.so.* libXtst.so.* libxkbfile.so.* libxcb.so.* \
  \
  libglib-2.0.so.* libgio-2.0.so.* libgobject-2.0.so.* libgmodule-2.0.so.* \
  libgthread-2.0.so.* libpcre.so.* libpcre2-8.so.* libmount.so.* libblkid.so.* libselinux.so.* libuuid.so.* \
  libgtk-3.so.* libgdk-3.so.* libgdk_pixbuf-2.0.so.* libatk-1.0.so.* libatk-bridge-2.0.so.* libatspi.so.* \
  libcairo.so.* libcairo-gobject.so.* libpango-1.0.so.* libpangocairo-1.0.so.* libpangoft2-1.0.so.* \
  libharfbuzz.so.* libfribidi.so.* libthai.so.* libdatrie.so.* libgraphite2.so.* libpixman-1.so.* \
  libpng16.so.* libjpeg.so.* libfontconfig.so.* libfreetype.so.* libbrotlicommon.so.* libbrotlidec.so.* \
  libexpat.so.* libz.so.* libdbus-1.so.* libsystemd.so.* libcap.so.* libgcrypt.so.* libgpg-error.so.* \
  liblz4.so.* libzstd.so.* libbsd.so.* libmd.so.* libasound.so.* libcups.so.* libavahi-client.so.* \
  libavahi-common.so.* libgnutls.so.* libnettle.so.* libhogweed.so.* libgmp.so.* libp11-kit.so.* libtasn1.so.* \
  libidn2.so.* libunistring.so.* libgssapi_krb5.so.* libkrb5.so.* libk5crypto.so.* libkrb5support.so.* \
  libcom_err.so.* libkeyutils.so.* libnss3.so libnssutil3.so libsmime3.so libnspr4.so libplc4.so libplds4.so \
  libfreebl3.so libfreeblpriv3.so
)
(cd "$BUILD/dist/jace-social/_internal" && for pat in "${HOST_LIBS[@]}"; do rm -f $pat; done)

echo "==> AppDir"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/applications" "$APPDIR/usr/share/metainfo" \
         "$APPDIR/usr/share/icons/hicolor/256x256/apps"
cp -a "$BUILD/dist/jace-social" "$APPDIR/usr/bin/"
cp packaging/AppRun "$APPDIR/AppRun"
chmod +x "$APPDIR/AppRun"
cp assets/icon.png "$APPDIR/$APP_ID.png"
cp assets/icon.png "$APPDIR/usr/share/icons/hicolor/256x256/apps/$APP_ID.png"
ln -sf "$APP_ID.png" "$APPDIR/.DirIcon"
# X-AppImage-Integrate=false: AppImageLauncher leaves us alone (we add our own menu entry;
# its own would show up as a second "Jace Social (1)"). Only in this embedded file.
cat > "$APPDIR/$APP_ID.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Jace Social
GenericName=Chat
Comment=Friends, chat, servers and voice calls, with Minecraft built in
Exec=jace-social %U
Icon=$APP_ID
Terminal=false
Categories=Network;Chat;InstantMessaging;
Keywords=minecraft;friends;chat;voice;call;servers;
X-AppImage-Integrate=false
DESKTOP
cp "$APPDIR/$APP_ID.desktop" "$APPDIR/usr/share/applications/"
"$PY" -c "from jace_social_app.desktop import metainfo; print(metainfo(), end='')" \
  > "$APPDIR/usr/share/metainfo/$APP_ID.metainfo.xml"

echo "==> appimagetool"
mkdir -p dist
OUT="$ROOT/dist/JaceSocial-$VERSION-x86_64.AppImage"
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$TOOL" --no-appstream "$APPDIR" "$OUT"
echo
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
echo "Run it once to open the setup wizard, or:  $OUT --install --yes"
