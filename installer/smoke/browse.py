"""Browser part of the Linux smoke test.

  browse.py setup <base-url> <creds-file> <ip>   create the admin, log in, scan <ip> (this machine's own address)
  browse.py check <base-url> <creds-file> <ip>   log in with the same admin and find the saved <ip>

Loopback (127.x) is never a scan target in this app, so the caller passes a real local address.

The credentials are random test values kept in <creds-file>; they are never printed.
"""
import json
import secrets
import sys

from playwright.sync_api import sync_playwright

mode, base, creds_path, target = sys.argv[1:5]


def load_or_make_creds():
    if mode == "setup":
        creds = {"user": "smoke" + secrets.token_hex(3), "password": "Aa1!" + secrets.token_urlsafe(12)}
        with open(creds_path, "w") as f:
            json.dump(creds, f)
        return creds
    with open(creds_path) as f:
        return json.load(f)


def main():
    creds = load_or_make_creds()
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1300, "height": 900})
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: errors.append(f"console: {m.text}") if m.type == "error" else None)

        page.goto(base + "/", wait_until="domcontentloaded")
        if mode == "setup":
            # a fresh database sends the browser to /setup once the socket connects
            page.wait_for_url(lambda url: "/setup" in url, timeout=60000)
            page.wait_for_selector("#repeat", timeout=60000)
            page.fill("#floatingInput", creds["user"])
            passwords = page.locator("input[type=password]")
            passwords.nth(0).fill(creds["password"])
            passwords.nth(1).fill(creds["password"])
            page.click("button[type=submit]")
        else:
            page.wait_for_selector("input[type=text]", timeout=60000)
            page.fill("input[type=text]", creds["user"])
            page.fill("input[type=password]", creds["password"])
            page.keyboard.press("Enter")
        # the form goes away once the admin is created / logged in
        page.wait_for_selector("input[type=password]", state="detached", timeout=60000)

        page.goto(base + "/network-scan", wait_until="domcontentloaded")
        page.wait_for_selector("#networkScanRanges", timeout=60000)
        if mode == "setup":
            page.fill("#networkScanRanges", target)
            page.locator("form", has=page.locator("#networkScanRanges")).locator("button[type=submit]").click()
        page.wait_for_selector(f"table.device-table tbody tr td:text-is('{target}')", timeout=90000)
        browser.close()

    # the page may log harmless network noise; only fail on application errors
    fatal = [e for e in errors if "MODULE_NOT_FOUND" in e or "pageerror" in e]
    if fatal:
        print("SMOKE FAIL browser errors:", fatal[:3])
        sys.exit(1)
    print(f"browse {mode} ok")


main()
