import { buildUptimeCsv } from "./network-uptime-format.js";

/**
 * @param {number|null|undefined} value A number of milliseconds
 * @returns {number|null} The number with one decimal, or null when there is none
 */
function oneDecimal(value) {
    return value === null || value === undefined ? null : Math.round(value * 10) / 10;
}

/**
 * The CSV of the down periods of devices: one row per period, oldest first, then by device name.
 * @param {object} params Parameters
 * @param {string[]} params.headers The nine column titles
 * @param {{deviceId: number, start: number, end: number, msg: string|null}[]} params.events Down periods (ms)
 * @param {number} params.effectiveTo End of the range that was read (ms); a period that reaches it is still going on
 * @param {(deviceId: number) => {name: string, ip: string, category: string, subcategory: string}} params.info Device details
 * @param {(ms: number) => string} params.formatTime Writes a time for the file
 * @param {string} params.yes Text for "still going on"
 * @param {string} params.no Text for "ended"
 * @returns {string} The CSV text
 */
export function buildDownEventsCsv({ headers, events, effectiveTo, info, formatTime, yes, no }) {
    const rows = events
        .map((event) => ({ event, device: info(event.deviceId) }))
        .sort((a, b) => a.event.start - b.event.start || a.device.name.localeCompare(b.device.name))
        .map(({ event, device }) => [
            device.name,
            device.ip,
            device.category,
            device.subcategory,
            formatTime(event.start),
            formatTime(event.end),
            Math.round((event.end - event.start) / 1000),
            event.end >= effectiveTo ? yes : no,
            event.msg,
        ]);
    return buildUptimeCsv(headers, rows);
}

/**
 * The CSV of the ping of devices: one row per device, in the order given.
 * @param {object} params Parameters
 * @param {string[]} params.headers The nine column titles
 * @param {{id: number}[]} params.devices The devices to list
 * @param {{deviceId: number, samples: number, avg: number|null, min: number|null, max: number|null}[]} params.items Ping summary
 * @param {(deviceId: number) => {name: string, ip: string, category: string, subcategory: string}} params.info Device details
 * @returns {string} The CSV text
 */
export function buildPingCsv({ headers, devices, items, info }) {
    const byDevice = new Map(items.map((item) => [item.deviceId, item]));
    const rows = devices.map((device) => {
        const d = info(device.id);
        const item = byDevice.get(device.id);
        const hasPing = !!item && item.samples > 0 && item.avg !== null;
        return [
            d.name,
            d.ip,
            d.category,
            d.subcategory,
            hasPing ? oneDecimal(item.avg) : null,
            hasPing ? oneDecimal(item.min) : null,
            hasPing ? oneDecimal(item.max) : null,
            hasPing ? oneDecimal(item.max - item.min) : null,
            item ? item.samples : 0,
        ];
    });
    return buildUptimeCsv(headers, rows);
}
