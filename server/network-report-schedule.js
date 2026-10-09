const fs = require("node:fs");
const path = require("node:path");
const { log } = require("../src/util");
const { buildMonthlyReport, previousMonth } = require("./network-report");

const SETTING_KEY = "networkReportSchedule";
const DEFAULT_SCHEDULE = { enabled: false, folder: "", hour: 7 };
const TICK_MS = 5 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const MAX_FOLDER_LENGTH = 500;

let timer = null;
let lastFailureAt = null;

/**
 * Check the settings of the automatic report.
 * @param {unknown} input Settings from the client
 * @returns {{enabled: boolean, folder: string, hour: number}} Clean settings; an empty folder means the default one
 * @throws {Error} When a value is not valid
 */
function normalizeSchedule(input) {
    if (!input || typeof input !== "object") {
        throw new Error("Pengaturan laporan tidak valid");
    }
    const hour = Number(input.hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        throw new Error("Jam harus antara 0 dan 23");
    }
    const folder = typeof input.folder === "string" ? input.folder.trim() : "";
    if (folder.length > MAX_FOLDER_LENGTH || folder.includes("\0")) {
        throw new Error("Folder tidak valid");
    }
    if (folder !== "" && !path.isAbsolute(folder)) {
        throw new Error("Tulis folder lengkap, misalnya D:\\Laporan atau /var/laporan");
    }
    return { enabled: input.enabled === true, folder, hour };
}

/**
 * The stored settings (defaults when nothing was saved yet).
 * @returns {Promise<{enabled: boolean, folder: string, hour: number}>} Settings
 */
async function getSchedule() {
    const { Settings } = require("./settings");
    const stored = await Settings.get(SETTING_KEY);
    return { ...DEFAULT_SCHEDULE, ...(stored && typeof stored === "object" ? stored : {}) };
}

/**
 * The folder where reports are saved.
 * @param {{folder: string}} schedule Settings
 * @param {string} dataDir Data folder of the server, where the default folder lives
 * @returns {string} Folder path
 */
function reportFolder(schedule, dataDir) {
    return schedule.folder !== "" ? schedule.folder : path.join(dataDir, "reports");
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
 * @throws {Error} When a value is not valid or the folder cannot be written to (only checked when the report is on)
 */
async function saveSchedule(input, dataDir) {
    const { Settings } = require("./settings");
    const schedule = normalizeSchedule(input);
    if (schedule.enabled) {
        assertWritable(reportFolder(schedule, dataDir));
    }
    await Settings.set(SETTING_KEY, schedule, "general");
    lastFailureAt = null;
    return schedule;
}

/**
 * Make the report of a month and save it in a folder. An existing file of the same month is replaced.
 * @param {object} params Parameters
 * @param {string} params.month Month as "YYYY-MM"
 * @param {string} params.folder Folder
 * @param {number} params.now Current time in ms (default: now)
 * @returns {Promise<{file: string, devices: number}>} Path of the file and how many devices it covers
 * @throws {Error} When the report cannot be made or the file cannot be written
 */
async function saveReport({ month, folder, now = Date.now() }) {
    const report = await buildMonthlyReport({ month, now });
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, report.filename);
    // Written next to its place and renamed, so a half written file is never left under the real name
    const temp = `${file}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temp, report.buffer);
        fs.renameSync(temp, file);
    } catch (e) {
        fs.rmSync(temp, { force: true });
        throw e;
    }
    return { file, devices: report.devices };
}

/**
 * Make the report of last month when it is due and not there yet.
 * It is due from the chosen hour of the first day of the month on; a server that was off then makes it when it starts.
 * @param {object} options Options
 * @param {string} options.dataDir Data folder of the server
 * @param {() => number} options.now Clock (tests)
 * @returns {Promise<string|null>} Path of the new file, or null when nothing was made
 */
async function tick({ dataDir, now = Date.now }) {
    const schedule = await getSchedule();
    if (!schedule.enabled) {
        return null;
    }
    const current = now();
    if (lastFailureAt !== null && current - lastFailureAt < RETRY_MS) {
        return null;
    }
    const startOfMonth = new Date(current);
    startOfMonth.setDate(1);
    startOfMonth.setHours(schedule.hour, 0, 0, 0);
    if (current < startOfMonth.getTime()) {
        return null;
    }
    const month = previousMonth(current);
    const folder = reportFolder(schedule, dataDir);
    const file = path.join(folder, `laporan-jaringan-${month}.xlsx`);
    if (fs.existsSync(file)) {
        return null;
    }
    try {
        const saved = await saveReport({ month, folder, now: current });
        lastFailureAt = null;
        log.info("network-scan", `Monthly report of ${month} saved: ${saved.file}`);
        return saved.file;
    } catch (e) {
        lastFailureAt = current;
        log.error("network-scan", `Monthly report of ${month} failed: ${e.message}`);
        return null;
    }
}

/**
 * Start the scheduler (checks every 5 minutes whether the report of last month is due).
 * @param {string} dataDir Data folder of the server
 * @returns {void}
 */
function startScheduler(dataDir) {
    if (timer) {
        return;
    }
    const run = () =>
        tick({ dataDir }).catch((e) => log.error("network-scan", `Monthly report check failed: ${e.message}`));
    timer = setInterval(run, TICK_MS);
    timer.unref?.();
    // Soon after the start too, for a server that was off on the first of the month
    const first = setTimeout(run, 60 * 1000);
    first.unref?.();
}

/**
 * Stop the scheduler.
 * @returns {void}
 */
function stopScheduler() {
    clearInterval(timer);
    timer = null;
    lastFailureAt = null;
}

module.exports = {
    normalizeSchedule,
    getSchedule,
    saveSchedule,
    reportFolder,
    saveReport,
    tick,
    startScheduler,
    stopScheduler,
};
