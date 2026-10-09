const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { appName } = require("../../src/util");

const ROOT = path.join(__dirname, "..", "..");
const NEW_NAME = "Uptime Access Control T2";
const OLD_NAME = "Uptime Kuma";
const EXTENSIONS = new Set([".vue", ".js", ".ts", ".mts", ".html", ".json"]);

/**
 * All source files under a directory.
 * @param {string} dir Directory, relative to the project root
 * @returns {string[]} Paths relative to the project root
 */
function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walk(rel));
        } else if (EXTENSIONS.has(path.extname(entry.name))) {
            out.push(rel);
        }
    }
    return out;
}

/**
 * Lines that still show the old name to a person. Comments and log lines are not shown in the app, and one error
 * message deliberately talks about the upstream project.
 * @returns {string[]} "file:line: text"
 */
function oldNameLines() {
    const files = [...walk("src").filter((f) => !f.startsWith(path.join("src", "lang"))), ...walk("server")];
    files.push(...walk("extra"), "index.html", path.join("public", "manifest.json"));
    const found = [];
    for (const file of files) {
        fs.readFileSync(path.join(ROOT, file), "utf8")
            .split(/\r?\n/)
            .forEach((line, i) => {
                const text = line.trim();
                const hidden =
                    /^(\/\/|\*|\/\*|<!--)/.test(text) ||
                    /\blog\.(debug|info|warn|error)\(/.test(text) ||
                    text.includes("isn’t an Uptime Kuma bug") ||
                    // Ids that other services match on: renaming them would orphan incidents that are already open.
                    /\b(dedup_key|entity_id):/.test(text);
                // `$t("Uptime Kuma")` looks the text up by that key; the shown text is the translation.
                if (text.replaceAll('$t("Uptime Kuma")', "").includes(OLD_NAME) && !hidden) {
                    found.push(`${file}:${i + 1}: ${text.slice(0, 100)}`);
                }
            });
    }
    return found;
}

describe("application name", () => {
    test("appName is the new name", () => {
        assert.equal(appName, NEW_NAME);
    });

    test("the browser tab and the web app manifest use the new name", () => {
        const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
        assert.match(html, new RegExp(`<title>${NEW_NAME}</title>`));
        const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "manifest.json"), "utf8"));
        assert.equal(manifest.name, NEW_NAME);
        assert.equal(manifest.short_name, NEW_NAME);
    });

    test("no English text shows the old name", () => {
        const en = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "lang", "en.json"), "utf8"));
        const old = Object.entries(en).filter(([, value]) => typeof value === "string" && value.includes(OLD_NAME));
        assert.deepEqual(
            old.map(([key]) => key),
            []
        );
        // The footer of a status page and the header still use the key "Uptime Kuma".
        assert.equal(en[OLD_NAME], NEW_NAME);
    });

    test("no page, component or server code shows the old name", () => {
        assert.deepEqual(oldNameLines(), []);
    });
});
