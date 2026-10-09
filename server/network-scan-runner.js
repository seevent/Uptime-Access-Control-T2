const { log } = require("../src/util");

// Only one scan can run at a time on the whole server (manual or scheduled), so its state lives in the module.
const state = {
    running: false,
    scanId: 0,
    done: 0,
    total: 0,
    found: 0,
    abortController: null,
};
let lastScanId = 0;

/**
 * Forget the running scan. Always called from a finally block so a failed or cancelled scan can never block the next one.
 * @returns {void}
 */
function resetState() {
    state.running = false;
    state.done = 0;
    state.total = 0;
    state.found = 0;
    state.abortController = null;
}

/**
 * The progress of the scan that is running now.
 * @returns {{running: boolean, scanId: number, done: number, total: number, found: number}} Progress
 */
function getStatus() {
    return {
        running: state.running,
        scanId: state.scanId,
        done: state.done,
        total: state.total,
        found: state.found,
    };
}

/**
 * Stop the running scan.
 * @param {number} scanId Id of the scan the caller means
 * @returns {boolean} False when that scan is not running
 */
function cancel(scanId) {
    if (!state.running || scanId !== state.scanId) {
        return false;
    }
    state.abortController.abort();
    return true;
}

/**
 * Run the scan in the background and report the outcome through `emit`.
 * @param {number} scanId Id of this scan
 * @param {string[]} ips Addresses to scan
 * @param {AbortController} abortController Used to cancel
 * @param {object} options Options
 * @param {object} options.scanner Scanner (server/network-scanner)
 * @param {object} options.store Device store (server/network-device-store)
 * @param {(event: string, payload: any) => void} options.emit Sends an event to the clients of the user(s)
 * @param {boolean} options.scheduled True when the scheduler started the scan
 * @param {(unknown: object[]) => Promise<void>} options.onUnknown Called with the unknown devices of a scan
 * @returns {Promise<void>}
 */
async function runScan(scanId, ips, abortController, { scanner, store, emit, scheduled, onUnknown }) {
    const done = { scanId, cancelled: false };
    if (scheduled) {
        done.scheduled = true;
    }
    let unknown = [];

    try {
        const result = await scanner.scan({
            ips,
            signal: abortController.signal,
            onProgress: (progress) => {
                state.done = progress.done;
                state.total = progress.total;
                state.found = progress.found;
                emit("networkScanProgress", { scanId, ...progress });
            },
        });
        const cancelled = !result.completed;
        const merged = await store.mergeScan({
            devices: result.devices,
            scannedIPs: ips,
            complete: result.completed,
        });
        unknown = merged.unknown || [];
        done.cancelled = cancelled;
        done.summary = { ...merged, arpAvailable: cancelled ? true : result.arpAvailable };
    } catch (e) {
        done.error = e.message;
    } finally {
        resetState();
    }

    // Emitted after the reset, so a client reacting to "done" can start the next scan right away.
    emit("networkScanDone", done);
    try {
        emit("networkDeviceList", await store.listDevices());
    } catch (e) {
        log.error("network-scan", `Could not send the device list: ${e.message}`);
    }
    if (unknown.length > 0 && onUnknown) {
        try {
            await onUnknown(unknown);
        } catch (e) {
            log.error("network-scan", `Could not alert about unknown devices: ${e.message}`);
        }
    }
}

/**
 * Start a scan in the background.
 * @param {object} options Options
 * @param {string[]} options.ips Addresses to scan (already expanded)
 * @param {object} options.scanner Scanner (server/network-scanner)
 * @param {object} options.store Device store (server/network-device-store)
 * @param {(event: string, payload: any) => void} options.emit Sends an event to the clients of the user(s)
 * @param {boolean} options.scheduled True when the scheduler started the scan
 * @param {(unknown: object[]) => Promise<void>} options.onUnknown Called with the unknown devices of a scan
 * @returns {number} Id of the scan
 * @throws {Error} When a scan is already running
 */
function startScan({ ips, scanner, store, emit, scheduled = false, onUnknown }) {
    if (state.running) {
        throw new Error("Scan sedang berjalan");
    }
    // No await between the check above and this block, so two requests cannot both start.
    const abortController = new AbortController();
    const scanId = ++lastScanId;
    state.running = true;
    state.scanId = scanId;
    state.done = 0;
    state.total = ips.length;
    state.found = 0;
    state.abortController = abortController;

    runScan(scanId, ips, abortController, { scanner, store, emit, scheduled, onUnknown }).catch((e) => {
        log.error("network-scan", `Network scan failed unexpectedly: ${e.message}`);
        resetState();
    });
    return scanId;
}

module.exports = { startScan, getStatus, cancel, isRunning: () => state.running };
