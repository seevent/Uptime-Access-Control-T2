const { R } = require("redbean-node");
const { MIN_INTERVAL_SECOND, log } = require("../src/util");
const { getDevicesByIds, setMonitorId } = require("./network-device-store");
const { groupOfDevice } = require("./network-category-sync");

const TYPES = new Set(["ping", "port", "http", "rtsp", "snmp"]);
// Types whose port may stay empty: the usual port of the service is used
const DEFAULT_PORTS = { http: 80, rtsp: 554, snmp: 161 };
const MAX_PATH_LENGTH = 200;
const MAX_COMMUNITY_LENGTH = 64;
// Pages of a device that answers but wants a login or refuses the request still show that the device is alive
const HTTP_ACCEPTED_STATUS_CODES = ["200-299", "300-399", "401", "403"];
// sysUpTime: every SNMP agent has it, and it is a number, so ">= 0" only checks that the agent answers
const SNMP_UPTIME_OID = "1.3.6.1.2.1.1.3.0";

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
 * Validate the path of a web page of a device.
 * @param {unknown} value Raw value (empty means the home page)
 * @returns {string} Path that starts with a slash
 * @throws {Error} When the path has spaces or other characters that cannot be in a URL path
 */
function parsePath(value) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text === "") {
        return "/";
    }
    const path = text.startsWith("/") ? text : `/${text}`;
    if (path.length > MAX_PATH_LENGTH || !/^[\x21-\x7e]+$/.test(path)) {
        throw new Error("Path tidak valid");
    }
    return path;
}

/**
 * Validate an SNMP community string.
 * @param {unknown} value Raw value (empty means "public")
 * @returns {string} The community
 * @throws {Error} When it is too long or has spaces or other unusual characters
 */
function parseCommunity(value) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text === "") {
        return "public";
    }
    if (text.length > MAX_COMMUNITY_LENGTH || !/^[\x21-\x7e]+$/.test(text)) {
        throw new Error("Community SNMP tidak valid");
    }
    return text;
}

/**
 * Check what the user asked for one device and fill in what was left empty.
 * @param {{type: string, port?: number|string, path?: string, community?: string}} request Request of the user
 * @returns {{type: string, port: number|null, path: string|null, community: string|null}} Clean request
 * @throws {Error} When the type, port, path or community is not valid
 */
function normalizeRequest(request) {
    if (!TYPES.has(request.type)) {
        throw new Error("Tipe monitor tidak valid");
    }
    const type = request.type;
    const empty = request.port === undefined || request.port === null || String(request.port).trim() === "";
    let port = null;
    if (type === "port" || !empty) {
        if (type !== "ping") {
            port = parsePort(request.port);
            if (port === null) {
                throw new Error("Port tidak valid");
            }
        }
    } else if (DEFAULT_PORTS[type]) {
        port = DEFAULT_PORTS[type];
    }
    return {
        type,
        port,
        path: type === "http" ? parsePath(request.path) : null,
        community: type === "snmp" ? parseCommunity(request.community) : null,
    };
}

/**
 * Address of the web page of a device. The usual TLS ports use https.
 * @param {string} ip Device address
 * @param {number} port Port
 * @param {string} path Path that starts with a slash
 * @returns {string} URL
 */
function buildHttpUrl(ip, port, path) {
    const secure = port === 443 || port === 8443;
    const defaultPort = secure ? 443 : 80;
    const host = ip.includes(":") ? `[${ip}]` : ip;
    return `${secure ? "https" : "http"}://${host}${port === defaultPort ? "" : `:${port}`}${path}`;
}

/**
 * Fields of a new monitor, with the same defaults the "Add New Monitor" form uses.
 * @param {object} device Device from the inventory
 * @param {object} request What the user asked for, cleaned by `normalizeRequest`: `{ type, port, path, community }`
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
    } else if (request.type === "http") {
        Object.assign(fields, {
            url: buildHttpUrl(device.ip, request.port, request.path),
            method: "GET",
            maxredirects: 10,
            timeout: 48,
            ignoreTls: true,
            accepted_statuscodes_json: JSON.stringify(HTTP_ACCEPTED_STATUS_CODES),
        });
    } else if (request.type === "snmp") {
        Object.assign(fields, {
            port: request.port,
            timeout: 10,
            snmpVersion: "2c",
            radiusPassword: request.community,
            snmpOid: SNMP_UPTIME_OID,
            jsonPath: "$",
            jsonPathOperator: ">=",
            expectedValue: "0",
        });
    } else {
        Object.assign(fields, { timeout: request.type === "rtsp" ? 10 : 48, port: request.port });
    }
    return fields;
}

/**
 * Find a monitor that already watches the same target in the same way.
 * @param {{type: string, port: number|null, path: string|null}} request Clean request (see `normalizeRequest`)
 * @param {string} ip Device address
 * @returns {Promise<number|null>} Monitor id, if any
 */
async function findExistingMonitor(request, ip) {
    let row;
    if (request.type === "http") {
        row = await R.getRow("SELECT id FROM monitor WHERE type = 'http' AND url = ?", [
            buildHttpUrl(ip, request.port, request.path),
        ]);
    } else if (request.port !== null) {
        row = await R.getRow("SELECT id FROM monitor WHERE type = ? AND hostname = ? AND port = ?", [
            request.type,
            ip,
            request.port,
        ]);
    } else {
        row = await R.getRow("SELECT id FROM monitor WHERE type = 'ping' AND hostname = ?", [ip]);
    }
    return row ? row.id : null;
}

/**
 * Create monitors for devices of the network inventory. Each device is handled on its own, so one bad
 * device never stops the others.
 * @param {object} params Parameters
 * @param {string} params.userID Owner of the new monitors
 * @param {{id: number, type: "ping"|"port"|"http"|"rtsp"|"snmp", port?: number|string, path?: string, community?: string}[]} params.devices
 *     Devices and how to monitor them (an empty port of http, rtsp and snmp means 80, 554 and 161)
 * @param {number} params.interval Check interval in seconds
 * @param {number|null} params.parent Parent group monitor for devices without a category (a device with a category
 *     goes into the group of its category)
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
            const clean = normalizeRequest(request);

            if (handled.has(id) || device.monitorId !== null) {
                result.skipped++;
                handled.add(id);
                continue;
            }
            const existingId = await findExistingMonitor(clean, device.ip);
            if (existingId !== null) {
                await setMonitorId(device.id, existingId);
                result.skipped++;
                handled.add(id);
                continue;
            }

            // A device with a category goes into the group of its category; the chosen parent group is only for
            // devices without one.
            const devicesParent = (await groupOfDevice(device)) ?? parent;

            const bean = R.dispense("monitor");
            bean.import(buildMonitorFields(device, clean, { userID, interval, parent: devicesParent }));
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

module.exports = { addDevicesToMonitoring, parsePort, parsePath, parseCommunity, normalizeRequest, TYPES };
