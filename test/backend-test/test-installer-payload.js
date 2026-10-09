const { describe, test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { checkPayload, isPeX64, isElf } = require("../../installer/lib/check-payload.js");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uac-payload-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let counter = 0;

/**
 * Bytes of a tiny fake PE file.
 * @param {number} machine Machine field, 0x8664 for x64 and 0x14c for 32-bit
 * @returns {Buffer} The bytes
 */
function fakePe(machine = 0x8664) {
    const buf = Buffer.alloc(0x100);
    buf.write("MZ", 0, "latin1");
    buf.writeUInt32LE(0x80, 0x3c);
    buf.write("PE\0\0", 0x80, "latin1");
    buf.writeUInt16LE(machine, 0x84);
    return buf;
}

/**
 * Bytes of a tiny fake ELF file.
 * @returns {Buffer} The bytes
 */
function fakeElf() {
    const buf = Buffer.alloc(0x40);
    buf.set([0x7f, 0x45, 0x4c, 0x46], 0);
    return buf;
}

/**
 * Write a file, making its folders.
 * @param {string} root Base folder
 * @param {string} rel Path relative to the base, with /
 * @param {string|Buffer} content What to write
 * @returns {void}
 */
function put(root, rel, content = "x") {
    const file = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

/**
 * Build a complete synthetic payload.
 * @param {"win32"|"linux"} platform Which layout
 * @returns {string} The folder
 */
function makeLayout(platform) {
    counter++;
    const root = path.join(tmpRoot, `${platform}-${counter}`);
    const native = platform === "win32" ? fakePe() : fakeElf();
    put(root, "app/server/server.js");
    put(root, "app/dist/index.html");
    put(root, "app/src/util.ts");
    put(root, "app/package.json", "{}");
    put(root, "app/uac-guard.cjs");
    put(root, "app/node_modules/tsx/package.json", "{}");
    put(root, "app/node_modules/better-sqlite3/build/Release/better_sqlite3.node", native);
    put(root, `app/node_modules/@esbuild/${platform}-x64/package.json`, "{}");
    put(root, `app/node_modules/oracledb/build/Release/oracledb-6.0.0-${platform}-x64.node`, native);
    if (platform === "win32") {
        put(root, "node/node.exe", fakePe());
        put(root, "tools/cli.js");
        put(root, "tools/data.js");
        put(root, "tools/service.js");
        put(root, "tools/Pindahkan-Data.cmd");
        put(root, "service/UptimeAccessControlT2.exe", fakePe());
        put(root, "service/service.xml.template");
        put(root, "LICENSES/node.txt");
    }
    return root;
}

describe("installer payload check", () => {
    test("a complete win32 layout is ok", () => {
        const result = checkPayload({ dir: makeLayout("win32"), platform: "win32" });
        assert.deepEqual(result, { ok: true, problems: [] });
    });

    test("a complete linux layout is ok", () => {
        const result = checkPayload({ dir: makeLayout("linux"), platform: "linux" });
        assert.deepEqual(result, { ok: true, problems: [] });
    });

    test("reports a Linux better_sqlite3.node in the win32 payload", () => {
        const dir = makeLayout("win32");
        put(dir, "app/node_modules/better-sqlite3/build/Release/better_sqlite3.node", fakeElf());
        const { ok, problems } = checkPayload({ dir, platform: "win32" });
        assert.equal(ok, false);
        assert.ok(
            problems.some((p) => p.startsWith("app/node_modules/better-sqlite3/build/Release/better_sqlite3.node"))
        );
        assert.ok(problems.every((p) => typeof p === "string" && p.length > 0));
    });

    test("reports a missing @esbuild/win32-x64", () => {
        const dir = makeLayout("win32");
        fs.rmSync(path.join(dir, "app", "node_modules", "@esbuild"), { recursive: true });
        const { ok, problems } = checkPayload({ dir, platform: "win32" });
        assert.equal(ok, false);
        assert.ok(problems.some((p) => p.includes("@esbuild/win32-x64")));
    });

    test("reports an esbuild of another platform", () => {
        const dir = makeLayout("win32");
        put(dir, "app/node_modules/@esbuild/linux-x64/package.json", "{}");
        const { problems } = checkPayload({ dir, platform: "win32" });
        assert.ok(problems.some((p) => p.includes("@esbuild/linux-x64")));
    });

    test("reports vite left in node_modules", () => {
        const dir = makeLayout("win32");
        for (const name of ["vite", "vue", "eslint", "@playwright/test"]) {
            put(dir, `app/node_modules/${name}/package.json`, "{}");
        }
        const { problems } = checkPayload({ dir, platform: "win32" });
        for (const name of ["vite", "vue", "eslint", "@playwright/test"]) {
            assert.ok(
                problems.some((p) => p.startsWith(`app/node_modules/${name}`)),
                name
            );
        }
    });

    test("reports a stray test folder", () => {
        const dir = makeLayout("win32");
        put(dir, "app/test/a.js");
        put(dir, "app/docs/a.md");
        put(dir, "app/data/kuma.db");
        const { problems } = checkPayload({ dir, platform: "win32" });
        for (const name of ["app/test", "app/docs", "app/data"]) {
            assert.ok(
                problems.some((p) => p.startsWith(name)),
                name
            );
        }
    });

    test("reports a missing uac-guard.cjs, which the service loads first", () => {
        for (const platform of ["win32", "linux"]) {
            const dir = makeLayout(platform);
            fs.rmSync(path.join(dir, "app", "uac-guard.cjs"));
            const { ok, problems } = checkPayload({ dir, platform });
            assert.equal(ok, false);
            assert.ok(
                problems.some((p) => p.startsWith("app/uac-guard.cjs")),
                platform
            );
        }
    });

    test("reports a missing node.exe", () => {
        const dir = makeLayout("win32");
        fs.rmSync(path.join(dir, "node", "node.exe"));
        const { ok, problems } = checkPayload({ dir, platform: "win32" });
        assert.equal(ok, false);
        assert.ok(problems.some((p) => p.startsWith("node/node.exe")));
    });

    test("reports missing files of the app, the tools and the service", () => {
        const dir = makeLayout("win32");
        for (const rel of [
            "app/server/server.js",
            "app/dist/index.html",
            "app/src/util.ts",
            "app/package.json",
            "tools/cli.js",
            "service/UptimeAccessControlT2.exe",
            "service/service.xml.template",
        ]) {
            fs.rmSync(path.join(dir, ...rel.split("/")));
        }
        fs.rmSync(path.join(dir, "app", "node_modules", "tsx"), { recursive: true });
        const { problems } = checkPayload({ dir, platform: "win32" });
        assert.ok(problems.length >= 8, problems.join("\n"));
    });

    test("reports a foreign .node file", () => {
        const dir = makeLayout("win32");
        put(dir, "app/node_modules/oracledb/build/Release/oracledb-6.0.0-linux-x64.node", fakeElf());
        put(dir, "app/node_modules/oracledb/build/Release/oracledb-6.0.0-darwin-arm64.node", "x");
        const { problems } = checkPayload({ dir, platform: "win32" });
        assert.ok(problems.some((p) => p.includes("oracledb-6.0.0-linux-x64.node")));
        assert.ok(problems.some((p) => p.includes("oracledb-6.0.0-darwin-arm64.node")));
        assert.ok(!problems.some((p) => p.includes("win32-x64.node")), "the win32 oracledb file stays allowed");
    });

    test("isPeX64 rejects a 32-bit PE and a text file", () => {
        counter++;
        const dir = path.join(tmpRoot, `bin-${counter}`);
        put(dir, "x64.exe", fakePe());
        put(dir, "x86.exe", fakePe(0x14c));
        put(dir, "text.exe", "ini bukan program");
        put(dir, "empty.exe", "");
        assert.equal(isPeX64(path.join(dir, "x64.exe")), true);
        assert.equal(isPeX64(path.join(dir, "x86.exe")), false);
        assert.equal(isPeX64(path.join(dir, "text.exe")), false);
        assert.equal(isPeX64(path.join(dir, "empty.exe")), false);
        assert.equal(isPeX64(path.join(dir, "tidak-ada.exe")), false);
        put(dir, "prog", fakeElf());
        assert.equal(isElf(path.join(dir, "prog")), true);
        assert.equal(isElf(path.join(dir, "text.exe")), false);
        assert.equal(isElf(path.join(dir, "x64.exe")), false);
    });
});
