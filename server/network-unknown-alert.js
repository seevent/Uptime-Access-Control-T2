const { R } = require("redbean-node");
const { log } = require("../src/util");

const MAX_LINES = 10;

/**
 * Build the text of the alert about unknown devices.
 * @param {{ip: string, mac: ?string, vendor: ?string, hostname: ?string, note: ?string}[]} unknown Devices
 * @returns {string} Message
 */
function buildMessage(unknown) {
    const lines = unknown.slice(0, MAX_LINES).map((d) => {
        const parts = [d.ip, d.mac, d.vendor, d.hostname].filter(Boolean);
        return `• ${parts.join(" · ")}${d.note ? ` — ${d.note}` : ""}`;
    });
    if (unknown.length > MAX_LINES) {
        lines.push(`… dan ${unknown.length - MAX_LINES} lainnya`);
    }
    return `⚠️ [Scan Jaringan] ${unknown.length} perangkat asing terdeteksi:\n${lines.join("\n")}`;
}

/**
 * Send the alert about unknown devices through the chosen notification providers of Uptime Kuma.
 * A provider that fails is logged and skipped, so one broken provider cannot block the others.
 * @param {object[]} unknown Unknown devices (see mergeScan)
 * @param {number[]} notificationIDList Ids of the notifications to use
 * @param {object} deps Replacements for tests
 * @param {Function} deps.send Replacement for Notification.send
 * @returns {Promise<{sent: number, failed: number}>} How many providers got the alert
 */
async function alertUnknownDevices(unknown, notificationIDList, deps = {}) {
    const result = { sent: 0, failed: 0 };
    if (!Array.isArray(unknown) || unknown.length === 0 || !Array.isArray(notificationIDList)) {
        return result;
    }
    const ids = notificationIDList.filter((id) => Number.isInteger(id));
    if (ids.length === 0) {
        return result;
    }
    const send = deps.send || ((...args) => require("./notification").Notification.send(...args));
    const rows = await R.getAll(
        `SELECT * FROM notification WHERE active = 1 AND id IN (${ids.map(() => "?").join(",")})`,
        ids
    );
    const msg = buildMessage(unknown);
    for (const row of rows) {
        try {
            await send(JSON.parse(row.config), msg);
            result.sent++;
        } catch (e) {
            result.failed++;
            log.error("network-scan", `Could not send the unknown device alert to ${row.name}: ${e.message}`);
        }
    }
    return result;
}

module.exports = { alertUnknownDevices, buildMessage };
