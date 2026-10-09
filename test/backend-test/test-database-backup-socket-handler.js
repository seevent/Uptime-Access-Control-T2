const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { databaseBackupSocketHandler } = require("../../server/socket-handlers/database-backup-socket-handler");

/**
 * @param {object} options Options
 * @param {boolean} options.loggedIn Whether the socket is logged in
 * @param {string} options.dbType Type of the database
 * @returns {{call: Function, calls: unknown[][]}} Harness
 */
function createHarness({ loggedIn = true, dbType = "sqlite" } = {}) {
    const handlers = new Map();
    const calls = [];
    const socket = { session: loggedIn ? {} : undefined, on: (event, fn) => handlers.set(event, fn) };
    let stored = { enabled: false, folder: "", intervalHours: 24, keep: 14 };
    const backup = {
        getSettings: async () => stored,
        saveSettings: async (input, dataDir) => {
            calls.push(["saveSettings", input, dataDir]);
            if (!input || input.keep > 365) {
                throw new Error("Jumlah backup yang disimpan harus 1 sampai 365");
            }
            stored = input;
            return stored;
        },
        backupFolder: (settings, dataDir) => settings.folder || `${dataDir}/backup`,
        listBackups: (folder) => {
            calls.push(["listBackups", folder]);
            return [{ name: "kuma-backup-20261009-080000.db", size: 1234, mtimeMs: 99 }];
        },
        createBackup: async (params) => {
            calls.push(["createBackup", params]);
            return { file: `${params.folder}/kuma-backup-20261009-090000.db`, size: 2048 };
        },
        applyRetention: (folder, keep) => {
            calls.push(["applyRetention", folder, keep]);
            return ["a", "b"];
        },
    };
    databaseBackupSocketHandler(socket, { backup, dataDir: "/data", dbType });
    return {
        calls,
        call: (event, payload) =>
            new Promise((resolve, reject) => {
                const handler = handlers.get(event);
                if (!handler) {
                    reject(new Error(`No handler for ${event}`));
                    return;
                }
                const noPayload = event === "getDatabaseBackup" || event === "runDatabaseBackup";
                Promise.resolve(noPayload ? handler(resolve) : handler(payload, resolve)).catch(reject);
            }),
    };
}

describe("database backup socket handler", () => {
    test("every event needs a login", async () => {
        const h = createHarness({ loggedIn: false });
        for (const event of ["getDatabaseBackup", "saveDatabaseBackup", "runDatabaseBackup"]) {
            const reply = await h.call(event, {});
            assert.equal(reply.ok, false, event);
        }
        assert.deepEqual(h.calls, []);
    });

    test("getDatabaseBackup gives the settings, the folder and the backups in it", async () => {
        const h = createHarness();
        assert.deepEqual(await h.call("getDatabaseBackup"), {
            ok: true,
            settings: { enabled: false, folder: "", intervalHours: 24, keep: 14 },
            folder: "/data/backup",
            supported: true,
            backups: [{ name: "kuma-backup-20261009-080000.db", size: 1234, time: 99 }],
        });
        assert.equal((await createHarness({ dbType: "mariadb" }).call("getDatabaseBackup")).supported, false);
    });

    test("saveDatabaseBackup stores the settings or reports why not", async () => {
        const h = createHarness();
        const settings = { enabled: true, folder: "/x", intervalHours: 6, keep: 3 };
        const reply = await h.call("saveDatabaseBackup", settings);
        assert.equal(reply.ok, true);
        assert.deepEqual(reply.settings, settings);
        assert.equal(reply.folder, "/x");
        assert.deepEqual(await h.call("saveDatabaseBackup", { ...settings, keep: 400 }), {
            ok: false,
            msg: "Jumlah backup yang disimpan harus 1 sampai 365",
        });
    });

    test("runDatabaseBackup makes a backup in the folder and deletes the oldest ones", async () => {
        const h = createHarness();
        const reply = await h.call("runDatabaseBackup");
        assert.equal(reply.ok, true);
        assert.equal(reply.file, "/data/backup/kuma-backup-20261009-090000.db");
        assert.equal(reply.size, 2048);
        assert.equal(reply.deleted, 2);
        assert.deepEqual(h.calls.slice(0, 2), [
            ["createBackup", { folder: "/data/backup" }],
            ["applyRetention", "/data/backup", 14],
        ]);
    });
});
