const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { R } = require("redbean-node");
const BetterSqlite3 = require("better-sqlite3");
// better-auth must load before database (as in server.js): the two modules import each other.
require("../../server/better-auth");
const Database = require("../../server/database");
const { Settings } = require("../../server/settings");
const backup = require("../../server/database-backup");

const USER_ID = "test-user-1";
const HOUR = 3600 * 1000;

describe("database backup settings", () => {
    test("normalizeSettings checks the interval, the number to keep and the folder", () => {
        const ok = backup.normalizeSettings({
            enabled: true,
            folder: path.resolve("x"),
            intervalHours: "6",
            keep: "10",
        });
        assert.deepEqual(ok, { enabled: true, folder: path.resolve("x"), intervalHours: 6, keep: 10 });
        assert.deepEqual(backup.normalizeSettings({ intervalHours: 24, keep: 1 }), {
            enabled: false,
            folder: "",
            intervalHours: 24,
            keep: 1,
        });
        for (const bad of [0, 721, 1.5, "x", null]) {
            assert.throws(() => backup.normalizeSettings({ intervalHours: bad, keep: 5 }), /Jeda backup/);
        }
        for (const bad of [0, 366, 2.5, "x", undefined]) {
            assert.throws(() => backup.normalizeSettings({ intervalHours: 24, keep: bad }), /backup yang disimpan/);
        }
        assert.throws(
            () => backup.normalizeSettings({ intervalHours: 24, keep: 5, folder: "relatif" }),
            /folder lengkap/
        );
        assert.throws(() => backup.normalizeSettings(null), /tidak valid/);
        assert.equal(backup.backupFolder({ folder: "" }, "/data"), path.join("/data", "backup"));
        assert.equal(backup.backupFolder({ folder: "/x" }, "/data"), "/x");
    });

    test("backupFileName uses the local time and matches the pattern", () => {
        const name = backup.backupFileName(new Date(2026, 9, 9, 14, 3, 5));
        assert.equal(name, "kuma-backup-20261009-140305.db");
        assert.ok(backup.FILE_PATTERN.test(name));
        for (const other of [
            "kuma.db",
            "kuma-backup-20261009-140305.db.tmp",
            "x-kuma-backup-20261009-140305.db",
            "kuma-backup-2026-10-09.db",
        ]) {
            assert.ok(!backup.FILE_PATTERN.test(other), other);
        }
    });
});

describe("database backup (database)", () => {
    let dataDir;
    let tmp;

    before(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-backup-test-"));
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-backup-out-"));
        Database.initDataDir({ "data-dir": dataDir + path.sep });
        Database.writeDBConfig({ type: "sqlite" });
        await Database.connect(true);
        await Database.patch();
        await R.exec(
            "INSERT INTO better_auth_user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Tester', 'tester@example.com', 1, '2026-10-07 10:00:00', '2026-10-07 10:00:00')",
            [USER_ID]
        );
        await R.exec(
            "INSERT INTO monitor (id, name, type, hostname, interval, retry_interval, user_id, active) VALUES (1, 'Kamera Lobi', 'ping', '10.0.0.1', 60, 60, ?, 1)",
            [USER_ID]
        );
    });

    after(async () => {
        backup.stopScheduler();
        Settings.stopCacheCleaner();
        await Database.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    /**
     * @returns {string} A new empty folder
     */
    const newFolder = () => fs.mkdtempSync(path.join(tmp, "f-"));

    /**
     * @param {string} file Path of a database file
     * @returns {{check: string, monitors: string[]}} Result of an integrity check and the monitor names in the file
     */
    function inspect(file) {
        const db = new BetterSqlite3(file, { readonly: true });
        try {
            return {
                check: db.pragma("integrity_check", { simple: true }),
                monitors: db
                    .prepare("SELECT name FROM monitor ORDER BY id")
                    .all()
                    .map((r) => r.name),
            };
        } finally {
            db.close();
        }
    }

    test("createBackup writes a complete copy that opens and holds the data, without leftovers", async () => {
        const folder = path.join(newFolder(), "sub");
        const made = await backup.createBackup({ folder, now: new Date(2026, 9, 9, 14, 3, 5).getTime() });
        assert.equal(made.name, "kuma-backup-20261009-140305.db");
        assert.equal(made.file, path.join(folder, made.name));
        assert.ok(made.size > 0);
        assert.deepEqual(inspect(made.file), { check: "ok", monitors: ["Kamera Lobi"] });
        assert.deepEqual(fs.readdirSync(folder), [made.name]);
    });

    test("createBackup refuses a database that is not SQLite, a file that is there, and a second backup at once", async () => {
        const folder = newFolder();
        await assert.rejects(() => backup.createBackup({ folder, dbType: "mariadb" }), /hanya untuk database SQLite/);

        const now = new Date(2026, 9, 9, 15, 0, 0).getTime();
        const first = backup.createBackup({ folder, now });
        await assert.rejects(() => backup.createBackup({ folder, now: now + 1000 }), /sedang berjalan/);
        await first;
        await assert.rejects(() => backup.createBackup({ folder, now }), /sudah ada/);
        assert.deepEqual(fs.readdirSync(folder), ["kuma-backup-20261009-150000.db"]);
    });

    test("listBackups lists only backups, newest first, and an empty list for a missing folder", async () => {
        const folder = newFolder();
        for (const name of [
            "kuma-backup-20261001-000000.db",
            "kuma-backup-20261003-000000.db",
            "kuma-backup-20261002-000000.db",
            "catatan.txt",
            "kuma-backup-20261004-000000.db.tmp",
        ]) {
            fs.writeFileSync(path.join(folder, name), "x");
        }
        assert.deepEqual(
            backup.listBackups(folder).map((b) => b.name),
            ["kuma-backup-20261003-000000.db", "kuma-backup-20261002-000000.db", "kuma-backup-20261001-000000.db"]
        );
        assert.deepEqual(backup.listBackups(path.join(folder, "tidak-ada")), []);
    });

    test("applyRetention keeps the newest ones and touches nothing else", async () => {
        const folder = newFolder();
        for (const day of ["01", "02", "03", "04"]) {
            fs.writeFileSync(path.join(folder, `kuma-backup-202610${day}-000000.db`), "x");
        }
        fs.writeFileSync(path.join(folder, "kuma.db"), "x");
        fs.writeFileSync(path.join(folder, "catatan.txt"), "x");
        assert.deepEqual(backup.applyRetention(folder, 2), [
            "kuma-backup-20261002-000000.db",
            "kuma-backup-20261001-000000.db",
        ]);
        assert.deepEqual(fs.readdirSync(folder).sort(), [
            "catatan.txt",
            "kuma-backup-20261003-000000.db",
            "kuma-backup-20261004-000000.db",
            "kuma.db",
        ]);
        assert.deepEqual(backup.applyRetention(folder, 5), []);
    });

    test("saveSettings stores the settings and refuses a folder that cannot be written", async () => {
        const folder = path.join(newFolder(), "saved");
        const saved = await backup.saveSettings({ enabled: true, folder, intervalHours: 12, keep: 7 }, dataDir);
        assert.deepEqual(saved, { enabled: true, folder, intervalHours: 12, keep: 7 });
        assert.deepEqual(await backup.getSettings(), saved);
        assert.ok(fs.existsSync(folder));

        const blocker = path.join(newFolder(), "blocker");
        fs.writeFileSync(blocker, "x");
        await assert.rejects(
            () =>
                backup.saveSettings(
                    { enabled: true, folder: path.join(blocker, "sub"), intervalHours: 12, keep: 7 },
                    dataDir
                ),
            /Folder tidak bisa ditulis/
        );
    });

    describe("the automatic backup", () => {
        let folder;
        beforeEach(async () => {
            backup.stopScheduler();
            folder = newFolder();
            await backup.saveSettings({ enabled: true, folder, intervalHours: 24, keep: 2 }, dataDir);
        });

        test("makes a backup when there is none, waits for the interval, then makes the next and deletes the oldest", async () => {
            // The files get the real time as their modification time, so the clock of the test starts from now
            const base = Date.now();
            const first = await backup.tick({ dataDir, now: () => base });
            assert.match(path.basename(first), backup.FILE_PATTERN);
            assert.equal(await backup.tick({ dataDir, now: () => base + 23 * HOUR }), null);
            const second = await backup.tick({ dataDir, now: () => base + 24 * HOUR });
            assert.ok(second);
            const third = await backup.tick({ dataDir, now: () => base + 49 * HOUR });
            assert.ok(third);
            assert.deepEqual(
                backup.listBackups(folder).map((b) => path.join(folder, b.name)),
                [third, second]
            );
        });

        test("does nothing when it is switched off", async () => {
            await backup.saveSettings({ enabled: false, folder, intervalHours: 24, keep: 2 }, dataDir);
            assert.equal(await backup.tick({ dataDir, now: () => Date.now() }), null);
            assert.deepEqual(fs.readdirSync(folder), []);
        });

        test("after a failure it waits half an hour before it tries again", async () => {
            const blocker = path.join(newFolder(), "blocker");
            fs.writeFileSync(blocker, "x");
            const broken = path.join(blocker, "sub");
            await Settings.set(
                "databaseBackup",
                { enabled: true, folder: broken, intervalHours: 24, keep: 2 },
                "general"
            );
            const t = new Date(2026, 9, 9, 8, 0, 0).getTime();
            assert.equal(await backup.tick({ dataDir, now: () => t }), null);

            fs.rmSync(blocker);
            assert.equal(await backup.tick({ dataDir, now: () => t + 10 * 60 * 1000 }), null);
            assert.ok(!fs.existsSync(broken));
            const made = await backup.tick({ dataDir, now: () => t + 31 * 60 * 1000 });
            assert.equal(path.dirname(made), broken);
        });
    });
});
