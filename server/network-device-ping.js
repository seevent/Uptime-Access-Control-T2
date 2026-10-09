const { R } = require("redbean-node");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
const { parseRange } = require("./network-device-uptime");
const { getDevicesByIds, listDevices, parseDeviceIds } = require("./network-device-store");

const MAX_SERIES_DEVICES = 5;
const DAY_MS = 86400000;

/** The statistics tables of Kuma that hold the ping per bucket of time, finest first. */
const RESOLUTIONS = {
    minute: { table: "stat_minutely", stepSeconds: 60 },
    hour: { table: "stat_hourly", stepSeconds: 3600 },
    day: { table: "stat_daily", stepSeconds: 86400 },
};

const RESOLUTION_SLACK_MS = 5 * 60 * 1000;

/**
 * Choose the finest statistics table that still holds the start of the range.
 * Kuma keeps minutely rows for 24 hours and hourly rows for 30 days; daily rows follow `keepDataPeriodDays`.
 * @param {number} fromMs Start of the range (ms)
 * @param {number} nowMs Current time (ms)
 * @returns {"minute"|"hour"|"day"} The resolution to read
 */
function pickResolution(fromMs, nowMs) {
    // The page counts back from its own clock, so "24 hours" or "30 days" reaches the server a little late; a few
    // minutes of slack keep those presets on the finer table (Kuma prunes the tables relative to the last update)
    if (fromMs >= nowMs - DAY_MS - RESOLUTION_SLACK_MS) {
        return "minute";
    }
    if (fromMs >= nowMs - 30 * DAY_MS - RESOLUTION_SLACK_MS) {
        return "hour";
    }
    return "day";
}

/**
 * Summarize buckets of ping. Only buckets with at least one successful check count, and the average is weighted
 * by the number of successful checks.
 * @param {[number, number|null, number|null, number|null, number, number][]} points Buckets `[timeMs, avg, min, max, up, down]`
 * @returns {{samples: number, avg: number|null, min: number|null, max: number|null}} All null when there are no samples
 */
function summarizePoints(points) {
    let samples = 0;
    let weighted = 0;
    let min = null;
    let max = null;
    for (const [, avg, low, high, up] of points) {
        if (!(up > 0) || avg === null) {
            continue;
        }
        samples += up;
        weighted += avg * up;
        min = min === null ? low : Math.min(min, low);
        max = max === null ? high : Math.max(max, high);
    }
    return { samples, avg: samples > 0 ? weighted / samples : null, min, max };
}

/**
 * Work out the table and the bounds (Unix seconds) to read for a range.
 * @param {{fromMs: number, toMs: number}} range The validated range
 * @param {number} now Current time (ms)
 * @returns {{resolution: string, table: string, stepSeconds: number, fromSec: number, toSec: number, effectiveTo: number}} The plan
 */
function plan(range, now) {
    const resolution = pickResolution(range.fromMs, now);
    const { table, stepSeconds } = RESOLUTIONS[resolution];
    const effectiveTo = Math.min(range.toMs, now);
    return {
        resolution,
        table,
        stepSeconds,
        // The bucket that holds the start of the range is read whole.
        fromSec: Math.floor(range.fromMs / 1000 / stepSeconds) * stepSeconds,
        toSec: Math.floor(effectiveTo / 1000),
        effectiveTo,
    };
}

/**
 * Ping of every device that has a monitor over a time range, in one query.
 * @param {object} params Parameters
 * @param {string} params.from Start, ISO 8601 with a time zone
 * @param {string} params.to End, ISO 8601 with a time zone
 * @param {number} params.now Current time in ms (default: now)
 * @param {number[]} params.deviceIds Only these devices (default: all); an empty list means none
 * @returns {Promise<{resolution: string, effectiveTo: number, items: object[]}>} One item per monitored device: `{ deviceId, monitorId, samples, avg, min, max }`
 * @throws {Error} When the range or the device ids are invalid
 */
async function getPingSummary(params) {
    const range = parseRange(params.from, params.to);
    const now = params.now ?? Date.now();
    const only = parseDeviceIds(params.deviceIds);
    const p = plan(range, now);
    const rows = await R.getAll(
        `SELECT monitor_id, SUM(up) AS samples, SUM(ping * up) AS weighted, MIN(ping_min) AS low, MAX(ping_max) AS high
         FROM ${p.table} WHERE up > 0 AND timestamp >= ? AND timestamp <= ? GROUP BY monitor_id`,
        [p.fromSec, p.toSec]
    );
    const byMonitor = new Map(rows.map((r) => [Number(r.monitor_id), r]));
    const items = [];
    for (const device of await listDevices()) {
        if (device.monitorId === null || (only && !only.has(device.id))) {
            continue;
        }
        const row = byMonitor.get(device.monitorId);
        const samples = row ? Number(row.samples) : 0;
        items.push({
            deviceId: device.id,
            monitorId: device.monitorId,
            samples,
            avg: samples > 0 ? Number(row.weighted) / samples : null,
            min: samples > 0 ? Number(row.low) : null,
            max: samples > 0 ? Number(row.high) : null,
        });
    }
    return { resolution: p.resolution, effectiveTo: p.effectiveTo, items };
}

/**
 * Ping per bucket of time for one to five devices, to draw as lines.
 * @param {object} params Parameters
 * @param {number[]} params.ids Device ids (1 to 5 different ids)
 * @param {string} params.from Start, ISO 8601 with a time zone
 * @param {string} params.to End, ISO 8601 with a time zone
 * @param {number} params.now Current time in ms (default: now)
 * @returns {Promise<object>} `{ resolution, stepSeconds, effectiveTo, series }`; each series has `deviceId`, `monitorId`,
 *     `summary` (`samples, avg, min, max, last`) and `points` (`[timeMs, avg, min, max, up, down]`, null values for a bucket without successful checks)
 * @throws {Error} When the ids or the range are invalid, a device does not exist, or a device has no monitor
 */
async function getPingSeries(params) {
    const { ids } = params;
    if (!Array.isArray(ids) || !ids.every((id) => Number.isInteger(id))) {
        throw new Error(`Pilih 1 sampai ${MAX_SERIES_DEVICES} perangkat`);
    }
    const unique = [...new Set(ids)];
    if (unique.length < 1 || unique.length > MAX_SERIES_DEVICES) {
        throw new Error(`Pilih 1 sampai ${MAX_SERIES_DEVICES} perangkat`);
    }
    const range = parseRange(params.from, params.to);
    const now = params.now ?? Date.now();

    const found = new Map((await getDevicesByIds(unique)).map((d) => [d.id, d]));
    const devices = unique.map((id) => {
        const device = found.get(id);
        if (!device) {
            throw new Error("Perangkat tidak ditemukan");
        }
        if (device.monitorId === null) {
            throw new Error("Perangkat belum dimonitor");
        }
        return device;
    });

    const p = plan(range, now);
    const series = [];
    for (const device of devices) {
        const rows = await R.getAll(
            `SELECT timestamp, ping, ping_min, ping_max, up, down FROM ${p.table}
             WHERE monitor_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp`,
            [device.monitorId, p.fromSec, p.toSec]
        );
        const points = rows.map((r) => {
            const up = Number(r.up);
            const hasPing = up > 0;
            return [
                Number(r.timestamp) * 1000,
                hasPing ? Number(r.ping) : null,
                hasPing ? Number(r.ping_min) : null,
                hasPing ? Number(r.ping_max) : null,
                up,
                Number(r.down),
            ];
        });
        const lastRow = await R.getRow(
            "SELECT time, ping FROM heartbeat WHERE monitor_id = ? AND ping IS NOT NULL ORDER BY time DESC LIMIT 1",
            [device.monitorId]
        );
        series.push({
            deviceId: device.id,
            monitorId: device.monitorId,
            summary: {
                ...summarizePoints(points),
                last: lastRow ? { time: dayjs.utc(lastRow.time).valueOf(), ping: Number(lastRow.ping) } : null,
            },
            points,
        });
    }
    return { resolution: p.resolution, stepSeconds: p.stepSeconds, effectiveTo: p.effectiveTo, series };
}

module.exports = { RESOLUTIONS, pickResolution, summarizePoints, getPingSummary, getPingSeries };
