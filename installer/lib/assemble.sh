#!/usr/bin/env bash
# Assemble the program folder.  Usage: assemble.sh <win32|linux> <output-folder>
#
# linux: app/ only, for the smoke test (the better_sqlite3.node of this machine's own tree is reused,
#        because building it needs downloads from github.com / nodejs.org).
# win32: app/ + node/ + service/ + tools/ + LICENSES/, every downloaded component checked against
#        installer/versions.json.  Set UAC_COMPONENTS_DIR to a folder with already downloaded component
#        files (same file names as in the URLs); they are still checked against the pinned SHA-256.
set -euo pipefail

PLATFORM="${1:?pakai: assemble.sh <win32|linux> <folder-keluaran>}"
OUT="${2:?pakai: assemble.sh <win32|linux> <folder-keluaran>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$(dirname "$HERE")"
ROOT="$(dirname "$INSTALLER")"
# shellcheck source=fetch.sh
source "$HERE/fetch.sh"

case "$PLATFORM" in win32 | linux) ;; *) echo "platform harus win32 atau linux" >&2; exit 64 ;; esac

json() { node -p "const v=require('$INSTALLER/versions.json'); $1"; }

get_component() { # <name> <outfile>
    local name="$1" out="$2" url sha base
    url="$(json "v.$name.url")"
    sha="$(json "v.$name.sha256")"
    base="$(basename "$url")"
    if [[ -n "${UAC_COMPONENTS_DIR:-}" && -f "$UAC_COMPONENTS_DIR/$base" ]]; then
        local actual
        actual="$(sha256sum "$UAC_COMPONENTS_DIR/$base" | cut -d' ' -f1)"
        if [[ ! "$sha" =~ ^[0-9a-fA-F]{64}$ || "${actual,,}" != "${sha,,}" ]]; then
            echo "berkas $base di UAC_COMPONENTS_DIR tidak cocok dengan SHA-256 terkunci ($sha)" >&2
            return 1
        fi
        cp "$UAC_COMPONENTS_DIR/$base" "$out"
    else
        fetch_verified "$url" "$sha" "$out"
    fi
}

rm -rf "$OUT"
mkdir -p "$OUT/app"

# 1. the application files
while IFS= read -r entry || [[ -n "$entry" ]]; do
    [[ -z "$entry" ]] && continue
    cp -r "$ROOT/$entry" "$OUT/app/$entry"
done < "$INSTALLER/app-files.txt"
cp "$ROOT/.npmrc" "$OUT/app/.npmrc"
cp "$INSTALLER/payload/uac-guard.cjs" "$OUT/app/uac-guard.cjs"

# 2. production dependencies (no install scripts: native parts are placed below)
if [[ "$PLATFORM" == "win32" ]]; then
    (cd "$OUT/app" && npm ci --omit=dev --ignore-scripts --os=win32 --cpu=x64 --no-audit --no-fund)
else
    (cd "$OUT/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
fi
rm -f "$OUT/app/.npmrc"

SQLITE_DIR="$OUT/app/node_modules/better-sqlite3"
mkdir -p "$SQLITE_DIR/build/Release"

if [[ "$PLATFORM" == "linux" ]]; then
    want="$(json "v.betterSqlite3.version")"
    have="$(node -p "require('$ROOT/node_modules/better-sqlite3/package.json').version")"
    [[ "$want" == "$have" ]] || { echo "better-sqlite3 $have di pohon pengembangan, terkunci $want" >&2; exit 1; }
    cp "$ROOT/node_modules/better-sqlite3/build/Release/better_sqlite3.node" "$SQLITE_DIR/build/Release/"
else
    WORK="$(mktemp -d)"
    trap 'rm -rf "$WORK"' EXIT
    mkdir -p "$OUT/node" "$OUT/service" "$OUT/tools" "$OUT/LICENSES"

    # Node.js: nodejs.org is not always reachable from the build machine, so node.exe comes from the npm package
    # node-win-x64 and is used only when it is byte for byte the official node.exe (SHA-256 of SHASUMS256.txt).
    NODE_SHA="$(json "v.node.sha256")"
    if [[ -n "${UAC_COMPONENTS_DIR:-}" && -f "$UAC_COMPONENTS_DIR/node.exe" ]]; then
        cp "$UAC_COMPONENTS_DIR/node.exe" "$OUT/node/node.exe"
    else
        NPM_INTEGRITY="$(json "v.node.npmIntegritySha512")"
        curl -fsSL --retry 3 -o "$WORK/node-npm.tgz" "$(json "v.node.npmTarball")"
        ACTUAL_INTEGRITY="sha512-$(openssl dgst -sha512 -binary "$WORK/node-npm.tgz" | base64 -w0)"
        [[ "$ACTUAL_INTEGRITY" == "$NPM_INTEGRITY" ]] || { echo "paket npm node-win-x64 tidak cocok dengan integritas terkunci" >&2; exit 1; }
        tar -xzf "$WORK/node-npm.tgz" -C "$WORK" "$(json "v.node.file")"
        cp "$WORK/$(json "v.node.file")" "$OUT/node/node.exe"
    fi
    if [[ ! "$NODE_SHA" =~ ^[0-9a-fA-F]{64}$ || "$(sha256sum "$OUT/node/node.exe" | cut -d' ' -f1)" != "${NODE_SHA,,}" ]]; then
        rm -f "$OUT/node/node.exe"
        echo "node.exe tidak sama dengan SHA-256 resmi nodejs.org ($NODE_SHA); berhenti" >&2
        exit 1
    fi
    if [[ -n "${UAC_COMPONENTS_DIR:-}" && -f "$UAC_COMPONENTS_DIR/node-LICENSE.txt" ]]; then
        cp "$UAC_COMPONENTS_DIR/node-LICENSE.txt" "$OUT/LICENSES/node-LICENSE.txt"
    else
        curl -fsSL --retry 3 -o "$OUT/LICENSES/node-LICENSE.txt" "$(json "v.node.licenseUrl")"
    fi
    grep -q "Node.js is licensed for use as follows" "$OUT/LICENSES/node-LICENSE.txt" || { echo "LICENSE Node.js tidak dikenali" >&2; exit 1; }

    get_component betterSqlite3 "$WORK/bs3.tar.gz"
    tar -xzf "$WORK/bs3.tar.gz" -C "$WORK"
    cp "$WORK/build/Release/better_sqlite3.node" "$SQLITE_DIR/build/Release/"

    get_component winsw "$OUT/service/UptimeAccessControlT2.exe"
    cp "$INSTALLER/service.xml.template" "$OUT/service/service.xml.template"

    cp "$INSTALLER/payload/tools/"{cli.js,data.js,service.js,Pindahkan-Data.cmd} "$OUT/tools/"
    cp "$SQLITE_DIR/LICENSE" "$OUT/LICENSES/better-sqlite3-LICENSE.txt"
    cat > "$OUT/LICENSES/README.txt" <<'TXT'
Uptime Access Control T2 dibangun dari Uptime Kuma (lisensi MIT, Louis Lam dan kontributor).
Komponen yang ikut dalam paket: Node.js (node-LICENSE.txt), better-sqlite3 (better-sqlite3-LICENSE.txt),
WinSW (lisensi MIT, https://github.com/winsw/winsw) dan paket npm produksi di app\node_modules,
masing-masing dengan lisensinya di foldernya.
TXT
fi

# oracledb ships binaries for every platform: keep only the ones of this platform
find "$OUT/app/node_modules" -name '*.node' ! -name 'better_sqlite3.node' ! -name "*-${PLATFORM}-x64.node" -delete

node -e "
const r = require('$INSTALLER/lib/check-payload.js').checkPayload({ dir: '$OUT', platform: '$PLATFORM' });
if (!r.ok) { console.error(r.problems.join('\n')); process.exit(1); }
console.log('checkPayload ok');
"
du -sh "$OUT"
