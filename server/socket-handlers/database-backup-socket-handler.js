const { checkLogin } = require("../util-server");

/**
 * Socket events of the automatic database backup.
 * @param {import("socket.io").Socket} socket Socket.io instance
 * @param {object} deps Replacements for tests
 * @param {object} deps.backup Replacement for server/database-backup
 * @param {string} deps.dataDir Data folder of the server
 * @param {string} deps.dbType Type of the database
 * @returns {void}
 */
module.exports.databaseBackupSocketHandler = (socket, deps = {}) => {
    const getBackup = () => deps.backup || require("../database-backup");
    const getDataDir = () => deps.dataDir || require("../database").dataDir;
    const getDbType = () => deps.dbType || require("../database").dbConfig?.type;

    /**
     * Wrap an event handler: login check, error to callback.
     * @param {string} event Event name
     * @param {boolean} hasPayload False for events the client sends with only a callback
     * @param {Function} fn Handler `(payload) => Promise<object>` returning the reply fields
     * @returns {void}
     */
    const register = (event, hasPayload, fn) => {
        socket.on(event, async (...args) => {
            const callback = args[args.length - 1];
            try {
                checkLogin(socket);
                callback({ ok: true, ...(await fn(hasPayload ? args[0] : undefined)) });
            } catch (e) {
                callback({ ok: false, msg: e.message });
            }
        });
    };

    /**
     * @param {object} settings Stored settings
     * @returns {object} The settings with the folder that is used and the backups in it
     */
    const describe = (settings) => {
        const backup = getBackup();
        const folder = backup.backupFolder(settings, getDataDir());
        return {
            settings,
            folder,
            supported: getDbType() === "sqlite",
            backups: backup.listBackups(folder).map((b) => ({ name: b.name, size: b.size, time: b.mtimeMs })),
        };
    };

    register("getDatabaseBackup", false, async () => describe(await getBackup().getSettings()));

    register("saveDatabaseBackup", true, async (payload) => {
        return describe(await getBackup().saveSettings(payload, getDataDir()));
    });

    register("runDatabaseBackup", false, async () => {
        const backup = getBackup();
        const settings = await backup.getSettings();
        const folder = backup.backupFolder(settings, getDataDir());
        const made = await backup.createBackup({ folder });
        const deleted = backup.applyRetention(folder, settings.keep);
        return { file: made.file, size: made.size, deleted: deleted.length, ...describe(settings) };
    });
};
