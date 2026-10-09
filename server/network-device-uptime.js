const { R } = require("redbean-node");
const dayjs = require("dayjs");
const { UP, DOWN, PENDING, MAINTENANCE } = require("../src/util");
const { getDevicesByIds, listDevices, parseDeviceIds } = require("./network-device-store");

dayjs.extend(require("dayjs/plugin/utc"));

const MAX_RANGE_DAYS = 366;
const MAX_DOWN_PERIODS = 500;
const MAX_SEGMENTS = 5000;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Validate the time range typed by the user.
 * @param {string} from Start, ISO 8601 with a time zone
 * @param {string} to End, ISO 8601 with a time zone
 * @returns {{fromMs: number, toMs: number}} The range in milliseconds since the epoch
 * @throws {Error} When a value is not a time, the start is not before the end, or the range is longer than 366 days
 */
function parseRange(from, to) {
    const parse = (value) => (typeof value === "string" && ISO_TIME.test(value) ? Date.parse(value) : NaN);
    const fromMs = parse(from);
    const toMs = parse(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
        throw new Error("Rentang waktu tidak valid");
    }
    if (fromMs >= toMs) {
        throw new Error("Awal harus sebelum akhir");
    }
    if (toMs - fromMs > MAX_RANGE_DAYS * 86400000) {
        throw new Error(`Rentang maksimal ${MAX_RANGE_DAYS} hari`);
    }
    return { fromMs, toMs };
}

/**
 * Work out how long a monitor was up, down, in maintenance, pending, or unobserved in a time range.
 * Each beat holds until the next one. When two beats are further apart than twice the longest check interval
 * (plus 5 s), only one interval after the earlier beat is counted and the rest is "no data".
 * @param {object} params Parameters
 * @param {{time: number, status: number, msg: string|null}[]} params.beats Beats in ascending time order (ms); may include one beat before `from`
 * @param {number} params.from Start of the range (ms)
 * @param {number} params.to End of the range (ms)
 * @param {number} params.now Current time (ms); time after it is never counted
 * @param {number} params.intervalSec Check interval of the monitor
 * @param {number} params.retryIntervalSec Retry interval of the monitor
 * @param {number} params.maxDownPeriods How many down periods to return at most (default 500)
 * @param {boolean} params.withSegments Also return `segments`, the counted time as runs of one state (default false)
 * @param {number} params.maxSegments How many segments to return at most, the newest (default 5000)
 * @returns {object} Seconds per state, uptime percentage and the down periods (times in ms); with `withSegments`
 *     also `segments` (`{start, end, state}`, state is "up", "down", "maintenance" or "pending") and `segmentsTruncated`
 */
function summarizeBeats(params) {
    const { beats, from, to, now, intervalSec, retryIntervalSec } = params;
    const maxDownPeriods = params.maxDownPeriods ?? MAX_DOWN_PERIODS;
    const maxSegments = params.maxSegments ?? MAX_SEGMENTS;
    const end = Math.min(to, now);
    const limitMs = (2 * Math.max(intervalSec, retryIntervalSec) + 5) * 1000;
    const intervalMs = intervalSec * 1000;

    const ms = { up: 0, down: 0, maintenance: 0, pending: 0 };
    const periods = [];
    const segments = [];
    let open = null;
    const addSegment = (state, from, to) => {
        if (params.withSegments !== true) {
            return;
        }
        const last = segments[segments.length - 1];
        if (last && last.state === state && last.end === from) {
            last.end = to;
        } else {
            segments.push({ start: from, end: to, state });
        }
    };

    for (let i = 0; i < beats.length; i++) {
        const beat = beats[i];
        const next = i + 1 < beats.length ? beats[i + 1].time : end;
        const length = next - beat.time;
        if (length <= 0 || beat.time >= end) {
            continue;
        }
        const complete = length <= limitMs;
        const credited = complete ? length : Math.min(length, intervalMs);
        const start = Math.max(beat.time, from);
        const stop = Math.min(beat.time + credited, end);
        if (stop <= start) {
            open = null;
            continue;
        }
        const duration = stop - start;

        if (beat.status === UP) {
            ms.up += duration;
            addSegment("up", start, stop);
        } else if (beat.status === MAINTENANCE) {
            ms.maintenance += duration;
            addSegment("maintenance", start, stop);
        } else if (beat.status === PENDING) {
            ms.pending += duration;
            addSegment("pending", start, stop);
        } else if (beat.status === DOWN) {
            ms.down += duration;
            addSegment("down", start, stop);
            if (open && open.end === start) {
                open.end = stop;
            } else {
                open = { start, end: stop, msg: beat.msg ?? null };
                periods.push(open);
            }
            continue;
        }
        open = null;
    }

    const seconds = (value) => Math.round(value / 1000);
    const spanSeconds = Math.max(0, seconds(end - from));
    const upSeconds = seconds(ms.up);
    const downSeconds = seconds(ms.down);
    const maintenanceSeconds = seconds(ms.maintenance);
    const pendingSeconds = seconds(ms.pending);
    const noDataSeconds = Math.max(0, spanSeconds - upSeconds - downSeconds - maintenanceSeconds - pendingSeconds);

    const downPeriods = periods.slice(-maxDownPeriods).map((p) => ({
        start: p.start,
        end: p.end,
        seconds: seconds(p.end - p.start),
        msg: p.msg,
    }));

    const result = {
        effectiveTo: end,
        spanSeconds,
        upSeconds,
        downSeconds,
        maintenanceSeconds,
        pendingSeconds,
        noDataSeconds,
        uptimePercent: ms.up + ms.down > 0 ? (ms.up / (ms.up + ms.down)) * 100 : null,
        downCount: periods.length,
        downPeriods,
        downPeriodsTruncated: periods.length > maxDownPeriods,
    };
    if (params.withSegments) {
        result.segments = segments.slice(-maxSegments);
        result.segmentsTruncated = segments.length > maxSegments;
    }
    return result;
}

/**
 * Time as an ISO 8601 string in UTC.
 * @param {number} ms Milliseconds since the epoch
 * @returns {string} For example "2026-10-07T10:00:00.000Z"
 */
function toIso(ms) {
    return new Date(ms).toISOString();
}

/**
 * Read the beats of a monitor that matter for a range, and summarize them.
 * @param {number} monitorId Monitor id
 * @param {{fromMs: number, toMs: number}} range The range
 * @param {number} now Current time (ms)
 * @param {{withSegments?: boolean, maxDownPeriods?: number}} options Pass `withSegments` to get the status segments too; `maxDownPeriods` replaces the default limit of down periods
 * @returns {Promise<object>} Result of `summarizeBeats` (times in ms) plus `dataSince` (ms or null)
 * @throws {Error} When the monitor does not exist
 */
async function summarizeMonitor(monitorId, range, now, options = {}) {
    const monitor = await R.getRow("SELECT * FROM monitor WHERE id = ?", [monitorId]);
    if (!monitor) {
        throw new Error("Perangkat belum dimonitor");
    }
    const intervalSec = Number(monitor.interval) || 60;
    const retryIntervalSec = Number(monitor.retry_interval) || intervalSec;

    const end = Math.min(range.toMs, now);
    const columns = `status, time, CASE WHEN status = ${DOWN} THEN msg END AS msg`;
    const inRange = await R.getAll(
        `SELECT ${columns} FROM heartbeat WHERE monitor_id = ? AND time >= ? AND time <= ? ORDER BY time`,
        [monitorId, R.isoDateTimeMillis(dayjs.utc(range.fromMs)), R.isoDateTimeMillis(dayjs.utc(end))]
    );
    const before = await R.getRow(
        `SELECT ${columns} FROM heartbeat WHERE monitor_id = ? AND time < ? ORDER BY time DESC LIMIT 1`,
        [monitorId, R.isoDateTimeMillis(dayjs.utc(range.fromMs))]
    );
    const first = await R.getRow("SELECT MIN(time) AS first FROM heartbeat WHERE monitor_id = ?", [monitorId]);

    const toBeat = (row) => ({ time: dayjs.utc(row.time).valueOf(), status: Number(row.status), msg: row.msg ?? null });
    const summary = summarizeBeats({
        beats: [...(before ? [toBeat(before)] : []), ...inRange.map(toBeat)],
        from: range.fromMs,
        to: range.toMs,
        now,
        intervalSec,
        retryIntervalSec,
        withSegments: options.withSegments === true,
        maxDownPeriods: options.maxDownPeriods,
    });
    return { ...summary, dataSince: first && first.first ? dayjs.utc(first.first).valueOf() : null };
}

/**
 * Uptime details of one device in a time range.
 * @param {object} params Parameters
 * @param {number} params.deviceId Device id
 * @param {string} params.from Start, ISO 8601
 * @param {string} params.to End, ISO 8601
 * @param {number} params.now Current time in ms (default: now)
 * @returns {Promise<object>} Seconds per state, percentage, down periods, `effectiveTo` and `dataSince` (ISO strings)
 * @throws {Error} When the range is invalid, the device does not exist, or it has no monitor
 */
async function getDeviceUptime(params) {
    const range = parseRange(params.from, params.to);
    const now = params.now ?? Date.now();
    const [device] = await getDevicesByIds([params.deviceId]);
    if (!device) {
        throw new Error("Perangkat tidak ditemukan");
    }
    if (device.monitorId === null) {
        throw new Error("Perangkat belum dimonitor");
    }
    const result = await summarizeMonitor(device.monitorId, range, now);
    return {
        ...result,
        monitorId: device.monitorId,
        effectiveTo: toIso(result.effectiveTo),
        dataSince: result.dataSince === null ? null : toIso(result.dataSince),
        downPeriods: result.downPeriods.map((p) => ({ ...p, start: toIso(p.start), end: toIso(p.end) })),
    };
}

/**
 * Uptime summary of every device that has a monitor, one after the other to keep memory low.
 * @param {object} params Parameters
 * @param {string} params.from Start, ISO 8601
 * @param {string} params.to End, ISO 8601
 * @param {number} params.now Current time in ms (default: now)
 * @param {number[]} params.deviceIds Only these devices (default: all); an empty list means none
 * @returns {Promise<{items: object[]}>} One item per monitored device, without down periods
 * @throws {Error} When the range or the device ids are invalid
 */
async function getUptimeSummary(params) {
    const range = parseRange(params.from, params.to);
    const now = params.now ?? Date.now();
    const only = parseDeviceIds(params.deviceIds);
    const items = [];
    for (const device of await listDevices()) {
        if (device.monitorId === null || (only && !only.has(device.id))) {
            continue;
        }
        const r = await summarizeMonitor(device.monitorId, range, now);
        items.push({
            deviceId: device.id,
            monitorId: device.monitorId,
            effectiveTo: toIso(r.effectiveTo),
            spanSeconds: r.spanSeconds,
            upSeconds: r.upSeconds,
            downSeconds: r.downSeconds,
            maintenanceSeconds: r.maintenanceSeconds,
            pendingSeconds: r.pendingSeconds,
            noDataSeconds: r.noDataSeconds,
            uptimePercent: r.uptimePercent,
            downCount: r.downCount,
        });
    }
    return { items };
}

module.exports = { summarizeBeats, parseRange, summarizeMonitor, getDeviceUptime, getUptimeSummary };
