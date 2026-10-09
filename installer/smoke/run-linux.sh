#!/usr/bin/env bash
# Smoke test of the assembled production folder on Linux.  Usage: run-linux.sh <assembled-folder>
# Needs node, python3 with playwright and its Chromium.  Prints "SMOKE OK" only when everything passed.
set -euo pipefail

STAGE="$(cd "${1:?pakai: run-linux.sh <folder-rakitan>}" && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$(dirname "$HERE")/payload/tools/cli.js"
PORT=3115
URL="http://127.0.0.1:$PORT/"
TMP="$(mktemp -d)"
# the scanner never lists loopback, so scan this machine's own address
TARGET_IP="$(hostname -I | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' | head -1)"
[[ -n "$TARGET_IP" ]] || { echo "SMOKE FAIL: tidak ada alamat IPv4 non-loopback untuk dipindai" >&2; exit 1; }
SERVER_PID=""

stop_server() {
    if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill -TERM "$SERVER_PID" 2>/dev/null || true
        for _ in $(seq 1 40); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.5; done
        kill -KILL "$SERVER_PID" 2>/dev/null || true
    fi
    SERVER_PID=""
}
trap 'stop_server; rm -rf "$TMP"' EXIT

start_server() { # <data-dir> <log>
    (cd "$STAGE/app" && NODE_ENV=production DATA_DIR="$1" UPTIME_KUMA_PORT=$PORT UPTIME_KUMA_HOST=127.0.0.1 \
        UPTIME_KUMA_DB_TYPE=sqlite KUMA_SKIP_HIBP=1 exec node --require ./uac-guard.cjs --import=tsx server/server.js > "$2" 2>&1) &
    SERVER_PID=$!
    if ! node "$CLI" wait --url "$URL" --timeout 90; then
        echo "SMOKE FAIL: server tidak menjawab; ekor log:" >&2
        tail -20 "$2" >&2
        exit 1
    fi
}

check_log() { # <log>
    if grep -q "MODULE_NOT_FOUND\|Cannot find module" "$1"; then
        echo "SMOKE FAIL: modul hilang di log $1" >&2
        grep -m3 "MODULE_NOT_FOUND\|Cannot find module" "$1" >&2
        exit 1
    fi
}

echo "== fase 1: pasang bersih, buat admin, pindai alamat sendiri ($TARGET_IP)"
mkdir -p "$TMP/data1"
start_server "$TMP/data1" "$TMP/server1.log"
python3 -I "$HERE/browse.py" setup "${URL%/}" "$TMP/creds.json" "$TARGET_IP"
stop_server
check_log "$TMP/server1.log"

echo "== fase 2: pindahkan data dengan cli.js migrate, nyalakan lagi, admin dan perangkat lama harus ada"
UAC_FAKE_SERVICE=1 node "$CLI" migrate --source "$TMP/data1" --data "$TMP/data2" --yes
start_server "$TMP/data2" "$TMP/server2.log"
python3 -I "$HERE/browse.py" check "${URL%/}" "$TMP/creds.json" "$TARGET_IP"
stop_server
check_log "$TMP/server2.log"

echo "SMOKE OK"
