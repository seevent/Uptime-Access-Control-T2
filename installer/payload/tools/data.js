"use strict";

const fs = require("fs");
const path = require("path");

/** How recent a change of kuma.db-wal must be to count as "the old Kuma is still running", in ms. */
const WAL_FRESH_MS = 15000;

/** Tables whose row counts are reported (a table that does not exist counts as 0). */
const COUNTED_TABLES = ["monitor", "heartbeat", "network_device", "network_category"];

/**
 * Load better-sqlite3 from the installed layout (tools\ next to app\) first. A bare require would also search the
 * parent folders up to the drive root, where a local user could have planted a look-alike module.
 * @returns {Function} The Database class
 */
function loadSqlite() {
    const installed = path.join(__dirname, "..", "app", "node_modules", "better-sqlite3");
    if (fs.existsSync(installed)) {
        return require(installed);
    }
    return require("better-sqlite3");
}

/**
 * Write a date as YYYYMMDD-HHMMSS in local time.
 * @param {Date} date The date
 * @returns {string} The stamp
 */
function stamp(date) {
    const p = (n, width = 2) => String(n).padStart(width, "0");
    return (
        `${p(date.getFullYear(), 4)}${p(date.getMonth() + 1)}${p(date.getDate())}` +
        `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
    );
}

/**
 * Tell whether a path is an existing regular file.
 * @param {string} file The path
 * @returns {boolean} True for a file
 */
function isFile(file) {
    try {
        return fs.statSync(file).isFile();
    } catch (_) {
        return false;
    }
}

/**
 * Tell whether a path is an existing folder.
 * @param {string} dir The path
 * @returns {boolean} True for a folder
 */
function isDir(dir) {
    try {
        return fs.statSync(dir).isDirectory();
    } catch (_) {
        return false;
    }
}

/**
 * Pick a folder name that does not exist yet, adding -2, -3 ... when the name is taken.
 * @param {string} wanted The preferred path
 * @returns {string} A path that does not exist
 */
function freeDir(wanted) {
    let candidate = wanted;
    for (let n = 2; fs.existsSync(candidate); n++) {
        candidate = `${wanted}-${n}`;
    }
    return candidate;
}

/**
 * Copy a SQLite database, WAL contents included, with the SQLite backup API.
 * @param {string} from Source database file
 * @param {string} to Destination file
 * @returns {Promise<void>}
 */
async function copyDatabase(from, to) {
    const Sqlite = loadSqlite();
    const db = new Sqlite(from, { readonly: true, fileMustExist: true });
    try {
        await db.backup(to);
    } finally {
        db.close();
    }
}

/**
 * Count the rows of the tables we report, and check the file's integrity.
 * @param {string} file Database file
 * @returns {{counts: {[table: string]: number}, integrity: string}} Counts per table and the integrity_check result
 */
function inspectDatabase(file) {
    const Sqlite = loadSqlite();
    const db = new Sqlite(file, { readonly: true, fileMustExist: true });
    try {
        const counts = {};
        for (const table of COUNTED_TABLES) {
            const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
            counts[table] = exists ? db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n : 0;
        }
        const integrity = db
            .pragma("integrity_check")
            .map((row) => row.integrity_check)
            .join("; ");
        return { counts, integrity };
    } finally {
        db.close();
    }
}

/**
 * Tell whether two paths point at the same folder.
 * @param {string} a First path
 * @param {string} b Second path
 * @returns {boolean} True when they are the same folder
 */
function samePath(a, b) {
    const normalise = (p) => {
        let resolved = path.resolve(p);
        try {
            resolved = fs.realpathSync(resolved);
        } catch (_) {
            // the folder may not exist yet
        }
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    return normalise(a) === normalise(b);
}

/**
 * Save kuma.db (through the SQLite backup API), db-config.json and upload/ of a data folder into
 * <dataDir>/backup/<label>-<stamp>/. The backup folder itself is never copied.
 * @param {{dataDir: string, label: string, now?: function(): Date}} options What to save and how to name it
 * @returns {Promise<{backupDir: string|null}>} The new folder, or null when there was nothing to save
 */
async function backupData({ dataDir, label, now = () => new Date() }) {
    const dbFile = path.join(dataDir, "kuma.db");
    const configFile = path.join(dataDir, "db-config.json");
    const uploadDir = path.join(dataDir, "upload");
    const hasDb = isFile(dbFile);
    const hasConfig = isFile(configFile);
    const hasUpload = isDir(uploadDir);
    if (!hasDb && !hasConfig && !hasUpload) {
        return { backupDir: null };
    }

    const backupDir = freeDir(path.join(dataDir, "backup", `${label}-${stamp(now())}`));
    fs.mkdirSync(backupDir, { recursive: true });
    if (hasDb) {
        await copyDatabase(dbFile, path.join(backupDir, "kuma.db"));
    }
    if (hasConfig) {
        fs.copyFileSync(configFile, path.join(backupDir, "db-config.json"));
    }
    if (hasUpload) {
        fs.cpSync(uploadDir, path.join(backupDir, "upload"), { recursive: true });
    }
    return { backupDir };
}

/**
 * Put the destination back to what a backup holds (or empty it of the migrated files when there is no backup).
 * @param {string} dest Destination data folder
 * @param {string|null} backupDir The backup made before the copy, if any
 * @returns {void}
 */
function restoreDestination(dest, backupDir) {
    for (const leftover of ["kuma.db.new", "kuma.db-wal", "kuma.db-shm"]) {
        fs.rmSync(path.join(dest, leftover), { force: true });
    }
    for (const name of ["kuma.db", "db-config.json"]) {
        fs.rmSync(path.join(dest, name), { force: true });
        if (backupDir && isFile(path.join(backupDir, name))) {
            fs.copyFileSync(path.join(backupDir, name), path.join(dest, name));
        }
    }
    fs.rmSync(path.join(dest, "upload"), { recursive: true, force: true });
    if (backupDir && isDir(path.join(backupDir, "upload"))) {
        fs.cpSync(path.join(backupDir, "upload"), path.join(dest, "upload"), { recursive: true });
    }
}

/**
 * Move the data of an old Kuma folder into the data folder of the installed service.
 * The service is stopped first and always started again at the end.
 * @param {object} options What to move
 * @param {string} options.source Data folder of the old Kuma
 * @param {string} options.dest Data folder of the installed service
 * @param {{stop: function(): Promise<void>, start: function(): Promise<void>}} options.service The Windows service
 * @param {boolean} options.force Skip the check that the old Kuma is not running
 * @param {function(): Date} options.now Clock used to name the backup folder
 * @param {function(string): void} options.log Receives progress messages
 * @param {{afterCopy?: function(): Promise<void>}} options.hooks Test hooks
 * @returns {Promise<{backupDir: string|null, counts: {[table: string]: number}}>} Backup folder and row counts of the result
 */
async function migrate({ source, dest, service, force = false, now = () => new Date(), log = () => {}, hooks = {} }) {
    const sourceDb = path.join(source, "kuma.db");
    if (!isFile(sourceDb)) {
        throw new Error(`kuma.db tidak ditemukan di ${source}`);
    }
    if (samePath(source, dest)) {
        throw new Error("Folder sumber dan tujuan sama");
    }
    const wal = `${sourceDb}-wal`;
    // An empty -wal holds nothing and is also what a plain read of the source leaves behind.
    if (!force && isFile(wal) && fs.statSync(wal).size > 0 && Date.now() - fs.statSync(wal).mtimeMs < WAL_FRESH_MS) {
        throw new Error(
            "Kuma lama sepertinya masih berjalan (kuma.db-wal baru berubah). Hentikan dulu, atau gunakan --force"
        );
    }

    try {
        log("Menghentikan layanan ...");
        await service.stop();
        fs.mkdirSync(dest, { recursive: true });

        log("Mencadangkan data tujuan ...");
        const { backupDir } = await backupData({ dataDir: dest, label: "sebelum-pindah", now });
        const sourceInfo = inspectDatabase(sourceDb);

        try {
            log("Menyalin data ...");
            const destDb = path.join(dest, "kuma.db");
            const tempDb = path.join(dest, "kuma.db.new");
            fs.rmSync(tempDb, { force: true });
            await copyDatabase(sourceDb, tempDb);
            fs.rmSync(`${destDb}-wal`, { force: true });
            fs.rmSync(`${destDb}-shm`, { force: true });
            fs.renameSync(tempDb, destDb);
            if (isFile(path.join(source, "db-config.json"))) {
                fs.copyFileSync(path.join(source, "db-config.json"), path.join(dest, "db-config.json"));
            }
            for (const folder of ["upload", "screenshots"]) {
                if (isDir(path.join(source, folder))) {
                    fs.cpSync(path.join(source, folder), path.join(dest, folder), { recursive: true });
                }
            }

            if (hooks.afterCopy) {
                await hooks.afterCopy();
            }

            log("Memeriksa hasil salinan ...");
            const destInfo = inspectDatabase(destDb);
            const same = COUNTED_TABLES.every((table) => destInfo.counts[table] === sourceInfo.counts[table]);
            if (destInfo.integrity !== "ok" || !same) {
                throw new Error("Hasil salinan tidak cocok dengan sumber");
            }
            return { backupDir, counts: destInfo.counts };
        } catch (error) {
            log("Gagal, mengembalikan data tujuan seperti semula ...");
            restoreDestination(dest, backupDir);
            throw error;
        }
    } finally {
        log("Menyalakan layanan ...");
        await service.start();
    }
}

module.exports = { backupData, migrate, stamp, loadSqlite, WAL_FRESH_MS };
