const { parseRange, summarizeMonitor } = require("./network-device-uptime");
const { getDevicesByIds, listDevices, parseDeviceIds } = require("./network-device-store");

const MAX_EVENTS_PER_DEVICE = 5000;

/**
 * Status history of one device: the time of the range as runs of one state, ready to draw as a timeline.
 * @param {object} params Parameters
 * @param {number} params.deviceId Device id
 * @param {string} params.from Start, ISO 8601 with a time zone
 * @param {string} params.to End, ISO 8601 with a time zone
 * @param {number} params.now Current time in ms (default: now)
 * @returns {Promise<{monitorId: number, effectiveTo: number, spanSeconds: number, segments: {start: number, end: number, state: string}[], segmentsTruncated: boolean}>} Times in ms
 * @throws {Error} When the range is invalid, the device does not exist, or it has no monitor
 */
async function getDeviceHistory(params) {
    const range = parseRange(params.from, params.to);
    const now = params.now ?? Date.now();
    if (!Number.isInteger(params.deviceId)) {
        throw new Error("Perangkat tidak valid");
    }
    const [device] = await getDevicesByIds([params.deviceId]);
    if (!device) {
        throw new Error("Perangkat tidak ditemukan");
    }
    if (device.monitorId === null) {
        throw new Error("Perangkat belum dimonitor");
    }
    const r = await summarizeMonitor(device.monitorId, range, now, { withSegments: true });
    return {
        monitorId: device.monitorId,
        effectiveTo: r.effectiveTo,
        spanSeconds: r.spanSeconds,
        segments: r.segments,
        segmentsTruncated: r.segmentsTruncated,
    };
}

/**
 * Down history of every device that has a monitor, one after the other to keep memory low.
 * `downCount` and `downSeconds` are exact; `periods` holds the newest 500 down periods of the device.
 * @param {object} params Parameters
 * @param {string} params.from Start, ISO 8601 with a time zone
 * @param {string} params.to End, ISO 8601 with a time zone
 * @param {number} params.now Current time in ms (default: now)
 * @param {number[]} params.deviceIds Only these devices (default: all); an empty list means none
 * @returns {Promise<{effectiveTo: number, spanSeconds: number, devices: object[]}>} One entry per monitored device, times in ms
 * @throws {Error} When the range or the device ids are invalid
 */
async function getDownHistory(params) {
    const range = parseRange(params.from, params.to);
    const now = params.now ?? Date.now();
    const only = parseDeviceIds(params.deviceIds);
    const devices = [];
    let effectiveTo = Math.min(range.toMs, now);
    let spanSeconds = Math.max(0, Math.round((effectiveTo - range.fromMs) / 1000));
    for (const device of await listDevices()) {
        if (device.monitorId === null || (only && !only.has(device.id))) {
            continue;
        }
        const r = await summarizeMonitor(device.monitorId, range, now);
        effectiveTo = r.effectiveTo;
        spanSeconds = r.spanSeconds;
        devices.push({
            deviceId: device.id,
            monitorId: device.monitorId,
            downCount: r.downCount,
            downSeconds: r.downSeconds,
            periods: r.downPeriods.map((p) => [p.start, p.end]),
            periodsTruncated: r.downPeriodsTruncated,
        });
    }
    return { effectiveTo, spanSeconds, devices };
}

/**
 * Every down period of the monitored devices, one row per period, to export as a report.
 * Devices are read one after the other to keep memory low; only the newest periods of a device are kept.
 * @param {object} params Parameters
 * @param {string} params.from Start, ISO 8601 with a time zone
 * @param {string} params.to End, ISO 8601 with a time zone
 * @param {number} params.now Current time in ms (default: now)
 * @param {number[]} params.deviceIds Only these devices (default: all); an empty list means none
 * @param {number} params.maxPerDevice How many periods to keep per device, the newest (default 5000)
 * @returns {Promise<{events: {deviceId: number, start: number, end: number, msg: string|null}[], effectiveTo: number, truncated: boolean}>}
 *     Events sorted by start, then device id; `end` of a period that is not over is `effectiveTo`; times in ms
 * @throws {Error} When the range or the device ids are invalid
 */
async function getDownEvents(params) {
    const range = parseRange(params.from, params.to);
    const now = params.now ?? Date.now();
    const only = parseDeviceIds(params.deviceIds);
    const maxPerDevice = params.maxPerDevice ?? MAX_EVENTS_PER_DEVICE;
    const events = [];
    let truncated = false;
    for (const device of await listDevices()) {
        if (device.monitorId === null || (only && !only.has(device.id))) {
            continue;
        }
        const r = await summarizeMonitor(device.monitorId, range, now, { maxDownPeriods: maxPerDevice });
        truncated = truncated || r.downPeriodsTruncated;
        for (const p of r.downPeriods) {
            events.push({ deviceId: device.id, start: p.start, end: p.end, msg: p.msg ?? null });
        }
    }
    events.sort((x, y) => x.start - y.start || x.deviceId - y.deviceId);
    return { events, effectiveTo: Math.min(range.toMs, now), truncated };
}

module.exports = { getDeviceHistory, getDownHistory, getDownEvents };
