const { R } = require("redbean-node");
const { log } = require("../src/util");
const runner = require("./network-scan-runner");

const SETTING_KEY = "networkScanSchedule";
const TICK_MS = 30 * 1000;
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 1440;
const MAX_RANGES = 20;
const MAX_NOTIFICATIONS = 50;
const DEFAULT_SCHEDULE = { enabled: false, intervalMinutes: 60, ranges: [], notificationIDList: [] };

let timer = null;
let lastRunAt = null;

/**
 * Check a schedule from the client and turn it into what is stored.
 * @param {unknown} input Schedule from the client
 * @param {object} scanner Scanner (needs expandRanges)
 * @returns {{enabled: boolean, intervalMinutes: number, ranges: string[], notificationIDList: number[]}} Schedule
 * @throws {Error} When something is not valid
 */
function normalizeSchedule(input, scanner) {
    if (!input || typeof input !== "object") {
        throw new Error("Pengaturan scan terjadwal tidak valid");
    }
    const enabled = input.enabled === true;
    const intervalMinutes = Number(input.intervalMinutes);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < MIN_INTERVAL || intervalMinutes > MAX_INTERVAL) {
        throw new Error(`Jeda scan harus ${MIN_INTERVAL} sampai ${MAX_INTERVAL} menit`);
    }
    const ranges = Array.isArray(input.ranges) ? input.ranges.map((r) => String(r).trim()).filter((r) => r !== "") : [];
    if (ranges.length > MAX_RANGES) {
        throw new Error(`Maksimal ${MAX_RANGES} rentang IP`);
    }
    if (enabled && ranges.length === 0) {
        throw new Error("Masukkan minimal satu rentang IP");
    }
    if (ranges.length > 0) {
        // Throws a readable error for a range that is wrong or too big
        scanner.expandRanges(ranges);
    }
    const list = Array.isArray(input.notificationIDList) ? input.notificationIDList : [];
    if (!list.every((id) => Number.isInteger(id)) || list.length > MAX_NOTIFICATIONS) {
        throw new Error("Daftar notifikasi tidak valid");
    }
    return { enabled, intervalMinutes, ranges, notificationIDList: [...new Set(list)] };
}

/**
 * The stored schedule (defaults when nothing was saved yet).
 * @returns {Promise<object>} Schedule
 */
async function getSchedule() {
    const { Settings } = require("./settings");
    const stored = await Settings.get(SETTING_KEY);
    return { ...DEFAULT_SCHEDULE, ...(stored && typeof stored === "object" ? stored : {}) };
}

/**
 * Validate and store the schedule. The next check of the scheduler starts a scan right away when it is enabled.
 * @param {unknown} input Schedule from the client
 * @param {object} scanner Scanner (needs expandRanges)
 * @returns {Promise<object>} The stored schedule
 */
async function saveSchedule(input, scanner) {
    const { Settings } = require("./settings");
    const schedule = normalizeSchedule(input, scanner);
    await Settings.set(SETTING_KEY, schedule, "general");
    lastRunAt = null;
    return schedule;
}

/**
 * When the next scheduled scan is due.
 * @param {object} schedule Stored schedule
 * @returns {number|null} Epoch milliseconds, or null when the schedule is off
 */
function nextRunAt(schedule) {
    if (!schedule.enabled) {
        return null;
    }
    return lastRunAt === null ? Date.now() : lastRunAt + schedule.intervalMinutes * 60 * 1000;
}

/**
 * Ids of every user, whose clients should see the result of a scheduled scan.
 * @returns {Promise<string[]>} User ids
 */
async function listUserIds() {
    return await R.getCol("SELECT id FROM better_auth_user");
}

/**
 * Start a scheduled scan when it is due.
 * @param {object} options Options
 * @param {object} options.server Uptime Kuma server (needs `io`)
 * @param {object} options.scanner Scanner
 * @param {object} options.store Device store
 * @param {Function} options.alert `(unknown, notificationIDList) => Promise` that sends the alert
 * @param {() => number} options.now Clock (tests)
 * @returns {Promise<boolean>} True when a scan was started
 */
async function tick({ server, scanner, store, alert, now = Date.now }) {
    const schedule = await getSchedule();
    if (!schedule.enabled || runner.isRunning()) {
        return false;
    }
    if (lastRunAt !== null && now() - lastRunAt < schedule.intervalMinutes * 60 * 1000) {
        return false;
    }
    let ips;
    try {
        ips = scanner.expandRanges(schedule.ranges);
    } catch (e) {
        log.error("network-scan", `Scheduled scan skipped: ${e.message}`);
        lastRunAt = now();
        return false;
    }
    if (ips.length === 0) {
        lastRunAt = now();
        return false;
    }
    lastRunAt = now();
    const userIds = await listUserIds();
    runner.startScan({
        ips,
        scanner,
        store,
        scheduled: true,
        emit: (event, data) => {
            for (const id of userIds) {
                server.io.to(id).emit(event, data);
            }
        },
        onUnknown: (unknown) => alert(unknown, schedule.notificationIDList),
    });
    log.info("network-scan", `Scheduled scan of ${ips.length} addresses started`);
    return true;
}

/**
 * Start the scheduler (checks every 30 seconds whether a scan is due).
 * @param {object} server Uptime Kuma server (needs `io`)
 * @param {object} deps Replacements for tests
 * @returns {void}
 */
function startScheduler(server, deps = {}) {
    if (timer) {
        return;
    }
    const options = {
        server,
        scanner: deps.scanner || require("./network-scanner"),
        store: deps.store || require("./network-device-store"),
        alert: deps.alert || require("./network-unknown-alert").alertUnknownDevices,
    };
    timer = setInterval(() => {
        tick(options).catch((e) => log.error("network-scan", `Scheduled scan failed: ${e.message}`));
    }, TICK_MS);
    timer.unref?.();
}

/**
 * Stop the scheduler.
 * @returns {void}
 */
function stopScheduler() {
    clearInterval(timer);
    timer = null;
    lastRunAt = null;
}

module.exports = {
    normalizeSchedule,
    getSchedule,
    saveSchedule,
    nextRunAt,
    tick,
    startScheduler,
    stopScheduler,
    MIN_INTERVAL,
    MAX_INTERVAL,
};
