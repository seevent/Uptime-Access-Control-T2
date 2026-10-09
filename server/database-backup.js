const fs = require("node:fs");
const path = require("node:path");
const { R } = require("redbean-node");
const { log } = require("../src/util");

const SETTING_KEY = "databaseBackup";
const DEFAULT_SETTINGS = { enabled: false, folder: "", intervalHours: 24, keep: 14 };
const FILE_PATTERN = /^kuma-backup-\d{8}-\d{6}\.db$/;
const TICK_MS = 5 * 60 * 1000;
const FIRST_CHECK_MS = 2 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const MAX_FOLDER_LENGTH = 500;
const MAX_INTERVAL_HOURS = 24 * 30;
const MAX_KEEP = 365;
// A little less than the interval, so that a check that is a few seconds early does not wait for the next one
const SLACK_MS = 60 * 1000;

let timer = null;
let firstTimer = null;
let lastFailureAt = null;
let running = false;

/**
 * Check the settings of the automatic backup.
 * @param {unknown} input Settings from the client
 * @returns {{enabled: boolean, folder: string, intervalHours: number, keep: number}} Clean settings; an empty folder means the default one
 * @throws {Error} When a value is not valid
 */
function normalizeSettings(input) {
    if (!input || typeof input !== "object") {
        throw new Error("Pengaturan backup tidak valid");
    }
    const intervalHours = Number(input.intervalHours);
    if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > MAX_INTERVAL_HOURS) {
        throw new Error(`Jeda backup harus 1 sampai ${MAX_INTERVAL_HOURS} jam`);
    }
    const keep = Number(input.keep);
    if (!Number.isInteger(keep) || keep < 1 || keep > MAX_KEEP) {
        throw new Error(`Jumlah backup yang disimpan harus 1 sampai ${MAX_KEEP}`);
    }
    const folder = typeof input.folder === "string" ? input.folder.trim() : "";
    if (folder.length > MAX_FOLDER_LENGTH || folder.includes("\0")) {
        throw new Error("Folder tidak valid");
    }
    if (folder !== "" && !path.isAbsolute(folder)) {
        throw new Error("Tulis folder lengkap, misalnya D:\\Backup atau /var/backup");
    }
    return { enabled: input.enabled === true, folder, intervalHours, keep };
}

/**
 * The stored settings (defaults when nothing was saved yet).
 * @returns {Promise<{enabled: boolean, folder: string, intervalHours: number, keep: number}>} Settings
 */
async function getSettings() {
    const { Settings } = require("./settings");
    const stored = await Settings.get(SETTING_KEY);
    return { ...DEFAULT_SETTINGS, ...(stored && typeof stored === "object" ? stored : {}) };
}

/**
 * The folder where backups are saved.
 * @param {{folder: string}} settings Settings
 * @param {string} dataDir Data folder of the server, where the default folder lives
 * @returns {string} Folder path
 */
function backupFolder(settings, dataDir) {
    return settings.folder !== "" ? settings.folder : path.join(dataDir, "backup");
}

/**
 * Make sure files can be written to a folder.
 * @param {string} folder Folder path
 * @returns {void}
 * @throws {Error} When the folder cannot be created or written to
 */
function assertWritable(folder) {
    try {
        fs.mkdirSync(folder, { recursive: true });
        const probe = path.join(folder, `.tulis-${process.pid}.tmp`);
        fs.writeFileSync(probe, "");
        fs.rmSync(probe, { force: true });
    } catch (e) {
        throw new Error(`Folder tidak bisa ditulis: ${e.message}`);
    }
}

/**
 * Validate and store the settings.
 * @param {unknown} input Settings from the client
 * @param {string} dataDir Data folder of the server
 * @returns {Promise<object>} The stored settings
 * @throws {Error} When a value is not valid or the folder cannot be written to (only checked when the backup is on)
 */
async function saveSettings(input, dataDir) {
    const { Settings } = require("./settings");
    const settings = normalizeSettings(input);
    if (settings.enabled) {
        assertWritable(backupFolder(settings, dataDir));
    }
    await Settings.set(SETTING_KEY, settings, "general");
    lastFailureAt = null;
    return settings;
}

/**
 * @param {Date} date Time
 * @returns {string} File name such as "kuma-backup-20261009-143005.db" (local time)
 */
function backupFileName(date) {
    const pad = (n, width = 2) => String(n).padStart(width, "0");
    return (
        `kuma-backup-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.db`
    );
}

/**
 * The backups in a folder.
 * @param {string} folder Folder path
 * @returns {{name: string, size: number, mtimeMs: number}[]} Backups made by this module, newest first (by name); empty when the folder is not there
 */
function listBackups(folder) {
    let names;
    try {
        names = fs.readdirSync(folder);
    } catch (e) {
        return [];
    }
    return names
        .filter((name) => FILE_PATTERN.test(name))
        .sort()
        .reverse()
        .map((name) => {
            const stat = fs.statSync(path.join(folder, name));
            return { name, size: stat.size, mtimeMs: stat.mtimeMs };
        });
}

/**
 * Delete the oldest backups so that only the newest ones stay. Only files with the name of a backup are touched.
 * @param {string} folder Folder path
 * @param {number} keep How many backups stay
 * @returns {string[]} Names of the files that were deleted
 */
function applyRetention(folder, keep) {
    const deleted = [];
    for (const backup of listBackups(folder).slice(keep)) {
        try {
            fs.rmSync(path.join(folder, backup.name));
            deleted.push(backup.name);
        } catch (e) {
            log.warn("db", `Could not delete the old backup ${backup.name}: ${e.message}`);
        }
    }
    return deleted;
}

/**
 * Copy the database to a file in a folder. SQLite writes a complete, consistent copy while the server keeps running.
 * @param {object} params Parameters
 * @param {string} params.folder Folder path
 * @param {number} params.now Current time in ms (default: now)
 * @param {string} params.dbType Type of the database (default: the one in use)
 * @returns {Promise<{file: string, name: string, size: number}>} The new file
 * @throws {Error} When the database is not SQLite or the copy fails
 */
async function createBackup({ folder, now = Date.now(), dbType }) {
    const type = dbType ?? require("./database").dbConfig?.type;
    if (type !== "sqlite") {
        throw new Error("Backup ini hanya untuk database SQLite");
    }
    if (running) {
        throw new Error("Backup sedang berjalan");
    }
    running = true;
    const name = backupFileName(new Date(now));
    const file = path.join(folder, name);
    const temp = `${file}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(folder, { recursive: true });
        if (fs.existsSync(file)) {
            throw new Error(`File ${name} sudah ada`);
        }
        // Written under a temporary name and renamed when it is complete, so a half written file never looks like a backup
        await R.exec("VACUUM INTO ?", [temp]);
        fs.renameSync(temp, file);
        return { file, name, size: fs.statSync(file).size };
    } catch (e) {
        fs.rmSync(temp, { force: true });
        throw e;
    } finally {
        running = false;
    }
}

/**
 * Make a backup when the last one is older than the interval, and delete the oldest ones.
 * @param {object} options Options
 * @param {string} options.dataDir Data folder of the server
 * @param {() => number} options.now Clock (tests)
 * @param {string} options.dbType Type of the database (tests)
 * @returns {Promise<string|null>} Path of the new file, or null when nothing was made
 */
async function tick({ dataDir, now = Date.now, dbType }) {
    const settings = await getSettings();
    if (!settings.enabled) {
        return null;
    }
    const current = now();
    if (lastFailureAt !== null && current - lastFailureAt < RETRY_MS) {
        return null;
    }
    const folder = backupFolder(settings, dataDir);
    const [newest] = listBackups(folder);
    if (newest && current - newest.mtimeMs < settings.intervalHours * 3600 * 1000 - SLACK_MS) {
        return null;
    }
    try {
        const made = await createBackup({ folder, now: current, dbType });
        lastFailureAt = null;
        const deleted = applyRetention(folder, settings.keep);
        log.info("db", `Database backup saved: ${made.file} (${deleted.length} old ones deleted)`);
        return made.file;
    } catch (e) {
        lastFailureAt = current;
        log.error("db", `Database backup failed: ${e.message}`);
        return null;
    }
}

/**
 * Start the scheduler (checks every 5 minutes whether a backup is due).
 * @param {string} dataDir Data folder of the server
 * @returns {void}
 */
function startScheduler(dataDir) {
    if (timer) {
        return;
    }
    const run = () => tick({ dataDir }).catch((e) => log.error("db", `Database backup check failed: ${e.message}`));
    timer = setInterval(run, TICK_MS);
    timer.unref?.();
    // Not at the very start, when the server is busy; soon after it, for a server that was off when a backup was due
    firstTimer = setTimeout(run, FIRST_CHECK_MS);
    firstTimer.unref?.();
}

/**
 * Stop the scheduler.
 * @returns {void}
 */
function stopScheduler() {
    clearInterval(timer);
    clearTimeout(firstTimer);
    timer = null;
    firstTimer = null;
    lastFailureAt = null;
}

module.exports = {
    FILE_PATTERN,
    normalizeSettings,
    getSettings,
    saveSettings,
    backupFolder,
    backupFileName,
    listBackups,
    applyRetention,
    createBackup,
    tick,
    startScheduler,
    stopScheduler,
};
