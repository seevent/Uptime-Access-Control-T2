const { describe, test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const DATA_JS = path.join(__dirname, "..", "..", "installer", "payload", "tools", "data.js");
const { backupData, migrate } = require(DATA_JS);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uac-data-"));
const openDbs = [];
let counter = 0;

after(() => {
    for (const db of openDbs) {
        try {
            db.close();
        } catch (_) {
            // already closed
        }
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Make a fresh folder under the temp root.
 * @param {string} name Prefix of the folder name
 * @returns {string} The folder path
 */
function newDir(name) {
    counter++;
    const dir = path.join(tmpRoot, `${name}-${counter}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Create a Kuma-like data folder with a WAL database whose connection stays open.
 * @param {string} dir Data folder
 * @param {{monitors?: number, heartbeats?: number, devices?: number, categories?: number, minimal?: boolean, walOnly?: number}} opts What to put in
 * @returns {Database} The open connection (keeps the -wal file alive)
 */
function makeSource(dir, opts = {}) {
    const { monitors = 0, heartbeats = 0, devices = 0, categories = 0, minimal = false, walOnly = 0 } = opts;
    const db = new Database(path.join(dir, "kuma.db"));
    openDbs.push(db);
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    db.exec("CREATE TABLE monitor (id INTEGER PRIMARY KEY, name TEXT)");
    if (!minimal) {
        db.exec("CREATE TABLE heartbeat (id INTEGER PRIMARY KEY, monitor_id INTEGER)");
        db.exec("CREATE TABLE network_device (id INTEGER PRIMARY KEY, ip TEXT)");
        db.exec("CREATE TABLE network_category (id INTEGER PRIMARY KEY, name TEXT)");
    }
    const fill = (table, column, count, prefix) => {
        for (let i = 0; i < count; i++) {
            db.prepare(`INSERT INTO ${table} (${column}) VALUES (?)`).run(`${prefix}${i}`);
        }
    };
    fill("monitor", "name", monitors, "m");
    if (!minimal) {
        fill("heartbeat", "monitor_id", heartbeats, "");
        fill("network_device", "ip", devices, "10.0.0.");
        fill("network_category", "name", categories, "c");
    }
    if (walOnly > 0) {
        db.pragma("wal_checkpoint(TRUNCATE)");
        fill("monitor", "name", walOnly, "wal");
    }
    return db;
}

/**
 * Make the -wal file look old, so the "still running" check does not trigger.
 * @param {string} dir Data folder
 * @returns {void}
 */
function ageWal(dir) {
    const wal = path.join(dir, "kuma.db-wal");
    if (fs.existsSync(wal)) {
        const old = new Date(Date.now() - 120000);
        fs.utimesSync(wal, old, old);
    }
}

/**
 * Count rows of a table in a database file.
 * @param {string} file Database file
 * @param {string} table Table name
 * @returns {number} The row count
 */
function countRows(file, table) {
    const db = new Database(file, { readonly: true });
    try {
        return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    } finally {
        db.close();
    }
}

/**
 * A service double that records what was asked of it.
 * @param {string[]} calls Where to record "stop" and "start"
 * @returns {{stop: Function, start: Function}} The double
 */
function fakeService(calls = []) {
    return {
        stop: async () => {
            calls.push("stop");
        },
        start: async () => {
            calls.push("start");
        },
    };
}

describe("installer data tools: loading better-sqlite3", () => {
    test("loadSqlite takes better-sqlite3 from the installed app folder before any parent folder", () => {
        // C:\\node_modules can be created by any local user, so it must never win over app\\node_modules
        const root = newDir("layout");
        const stub = (dir, who) => {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "index.js"), `module.exports = { who: "${who}" };`);
        };
        stub(path.join(root, "node_modules", "better-sqlite3"), "decoy");
        stub(path.join(root, "install", "app", "node_modules", "better-sqlite3"), "app");
        fs.mkdirSync(path.join(root, "install", "tools"), { recursive: true });
        fs.copyFileSync(DATA_JS, path.join(root, "install", "tools", "data.js"));

        const copy = require(path.join(root, "install", "tools", "data.js"));
        assert.equal(copy.loadSqlite().who, "app");
    });
});

describe("installer data tools", () => {
    test("backupData names the folder label-stamp and keeps kuma.db, db-config.json and upload", async () => {
        const dataDir = newDir("data");
        makeSource(dataDir, { monitors: 2, walOnly: 1 });
        fs.writeFileSync(path.join(dataDir, "db-config.json"), '{"type":"sqlite"}');
        fs.mkdirSync(path.join(dataDir, "upload"));
        fs.writeFileSync(path.join(dataDir, "upload", "logo.png"), "png");

        const { backupDir } = await backupData({
            dataDir,
            label: "sebelum-upgrade",
            now: () => new Date(2026, 9, 8, 13, 5, 9),
        });

        assert.equal(path.basename(backupDir), "sebelum-upgrade-20261008-130509");
        assert.equal(path.dirname(backupDir), path.join(dataDir, "backup"));
        assert.equal(fs.readFileSync(path.join(backupDir, "db-config.json"), "utf8"), '{"type":"sqlite"}');
        assert.equal(fs.readFileSync(path.join(backupDir, "upload", "logo.png"), "utf8"), "png");
        assert.equal(countRows(path.join(backupDir, "kuma.db"), "monitor"), 3);
    });

    test("backupData returns null when the data folder has nothing to save", async () => {
        const dataDir = newDir("empty");
        const result = await backupData({ dataDir, label: "sebelum-upgrade" });
        assert.deepEqual(result, { backupDir: null });
        assert.equal(fs.existsSync(path.join(dataDir, "backup")), false);

        const missing = await backupData({ dataDir: path.join(dataDir, "tidak-ada"), label: "x" });
        assert.deepEqual(missing, { backupDir: null });
    });

    test("migrate copies rows that only exist in the -wal file", async () => {
        const source = newDir("src");
        const dest = newDir("dst");
        makeSource(source, { monitors: 2, walOnly: 3 });
        const wal = path.join(source, "kuma.db-wal");
        assert.ok(fs.statSync(wal).size > 0, "the test needs a non-empty -wal");
        assert.equal(countRows(path.join(source, "kuma.db"), "monitor"), 5, "readers see the wal rows too");
        ageWal(source);

        const result = await migrate({ source, dest, service: fakeService() });

        assert.equal(result.counts.monitor, 5);
        assert.equal(countRows(path.join(dest, "kuma.db"), "monitor"), 5);
    });

    test("migrate copies db-config.json with its authSecret, upload and screenshots", async () => {
        const source = newDir("src");
        const dest = newDir("dst");
        makeSource(source, { monitors: 1 });
        ageWal(source);
        fs.writeFileSync(path.join(source, "db-config.json"), '{"type":"sqlite","authSecret":"rahasia-123"}');
        fs.mkdirSync(path.join(source, "upload"));
        fs.writeFileSync(path.join(source, "upload", "a.txt"), "A");
        fs.mkdirSync(path.join(source, "screenshots", "sub"), { recursive: true });
        fs.writeFileSync(path.join(source, "screenshots", "sub", "s.png"), "S");

        await migrate({ source, dest, service: fakeService() });

        const config = JSON.parse(fs.readFileSync(path.join(dest, "db-config.json"), "utf8"));
        assert.equal(config.authSecret, "rahasia-123");
        assert.equal(fs.readFileSync(path.join(dest, "upload", "a.txt"), "utf8"), "A");
        assert.equal(fs.readFileSync(path.join(dest, "screenshots", "sub", "s.png"), "utf8"), "S");
    });

    test("migrate returns the counts", async () => {
        const source = newDir("src");
        const dest = newDir("dst");
        makeSource(source, { monitors: 3, heartbeats: 5, devices: 2, categories: 2 });
        ageWal(source);

        const result = await migrate({ source, dest, service: fakeService() });

        assert.deepEqual(result.counts, { monitor: 3, heartbeat: 5, network_device: 2, network_category: 2 });
    });

    test("migrate works on a database without heartbeat and network tables", async () => {
        const source = newDir("src");
        const dest = newDir("dst");
        makeSource(source, { monitors: 1, minimal: true });
        ageWal(source);

        const result = await migrate({ source, dest, service: fakeService() });

        assert.deepEqual(result.counts, { monitor: 1, heartbeat: 0, network_device: 0, network_category: 0 });
    });

    test("migrate refuses the same folder, also spelled with a trailing /.", async () => {
        const source = newDir("src");
        makeSource(source, { monitors: 1 });
        ageWal(source);
        const calls = [];

        await assert.rejects(
            migrate({ source, dest: source, service: fakeService(calls) }),
            /Folder sumber dan tujuan sama/
        );
        await assert.rejects(
            migrate({ source, dest: source + path.sep + ".", service: fakeService(calls) }),
            /Folder sumber dan tujuan sama/
        );
        assert.deepEqual(calls, [], "the service is not touched when validation fails");
    });

    test("migrate refuses a source without kuma.db", async () => {
        const source = newDir("src");
        const dest = newDir("dst");
        const calls = [];

        await assert.rejects(
            migrate({ source, dest, service: fakeService(calls) }),
            new Error(`kuma.db tidak ditemukan di ${source}`)
        );
        assert.deepEqual(calls, []);
    });

    test("migrate refuses a fresh -wal unless force is set", async () => {
        const source = newDir("src");
        const dest = newDir("dst");
        makeSource(source, { monitors: 1, walOnly: 1 });
        // the -wal was just written, so it is younger than 15 seconds
        const calls = [];

        await assert.rejects(
            migrate({ source, dest, service: fakeService(calls) }),
            /Kuma lama sepertinya masih berjalan \(kuma\.db-wal baru berubah\)\. Hentikan dulu, atau gunakan --force/
        );
        assert.deepEqual(calls, []);
        assert.equal(fs.existsSync(path.join(dest, "kuma.db")), false);

        const result = await migrate({ source, dest, service: fakeService(), force: true });
        assert.equal(result.counts.monitor, 2);
    });

    test("migrate ignores an empty fresh -wal, which a plain read leaves behind", async () => {
        const source = newDir("src");
        const dest = newDir("dst");
        makeSource(source, { monitors: 2 }).close();
        fs.writeFileSync(path.join(source, "kuma.db-wal"), "");

        const first = await migrate({ source, dest, service: fakeService() });
        assert.equal(first.counts.monitor, 2);
        // the run above has just read the source, so a -wal of 0 bytes is there with a new time
        const second = await migrate({ source, dest, service: fakeService() });
        assert.equal(second.counts.monitor, 2);
    });

    test("migrate backs up the existing destination before replacing it", async () => {
        const source = newDir("src");
        const dest = newDir("dst");
        makeSource(source, { monitors: 3 });
        ageWal(source);
        makeSource(dest, { monitors: 1 }).close();

        const result = await migrate({
            source,
            dest,
            service: fakeService(),
            now: () => new Date(2026, 9, 8, 14, 0, 0),
        });

        assert.equal(path.basename(result.backupDir), "sebelum-pindah-20261008-140000");
        assert.equal(countRows(path.join(result.backupDir, "kuma.db"), "monitor"), 1);
        assert.equal(countRows(path.join(dest, "kuma.db"), "monitor"), 3);
    });

    test("migrate twice in a row works and leaves two different backup folders", async () => {
        const source = newDir("src");
        const dest = newDir("dst");
        makeSource(source, { monitors: 2 });
        ageWal(source);
        const times = [new Date(2026, 9, 8, 15, 0, 0), new Date(2026, 9, 8, 15, 0, 1)];
        let first;

        for (let i = 0; i < 2; i++) {
            const result = await migrate({ source, dest, service: fakeService(), now: () => times[i] });
            assert.equal(result.counts.monitor, 2);
            if (i === 0) {
                first = result;
            } else {
                assert.ok(result.backupDir, "the second run backs up what the first run put there");
                assert.notEqual(result.backupDir, first.backupDir === null ? "" : first.backupDir);
            }
        }

        const backups = fs.readdirSync(path.join(dest, "backup"));
        assert.ok(backups.every((name) => name.startsWith("sebelum-pindah-")));
        assert.ok(backups.includes("sebelum-pindah-20261008-150001"));
    });

    test("migrate stops the service first and starts it last, also when it fails", async () => {
        const source = newDir("src");
        const dest = newDir("dst");
        makeSource(source, { monitors: 1 });
        ageWal(source);
        const calls = [];

        await migrate({ source, dest, service: fakeService(calls) });
        assert.deepEqual(calls, ["stop", "start"]);

        calls.length = 0;
        await assert.rejects(
            migrate({
                source,
                dest,
                service: fakeService(calls),
                hooks: {
                    afterCopy: async () => {
                        calls.push("copied");
                        throw new Error("gagal di tengah");
                    },
                },
            }),
            /gagal di tengah/
        );
        assert.deepEqual(calls, ["stop", "copied", "start"]);
    });

    test("migrate puts the old destination back when the copy fails halfway", async () => {
        const source = newDir("src");
        const dest = newDir("dst");
        makeSource(source, { monitors: 4 });
        ageWal(source);
        fs.writeFileSync(path.join(source, "db-config.json"), '{"from":"source"}');
        makeSource(dest, { monitors: 1 }).close();
        fs.writeFileSync(path.join(dest, "db-config.json"), '{"from":"dest"}');

        await assert.rejects(
            migrate({
                source,
                dest,
                service: fakeService(),
                hooks: {
                    afterCopy: async () => {
                        throw new Error("gagal di tengah");
                    },
                },
            }),
            /gagal di tengah/
        );

        assert.equal(countRows(path.join(dest, "kuma.db"), "monitor"), 1);
        assert.equal(fs.readFileSync(path.join(dest, "db-config.json"), "utf8"), '{"from":"dest"}');
        assert.equal(fs.existsSync(path.join(dest, "kuma.db.new")), false);
    });

    test("migrate refuses a copy whose integrity_check or counts differ", async () => {
        const source = newDir("src");
        const dest = newDir("dst");
        makeSource(source, { monitors: 2, heartbeats: 2 });
        ageWal(source);
        makeSource(dest, { monitors: 1 }).close();

        await assert.rejects(
            migrate({
                source,
                dest,
                service: fakeService(),
                hooks: {
                    afterCopy: async () => {
                        const copy = new Database(path.join(dest, "kuma.db"));
                        copy.prepare("INSERT INTO monitor (name) VALUES ('tambahan')").run();
                        copy.close();
                    },
                },
            }),
            /Hasil salinan tidak cocok dengan sumber/
        );

        // the failed copy is rolled back to what the destination held before
        assert.equal(countRows(path.join(dest, "kuma.db"), "monitor"), 1);
    });
});
