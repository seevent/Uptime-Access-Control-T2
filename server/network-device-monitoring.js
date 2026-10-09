const { R } = require("redbean-node");
const { MIN_INTERVAL_SECOND, log } = require("../src/util");
const { getDevicesByIds, setMonitorId } = require("./network-device-store");

const TYPES = new Set(["ping", "port"]);

/**
 * Validate a TCP port typed by the user.
 * @param {number|string|undefined} value Raw value
 * @returns {number|null} The port, or null when it is not a whole number from 1 to 65535
 */
function parsePort(value) {
    let port;
    if (typeof value === "number") {
        port = value;
    } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
        port = Number(value.trim());
    } else {
        return null;
    }
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * Fields of a new monitor, with the same defaults the "Add New Monitor" form uses.
 * @param {object} device Device from the inventory
 * @param {object} request What the user asked for: `{ type, port }`
 * @param {object} common Shared settings: `{ userID, interval, parent }`
 * @returns {object} Fields for `bean.import`
 */
function buildMonitorFields(device, request, common) {
    const fields = {
        type: request.type,
        name: device.label || device.hostname || device.ip,
        hostname: device.ip,
        interval: common.interval,
        retryInterval: 60,
        resendInterval: 0,
        maxretries: 0,
        parent: common.parent,
        accepted_statuscodes_json: JSON.stringify(["200-299"]),
        conditions: "[]",
        user_id: common.userID,
    };
    if (request.type === "ping") {
        Object.assign(fields, {
            timeout: 10,
            ping_count: 3,
            ping_numeric: true,
            packetSize: 56,
            ping_per_request_timeout: 2,
        });
    } else {
        Object.assign(fields, { timeout: 48, port: request.port });
    }
    return fields;
}

/**
 * Find a monitor that already watches the same target in the same way.
 * @param {string} type Monitor type
 * @param {string} ip Device address
 * @param {number|null} port Port (port monitors only)
 * @returns {Promise<number|null>} Monitor id, if any
 */
async function findExistingMonitor(type, ip, port) {
    const row =
        type === "port"
            ? await R.getRow("SELECT id FROM monitor WHERE type = 'port' AND hostname = ? AND port = ?", [ip, port])
            : await R.getRow("SELECT id FROM monitor WHERE type = 'ping' AND hostname = ?", [ip]);
    return row ? row.id : null;
}

/**
 * Create monitors for devices of the network inventory. Each device is handled on its own, so one bad
 * device never stops the others.
 * @param {object} params Parameters
 * @param {string} params.userID Owner of the new monitors
 * @param {{id: number, type: "ping"|"port", port?: number|string}[]} params.devices Devices and how to monitor them
 * @param {number} params.interval Check interval in seconds
 * @param {number|null} params.parent Parent group monitor
 * @param {Record<string, boolean>} params.notificationIDList Notifications to attach
 * @param {object} deps Functions that live in server.js
 * @param {Function} deps.startMonitor Starts a monitor
 * @param {Function} deps.updateMonitorNotification Saves the notifications of a monitor
 * @param {Function} deps.sendUpdateMonitorIntoList Sends a monitor to the client's list
 * @returns {Promise<{added: number, skipped: number, failed: {id: number, msg: string}[]}>} Counts of devices
 * @throws {Error} When the shared settings (interval, parent, device list) are invalid; nothing is created then
 */
async function addDevicesToMonitoring(params, deps) {
    const { userID, devices, parent = null, notificationIDList = {} } = params;

    const interval = Number(params.interval);
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL_SECOND) {
        throw new Error(`Interval tidak valid (minimal ${MIN_INTERVAL_SECOND} detik)`);
    }
    if (parent !== null && !Number.isInteger(parent)) {
        throw new Error("Grup induk tidak valid");
    }
    if (!Array.isArray(devices)) {
        throw new Error("Pilih minimal satu perangkat");
    }

    const result = { added: 0, skipped: 0, failed: [] };
    const stored = new Map(
        (await getDevicesByIds(devices.map((d) => d?.id).filter((id) => Number.isInteger(id)))).map((d) => [d.id, d])
    );
    const handled = new Set();

    for (const request of devices) {
        const id = request?.id;
        try {
            const device = stored.get(id);
            if (!device) {
                throw new Error("Perangkat tidak ditemukan");
            }
            if (!TYPES.has(request.type)) {
                throw new Error("Tipe monitor tidak valid");
            }
            let port = null;
            if (request.type === "port") {
                port = parsePort(request.port);
                if (port === null) {
                    throw new Error("Port tidak valid");
                }
            }

            if (handled.has(id) || device.monitorId !== null) {
                result.skipped++;
                handled.add(id);
                continue;
            }
            const existingId = await findExistingMonitor(request.type, device.ip, port);
            if (existingId !== null) {
                await setMonitorId(device.id, existingId);
                result.skipped++;
                handled.add(id);
                continue;
            }

            const bean = R.dispense("monitor");
            bean.import(buildMonitorFields(device, { type: request.type, port }, { userID, interval, parent }));
            bean.validate();
            await R.store(bean);

            try {
                await deps.updateMonitorNotification(bean.id, notificationIDList);
                await setMonitorId(device.id, bean.id);
                await deps.sendUpdateMonitorIntoList(bean.id);
            } catch (e) {
                // Do not leave a monitor behind that the user was told could not be added.
                await R.exec("DELETE FROM monitor WHERE id = ?", [bean.id]);
                throw e;
            }

            try {
                await deps.startMonitor(userID, bean.id);
            } catch (e) {
                // The monitor exists and is linked; a start problem shows up in its own status.
                log.error("network-scan", `Could not start monitor ${bean.id}: ${e.message}`);
            }

            handled.add(id);
            result.added++;
            log.info("network-scan", `Added ${request.type} monitor ${bean.id} for ${device.ip} User ID: ${userID}`);
        } catch (e) {
            result.failed.push({ id, msg: e.message });
        }
    }

    return result;
}

module.exports = { addDevicesToMonitoring, parsePort };
