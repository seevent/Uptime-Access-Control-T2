#!/usr/bin/env bash
# Build the Windows installer on Linux.  Usage: installer/build.sh
# Stops at the first error.  Output: installer/out/UptimeAccessControlT2-Setup-<version>.exe (+ .sha256, BUILD-INFO.txt)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
OUT="$HERE/out"
STAGE="${UAC_STAGE_DIR:-$(mktemp -d)/stage-win}"

for tool in makensis node npm tar unzip sha256sum python3 7z; do
    command -v "$tool" > /dev/null || { echo "alat '$tool' tidak ditemukan" >&2; exit 1; }
done
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" || { echo "dibutuhkan Node 22 atau lebih baru" >&2; exit 1; }

VERSION="$(node -p "require('$ROOT/package.json').version")"
IFS='.-' read -r MAJOR MINOR PATCH _ <<< "$VERSION"
VERSION_NUM="${MAJOR}.${MINOR}.${PATCH}.0"
EXE="$OUT/UptimeAccessControlT2-Setup-$VERSION.exe"

mkdir -p "$OUT"
rm -f "$EXE" "$EXE.sha256" "$OUT/BUILD-INFO.txt"

echo "== merakit paket Windows ke $STAGE"
bash "$HERE/lib/assemble.sh" win32 "$STAGE"

echo "== mengompilasi installer"
makensis -V2 -WX "-DVERSION=$VERSION" "-DVERSION_NUM=$VERSION_NUM" "-DSTAGE=$STAGE" "-DOUTFILE=$EXE" "$HERE/installer.nsi"

echo "== memeriksa isi installer"
LISTING="$(7z l "$EXE")"
for must in node/node.exe app/server/server.js service/UptimeAccessControlT2.exe tools/cli.js app/node_modules/better-sqlite3/build/Release/better_sqlite3.node; do
    grep -qF "${must//\//\\}" <<< "$LISTING" || grep -qF "$must" <<< "$LISTING" || { echo "tidak ada di installer: $must" >&2; exit 1; }
done
if grep -qE '(^|[ /\\])app[/\\]test([/\\]|$)' <<< "$LISTING"; then
    echo "app/test ikut terbawa" >&2
    exit 1
fi

( cd "$OUT" && sha256sum "$(basename "$EXE")" > "$(basename "$EXE").sha256" )

json() { node -p "const v=require('$HERE/versions.json'); $1"; }
{
    echo "Uptime Access Control T2 - installer $VERSION"
    echo "Dibangun: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "Berkas: $(basename "$EXE")  ($(du -h "$EXE" | cut -f1))"
    echo "SHA-256 installer: $(cut -d' ' -f1 "$EXE.sha256")"
    echo "Node.js: $(json v.node.version)  sha256 $(json v.node.sha256)"
    echo "WinSW: $(json v.winsw.version)  sha256 $(json v.winsw.sha256)"
    echo "better-sqlite3: $(json v.betterSqlite3.version) ($(json v.betterSqlite3.target))  sha256 $(json v.betterSqlite3.sha256)"
    echo "package-lock.json sha256: $(sha256sum "$ROOT/package-lock.json" | cut -d' ' -f1)"
    echo "Jumlah berkas di paket: $(find "$STAGE" -type f | wc -l)"
    echo "Ukuran paket terurai: $(du -sh "$STAGE" | cut -f1)"
} > "$OUT/BUILD-INFO.txt"

echo "== selesai: $EXE"
cat "$OUT/BUILD-INFO.txt"
