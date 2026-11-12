#!/usr/bin/env bash
#
# Sestaví NovelForge pro fyzický iPhone (generic/platform=iOS, iPhoneOS SDK),
# bez podpisu, a zabalí výsledek do NovelForge.ipa + NovelForge-Signulous.zip.
#
# Podpis řeší až Signulous – zde se NEPOUŽÍVÁ Apple Developer účet, certifikáty
# ani provisioning profiles.
#
# Použití:
#   bash scripts/build-ios-unsigned.sh
#
# Volitelné proměnné prostředí:
#   SCHEME          (výchozí: App)
#   CONFIGURATION   (výchozí: Release)
#   BUILD_DIR       (výchozí: ./build)
#   ARTIFACTS_DIR   (výchozí: ./artifacts)
#   BUNDLE_ID       (výchozí: com.novelforge.app) – pouze pro kontrolu výsledku
#   BUILD_NUMBER    (výchozí: 1)  – CFBundleVersion
#   MARKETING_VERSION (výchozí: 1.0.0) – CFBundleShortVersionString
#
set -euo pipefail

SCHEME="${SCHEME:-App}"
CONFIGURATION="${CONFIGURATION:-Release}"
BUILD_DIR="${BUILD_DIR:-build}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-artifacts}"
EXPECTED_BUNDLE_ID="${BUNDLE_ID:-com.novelforge.app}"
BUILD_NUMBER="${BUILD_NUMBER:-1}"
MARKETING_VERSION="${MARKETING_VERSION:-1.0.0}"

WORKSPACE="ios/App/App.xcworkspace"
DERIVED_DATA="${BUILD_DIR}/derived"
APP_PATH="${DERIVED_DATA}/Build/Products/${CONFIGURATION}-iphoneos/App.app"
PAYLOAD_DIR="${BUILD_DIR}/Payload"
IPA_PATH="${ARTIFACTS_DIR}/NovelForge.ipa"
ZIP_PATH="${ARTIFACTS_DIR}/NovelForge-Signulous.zip"

log()  { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[1;32m  ✔ %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- preconditions
log "Kontrola prostředí"
command -v xcodebuild >/dev/null 2>&1 || fail "xcodebuild nenalezen (spusťte na macOS s Xcode)."
command -v zip       >/dev/null 2>&1 || fail "zip nenalezen."
command -v unzip     >/dev/null 2>&1 || fail "unzip nenalezen."
[ -d "$WORKSPACE" ] || fail "Chybí $WORKSPACE – spusťte 'npm run ios:sync' a 'pod install'."
[ -d "ios/App/App/public" ] || fail "Chybí ios/App/App/public – webová část nebyla zkopírována (npm run build && npm run ios:sync)."
[ -d "ios/App/Pods" ] || fail "Chybí ios/App/Pods – spusťte 'pod install' v adresáři ios/App."
xcodebuild -version
ok "Prostředí v pořádku"

# ---------------------------------------------------------------- clean outputs
log "Úklid předchozích výstupů"
rm -rf "$DERIVED_DATA" "$PAYLOAD_DIR" "$ARTIFACTS_DIR"
mkdir -p "$DERIVED_DATA" "$PAYLOAD_DIR" "$ARTIFACTS_DIR"
ok "Připraveno: $DERIVED_DATA, $PAYLOAD_DIR, $ARTIFACTS_DIR"

# ---------------------------------------------------------------- xcodebuild
log "Sestavení $SCHEME ($CONFIGURATION) pro generic/platform=iOS (iPhoneOS SDK)"
set -o pipefail
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -sdk iphoneos \
  -destination "generic/platform=iOS" \
  -derivedDataPath "$DERIVED_DATA" \
  -allowProvisioningUpdates=NO \
  MARKETING_VERSION="$MARKETING_VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGN_ENTITLEMENTS="" \
  EXPANDED_CODE_SIGN_IDENTITY="" \
  PROVISIONING_PROFILE_SPECIFIER="" \
  DEVELOPMENT_TEAM="" \
  build 2>&1 | tee "${BUILD_DIR}/xcodebuild.log"

[ -d "$APP_PATH" ] || fail "Build nedokončil očekávanou aplikaci: $APP_PATH"
ok "Sestaveno: $APP_PATH"

# ---------------------------------------------------------------- verify .app
log "Kontrola sestavené aplikace"
INFO_PLIST="${APP_PATH}/Info.plist"
[ -f "$INFO_PLIST" ] || fail "Chybí Info.plist v $APP_PATH (build neobsahuje metadata)."

plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$INFO_PLIST" 2>/dev/null || true; }

BUNDLE_ID_ACTUAL="$(plist CFBundleIdentifier)"
EXECUTABLE_NAME="$(plist CFBundleExecutable)"
APP_VERSION="$(plist CFBundleShortVersionString)"
APP_BUILD="$(plist CFBundleVersion)"
MIN_OS="$(plist MinimumOSVersion)"

[ -n "$BUNDLE_ID_ACTUAL" ] || fail "Info.plist neobsahuje CFBundleIdentifier."
[ "$BUNDLE_ID_ACTUAL" = "$EXPECTED_BUNDLE_ID" ] || fail "Bundle ID nesouhlasí: '$BUNDLE_ID_ACTUAL' != '$EXPECTED_BUNDLE_ID'."
[ -n "$EXECUTABLE_NAME" ] || fail "Info.plist neobsahuje CFBundleExecutable."

BINARY_PATH="${APP_PATH}/${EXECUTABLE_NAME}"
[ -f "$BINARY_PATH" ] || fail "Chybí spustitelný binární soubor: $BINARY_PATH"
[ -x "$BINARY_PATH" ] || fail "Binární soubor není spustitelný: $BINARY_PATH"

ARCHS="$(lipo -archs "$BINARY_PATH" 2>/dev/null || file "$BINARY_PATH")"
echo "$ARCHS" | grep -q "arm64" || fail "Binárka neobsahuje arm64 (simulátorový build?): $ARCHS"
echo "$ARCHS" | grep -q "x86_64"     && fail "Binárka obsahuje x86_64 – jde o simulátorový build: $ARCHS"
echo "$ARCHS" | grep -q "i386"       && fail "Binárka obsahuje i386 – jde o simulátorový build: $ARCHS"

# Platform check: iOS device binaries are Mach-O for platform IOS (LC_BUILD_VERSION platform 2)
PLATFORM_INFO="$(vtool -show-build "$BINARY_PATH" 2>/dev/null || true)"
if echo "$PLATFORM_INFO" | grep -qi "platform IOS"; then
  ok "Mach-O platforma: IOS (fyzické zařízení)"
elif echo "$PLATFORM_INFO" | grep -qi "platform IOSSIMULATOR"; then
  fail "Binárka je postavena pro iOS Simulator, nikoli pro zařízení."
else
  echo "  (vtool neposkytl platformu, pokračuji s kontrolou architektur)"
fi

WEB_ASSETS="${APP_PATH}/public/index.html"
[ -f "$WEB_ASSETS" ] || fail "V aplikaci chybí webové prostředky (public/index.html)."
ok "Webové prostředky: public/index.html"

CAP_CONFIG="${APP_PATH}/capacitor.config.json"
[ -f "$CAP_CONFIG" ] || fail "V aplikaci chybí capacitor.config.json."
grep -q "WebRenderer" "$CAP_CONFIG" || fail "capacitor.config.json neobsahuje registraci WebRenderer pluginu (spusťte scripts/patch-ios-plugins.mjs)."

FRAMEWORK_COUNT="$(find "${APP_PATH}/Frameworks" -maxdepth 1 -name '*.framework' 2>/dev/null | wc -l | tr -d ' ')"
[ "${FRAMEWORK_COUNT:-0}" -gt 0 ] || fail "Aplikace neobsahuje žádné frameworky (Capacitor/Pods se neembedovaly)."
# Pod názvy = názvy frameworků, které musí být v Payload/App.app/Frameworks.
for required in Capacitor CapacitorCordova CapacitorCommunitySqlite CapacitorApp CapacitorFilesystem CapacitorShare; do
  find "${APP_PATH}/Frameworks" -maxdepth 1 -name "${required}.framework" | grep -q . \
    || fail "Chybí framework ${required}.framework v ${APP_PATH}/Frameworks"
done
ok "Frameworky: ${FRAMEWORK_COUNT} (Capacitor, CapacitorCordova, CapacitorCommunitySqlite a další pluginy přítomny)"

SWIFT_LIBS="$(find "${APP_PATH}" -maxdepth 2 -name 'libswift*.dylib' 2>/dev/null | wc -l | tr -d ' ')"
[ "${SWIFT_LIBS:-0}" -gt 0 ] || echo "  (poznámka: Swift runtime knihovny nejsou přibaleny – Xcode 26 je dodává systém, nevadí)"

[ -f "${APP_PATH}/PkgInfo" ] || printf 'APPL????' > "${APP_PATH}/PkgInfo"

printf '  Bundle ID:    %s\n' "$BUNDLE_ID_ACTUAL"
printf '  Verze:        %s (%s)\n' "$APP_VERSION" "$APP_BUILD"
printf '  Min. iOS:     %s\n' "$MIN_OS"
printf '  Architektury: %s\n' "$ARCHS"
printf '  Executable:   %s\n' "$EXECUTABLE_NAME"
ok "Aplikace prošla kontrolou"

# ---------------------------------------------------------------- build the IPA
log "Balení unsigned IPA (Payload/App.app -> NovelForge.ipa)"
# Absolutní cesty – zip se spouští po `cd`, relativní cesta by se rozbila.
IPA_ABS="$(cd "$(dirname "$IPA_PATH")" && pwd)/$(basename "$IPA_PATH")"
ZIP_ABS="$(cd "$(dirname "$ZIP_PATH")" && pwd)/$(basename "$ZIP_PATH")"
rm -rf "$PAYLOAD_DIR"
mkdir -p "$PAYLOAD_DIR/Payload"
# ditto zachová resource fork / permissions / symlinky uvnitř .app
ditto "$APP_PATH" "${PAYLOAD_DIR}/Payload/App.app"
[ -d "${PAYLOAD_DIR}/Payload/App.app" ] || fail "Kopírování App.app do Payload selhalo."

( cd "$PAYLOAD_DIR" && zip -qry "$IPA_ABS" Payload )
[ -s "$IPA_ABS" ] || fail "IPA nebyla vytvořena nebo je prázdná: $IPA_PATH"
ok "Vytvořeno: $IPA_PATH ($(du -h "$IPA_PATH" | cut -f1))"

# ---------------------------------------------------------------- verify the IPA
log "Ověření integrity IPA"
unzip -tq "$IPA_PATH" >/dev/null || fail "IPA není platný ZIP archiv."
unzip -l "$IPA_PATH" | grep -q "Payload/App.app/Info.plist" || fail "IPA neobsahuje Payload/App.app/Info.plist."
unzip -l "$IPA_PATH" | grep -qE "Payload/App.app/${EXECUTABLE_NAME}\$" || fail "IPA neobsahuje spustitelný binární soubor Payload/App.app/${EXECUTABLE_NAME}."
unzip -l "$IPA_PATH" | grep -q "Payload/App.app/public/index.html" || fail "IPA neobsahuje webové prostředky."
ok "IPA je platný archiv se všemi potřebnými soubory"

# ---------------------------------------------------------------- ZIP for Signulous
log "Vytváření NovelForge-Signulous.zip"
rm -f "$ZIP_PATH"
# ZIP obsahuje právě jeden soubor: NovelForge.ipa (bez vnořených cest)
( cd "$(dirname "$IPA_ABS")" && zip -q -X "$ZIP_ABS" "$(basename "$IPA_ABS")" )
[ -s "$ZIP_ABS" ] || fail "ZIP nebyl vytvořen nebo je prázdný: $ZIP_PATH"
ok "Vytvořeno: $ZIP_PATH ($(du -h "$ZIP_PATH" | cut -f1))"

# ---------------------------------------------------------------- verify the ZIP
log "Ověření integrity ZIPu"
unzip -tq "$ZIP_PATH" >/dev/null || fail "NovelForge-Signulous.zip je poškozený."
ZIP_ENTRIES="$(unzip -Z1 "$ZIP_PATH")"
[ "$ZIP_ENTRIES" = "NovelForge.ipa" ] || fail "ZIP musí obsahovat právě NovelForge.ipa, obsahuje: $ZIP_ENTRIES"

TMP_EXTRACT="${BUILD_DIR}/zip-verify"
rm -rf "$TMP_EXTRACT"
mkdir -p "$TMP_EXTRACT"
unzip -q "$ZIP_PATH" -d "$TMP_EXTRACT"
[ -s "${TMP_EXTRACT}/NovelForge.ipa" ] || fail "IPA uvnitř ZIPu chybí nebo je prázdná."
(cd "$TMP_EXTRACT" && unzip -tq NovelForge.ipa >/dev/null) || fail "IPA uvnitř ZIPu je poškozená."
cmp -s "$IPA_PATH" "${TMP_EXTRACT}/NovelForge.ipa" || fail "IPA uvnitř ZIPu se liší od zdrojové IPA."
rm -rf "$TMP_EXTRACT"
ok "ZIP obsahuje platnou a kompletní IPA"

# ---------------------------------------------------------------- artifact summary
log "Hotovo – artefakty"
printf '  %-34s %10s\n' "Soubor" "Velikost"
printf '  %-34s %10s\n' "------" "--------"
printf '  %-34s %10s\n' "$IPA_PATH" "$(du -h "$IPA_PATH" | cut -f1)"
printf '  %-34s %10s\n' "$ZIP_PATH" "$(du -h "$ZIP_PATH" | cut -f1)"
printf '\n  Bundle ID:    %s\n  Verze:        %s (%s)\n  Architektury: %s\n' \
  "$BUNDLE_ID_ACTUAL" "$APP_VERSION" "$APP_BUILD" "$ARCHS"

{
  echo "bundleId=${BUNDLE_ID_ACTUAL}"
  echo "version=${APP_VERSION}"
  echo "build=${APP_BUILD}"
  echo "archs=${ARCHS}"
  echo "ipa=${IPA_PATH}"
  echo "zip=${ZIP_PATH}"
} > "${ARTIFACTS_DIR}/build-info.txt"

printf '\n\033[1;32mVšechny kontroly prošly. ZIP je připraven ke stažení v Codemagic Artifacts.\033[0m\n'
