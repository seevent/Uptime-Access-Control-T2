#!/usr/bin/env bash
# Download a file and keep it only when its SHA-256 matches the pinned value.
# Usage: source fetch.sh; fetch_verified <url> <sha256> <output-file>

fetch_verified() {
    local url="$1" expected="$2" out="$3"
    if [[ ! "$expected" =~ ^[0-9a-fA-F]{64}$ ]]; then
        echo "fetch_verified: SHA-256 untuk $url belum dikunci (nilai: '$expected'), berhenti" >&2
        return 2
    fi
    mkdir -p "$(dirname "$out")"
    if ! curl -fsSL --retry 3 -o "$out" "$url"; then
        rm -f "$out"
        echo "fetch_verified: gagal mengunduh $url" >&2
        return 3
    fi
    local actual
    actual="$(sha256sum "$out" | cut -d' ' -f1)"
    if [[ "${actual,,}" != "${expected,,}" ]]; then
        rm -f "$out"
        echo "fetch_verified: SHA-256 tidak cocok untuk $url (diharapkan $expected, didapat $actual); berkas dihapus" >&2
        return 1
    fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    fetch_verified "$@"
fi
