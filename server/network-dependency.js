const { R } = require("redbean-node");
const { DOWN, UP, log } = require("../src/util");

const DEFAULT_GRACE_SECONDS = 60;
const MAX_GRACE_SECONDS = 300;
const MAX_DEPTH = 20;

// Monitors whose "down" alert is waiting for the grace period: monitor id -> timer
const pending = new Map();
// Monitors whose "down" alert was held back because a device they depend on is down
const suppressed = new Set();

/**
 * How long a "down" alert of a dependent device waits before the devices it depends on are looked at. The device it
 * depends on may be found down a little later than the device itself.
 * @returns {Promise<number>} Milliseconds
 */
async function graceMs() {
    const { Settings } = require("./settings");
    const value = Number(await Settings.get("networkDependencyGraceSeconds"));
    const seconds = Number.isInteger(value) && value >= 0 && value <= MAX_GRACE_SECONDS ? value : DEFAULT_GRACE_SECONDS;
    return seconds * 1000;
}

/**
 * The inventory device that is watched by a monitor.
 * @param {number} monitorId Monitor id
 * @returns {Promise<{id: number, depends_on_id: ?number}|null>} The device, if any
 */
async function deviceOfMonitor(monitorId) {
    return (await R.getRow("SELECT id, depends_on_id FROM network_device WHERE monitor_id = ?", [monitorId])) || null;
}

/**
 * Status of the latest check of a monitor that is running.
 * @param {number} monitorId Monitor id
 * @returns {Promise<number|null>} Status, or null for a paused monitor or one without checks
 */
async function latestStatus(monitorId) {
    const status = await R.getCell(
        `SELECT h.status FROM heartbeat h JOIN monitor m ON m.id = h.monitor_id
         WHERE h.monitor_id = ? AND m.active = 1 ORDER BY h.time DESC`,
        [monitorId]
    );
    return status === null || status === undefined ? null : Number(status);
}

/**
 * The nearest device up the chain of dependencies whose monitor is down.
 * @param {{depends_on_id: ?number}} device Device to start from
 * @returns {Promise<{id: number, name: string}|null>} The device that is down, if any
 */
async function nearestDownAncestor(device) {
    let parentId = device.depends_on_id;
    const seen = new Set();
    for (let depth = 0; parentId && depth < MAX_DEPTH && !seen.has(parentId); depth++) {
        seen.add(parentId);
        const parent = await R.getRow(
            `SELECT d.id, d.depends_on_id, d.monitor_id, d.ip, d.label, m.name AS monitor_name
             FROM network_device d LEFT JOIN monitor m ON m.id = d.monitor_id WHERE d.id = ?`,
            [parentId]
        );
        if (!parent) {
            return null;
        }
        if (parent.monitor_id !== null && (await latestStatus(parent.monitor_id)) === DOWN) {
            return { id: parent.id, name: parent.label || parent.monitor_name || parent.ip };
        }
        parentId = parent.depends_on_id;
    }
    return null;
}

/**
 * Wait for the grace period, then send the alert unless the device recovered or a device it depends on is down.
 * @param {number} monitorId Monitor of the dependent device
 * @param {() => Promise<void>} send Sends the alert
 * @param {boolean} checkSelf True when the monitor must still be down to send (not when the alert was just made)
 * @returns {Promise<void>}
 */
async function schedule(monitorId, send, checkSelf) {
    const wait = await graceMs();
    const decide = async () => {
        pending.delete(monitorId);
        try {
            if (checkSelf && wait > 0 && (await latestStatus(monitorId)) !== DOWN) {
                return;
            }
            const device = await deviceOfMonitor(monitorId);
            const blocker = device ? await nearestDownAncestor(device) : null;
            if (blocker) {
                suppressed.add(monitorId);
                log.info("network-scan", `Down alert of monitor ${monitorId} held back: ${blocker.name} is down`);
                return;
            }
            await send();
        } catch (e) {
            log.error("network-scan", `Dependency check failed for monitor ${monitorId}: ${e.message}`);
        }
    };
    if (wait === 0) {
        await decide();
        return;
    }
    const timer = setTimeout(decide, wait);
    timer.unref?.();
    pending.set(monitorId, timer);
}

/**
 * Devices that depend on a device, directly or through others.
 * @param {number} deviceId Device id
 * @returns {Promise<{id: number, monitor_id: ?number}[]>} Dependent devices
 */
async function descendants(deviceId) {
    const found = [];
    const seen = new Set([deviceId]);
    let level = [deviceId];
    for (let depth = 0; level.length > 0 && depth < MAX_DEPTH; depth++) {
        const rows = await R.getAll(
            `SELECT id, monitor_id FROM network_device WHERE depends_on_id IN (${level.map(() => "?").join(",")})`,
            level
        );
        level = [];
        for (const row of rows) {
            if (!seen.has(row.id)) {
                seen.add(row.id);
                found.push(row);
                level.push(row.id);
            }
        }
    }
    return found;
}

/**
 * A monitor came back up: the devices that depend on it, whose alert was held back and that are still down, get
 * their alert now (after the grace period, in case they recover too).
 * @param {number} monitorId Monitor that is up now
 * @param {(monitorId: number) => Promise<void>} sendHeldAlert Sends the "down" alert of a monitor
 * @returns {Promise<void>}
 */
async function releaseDependents(monitorId, sendHeldAlert) {
    const device = await deviceOfMonitor(monitorId);
    if (!device) {
        return;
    }
    for (const dependent of await descendants(device.id)) {
        const id = dependent.monitor_id;
        if (id !== null && suppressed.has(id) && !pending.has(id)) {
            suppressed.delete(id);
            await schedule(id, () => sendHeldAlert(id), true);
        }
    }
}

/**
 * Decide what happens with the alert of a beat. Called before Uptime Kuma sends it.
 * @param {{id: number}} monitor Monitor of the beat
 * @param {{status: number}} bean The beat
 * @param {object} actions What the caller can do
 * @param {() => Promise<void>} actions.send Sends the alert of this beat (used after the grace period)
 * @param {(monitorId: number) => Promise<void>} actions.sendHeldAlert Sends the "down" alert of another monitor
 * @returns {Promise<boolean>} True when the alert is handled here and Uptime Kuma must not send it now
 */
async function intercept(monitor, bean, { send, sendHeldAlert }) {
    const id = monitor.id;
    if (bean.status === UP) {
        const timer = pending.get(id);
        if (timer) {
            // Recovered before anything was sent: there is nothing to tell
            clearTimeout(timer);
            pending.delete(id);
            await releaseDependents(id, sendHeldAlert);
            return true;
        }
        const wasHeldBack = suppressed.delete(id);
        await releaseDependents(id, sendHeldAlert);
        return wasHeldBack;
    }
    if (bean.status !== DOWN) {
        return false;
    }
    if (pending.has(id) || suppressed.has(id)) {
        return true;
    }
    const device = await deviceOfMonitor(id);
    if (!device || device.depends_on_id === null || device.depends_on_id === undefined) {
        return false;
    }
    await schedule(id, send, false);
    return true;
}

/**
 * Forget what is held back (tests, and when the monitors are restarted).
 * @returns {void}
 */
function reset() {
    for (const timer of pending.values()) {
        clearTimeout(timer);
    }
    pending.clear();
    suppressed.clear();
}

module.exports = { intercept, nearestDownAncestor, descendants, reset, isHeldBack: (id) => suppressed.has(id) };
