#!/bin/bash
# Give an unsigned iPhone app an ad-hoc ("fake") signature with its entitlements, so it installs on
# jailbroken iPhones with AppSync, which otherwise refuse it ("missing application-identifier
# entitlement") - and so the Keychain (where the sign-in is kept) works there. Sideloadly and
# AltStore / SideStore sign it again with your Apple ID, replacing this.
#   native-test/fakesign.sh "<path>/Jace Social.app" <bundle id>
set -euo pipefail
APP="$1" ID="$2" TEAM="JACESOCIAL"
ENT=$(mktemp -t ent).plist
cat > "$ENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>application-identifier</key>
	<string>$TEAM.$ID</string>
	<key>com.apple.developer.team-identifier</key>
	<string>$TEAM</string>
	<key>keychain-access-groups</key>
	<array>
		<string>$TEAM.$ID</string>
	</array>
	<key>get-task-allow</key>
	<false/>
</dict>
</plist>
PLIST
# the libraries inside first (WebRTC), then the app with its entitlements
for fw in "$APP"/Frameworks/*.framework "$APP"/Frameworks/*.dylib; do
  [ -e "$fw" ] && codesign --force --sign - --timestamp=none "$fw"
done
codesign --force --sign - --timestamp=none --entitlements "$ENT" "$APP"
codesign -d --entitlements - "$APP" 2>/dev/null | grep -q "application-identifier" || { echo "::error::no entitlements in the signature"; exit 1; }
codesign --verify --deep "$APP" && echo "Fake-signed $ID (for AppSync)"
