import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

/** Narrowest a bar is drawn, in percent of the track, so a short event stays visible. */
export const MIN_BAR_PERCENT = 0.3;

const HOUR_MS = 3600000;
const MAX_BUCKETS = 10000;

/**
 * Start of the local hour that holds a moment.
 * @param {number} time Moment (ms)
 * @param {string} zone IANA time zone
 * @returns {number} Start of that hour (ms); the zone's own hour edges, so half-hour zones work
 */
function hourStart(time, zone) {
    const offset = dayjs(time).tz(zone).utcOffset() * 60000;
    return Math.floor((time + offset) / HOUR_MS) * HOUR_MS - offset;
}

/**
 * Cut a range into local hours.
 * @param {number} from Start (ms)
 * @param {number} to End (ms)
 * @param {string} zone IANA time zone
 * @returns {{start: number, end: number}[]} Hours, the first starts at or before `from`
 */
function hourBuckets(from, to, zone) {
    const buckets = [];
    let start = hourStart(from, zone);
    while (start < to && buckets.length < MAX_BUCKETS) {
        const end = hourStart(start + HOUR_MS, zone);
        buckets.push({ start, end });
        start = end;
    }
    return buckets;
}

/**
 * Cut a range into local calendar days (a day can be 23 or 25 hours long).
 * @param {number} from Start (ms)
 * @param {number} to End (ms)
 * @param {string} zone IANA time zone
 * @returns {{start: number, end: number, label: string}[]} Days, the first starts at or before `from`
 */
function dayBuckets(from, to, zone) {
    const buckets = [];
    let date = dayjs(from).tz(zone).format("YYYY-MM-DD");
    let start = dayjs.tz(`${date} 00:00:00`, zone).valueOf();
    while (start < to && buckets.length < MAX_BUCKETS) {
        const nextDate = dayjs.utc(date).add(1, "day").format("YYYY-MM-DD");
        const end = dayjs.tz(`${nextDate} 00:00:00`, zone).valueOf();
        buckets.push({ start, end, label: date });
        date = nextDate;
        start = end;
    }
    return buckets;
}

/**
 * Index of the last bucket that starts at or before a moment.
 * @param {{start: number}[]} buckets Buckets in time order
 * @param {number} time Moment (ms)
 * @returns {number} The index
 */
function bucketIndex(buckets, time) {
    let low = 0;
    let high = buckets.length - 1;
    while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (buckets[middle].start <= time) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    return low;
}

/**
 * Visit every period, clipped to the range, with the buckets it touches.
 * @param {[number, number][]} periods Periods `[startMs, endMs]`
 * @param {{start: number, end: number}[]} buckets Buckets in time order
 * @param {number} from Start of the range (ms)
 * @param {number} to End of the range (ms)
 * @param {(index: number) => void} onStart Called with the bucket the period starts in
 * @param {(index: number, ms: number) => void} onOverlap Called with each bucket and the milliseconds of the period in it
 * @returns {void}
 */
function walkPeriods(periods, buckets, from, to, onStart, onOverlap) {
    if (buckets.length === 0) {
        return;
    }
    for (const [rawStart, rawEnd] of periods) {
        const start = Math.max(rawStart, from);
        const end = Math.min(rawEnd, to);
        if (end <= start) {
            continue;
        }
        let index = bucketIndex(buckets, start);
        onStart(index);
        for (; index < buckets.length && buckets[index].start < end; index++) {
            const overlap = Math.min(end, buckets[index].end) - Math.max(start, buckets[index].start);
            if (overlap > 0) {
                onOverlap(index, overlap);
            }
        }
    }
}

/**
 * Count down periods and add up their seconds per hour (range of 48 hours or less) or per day.
 * A period counts on the bucket where it starts; its seconds are split over the buckets it covers.
 * @param {[number, number][]} periods Down periods `[startMs, endMs]`
 * @param {number} from Start of the range (ms)
 * @param {number} to End of the range (ms)
 * @param {string} zone IANA time zone, for example "Asia/Jakarta"
 * @returns {{unit: "day"|"hour", buckets: {start: number, label: string, count: number, seconds: number}[]}} Every bucket of the range, also the empty ones
 */
export function bucketDown(periods, from, to, zone) {
    const unit = to - from <= 48 * HOUR_MS ? "hour" : "day";
    const cuts =
        unit === "hour"
            ? hourBuckets(from, to, zone).map((b) => ({
                  ...b,
                  label: dayjs(b.start).tz(zone).format("YYYY-MM-DD HH:00"),
              }))
            : dayBuckets(from, to, zone);
    const buckets = cuts.map((b) => ({ ...b, count: 0, ms: 0 }));
    walkPeriods(
        periods,
        buckets,
        from,
        to,
        (i) => {
            buckets[i].count++;
        },
        (i, ms) => {
            buckets[i].ms += ms;
        }
    );
    return {
        unit,
        buckets: buckets.map((b) => ({
            start: b.start,
            label: b.label,
            count: b.count,
            seconds: Math.round(b.ms / 1000),
        })),
    };
}

/**
 * Add up the seconds of down time per weekday and hour of the day.
 * @param {[number, number][]} periods Down periods `[startMs, endMs]`
 * @param {number} from Start of the range (ms)
 * @param {number} to End of the range (ms)
 * @param {string} zone IANA time zone
 * @returns {{cells: number[][], max: number}} `cells[weekday][hour]` in seconds, Monday first; `max` is the largest cell
 */
export function heatmapGrid(periods, from, to, zone) {
    const cells = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const buckets = hourBuckets(from, to, zone);
    const place = new Array(buckets.length);
    walkPeriods(
        periods,
        buckets,
        from,
        to,
        () => {},
        (i, ms) => {
            if (!place[i]) {
                const local = dayjs(buckets[i].start).tz(zone);
                place[i] = [(local.day() + 6) % 7, local.hour()];
            }
            cells[place[i][0]][place[i][1]] += ms / 1000;
        }
    );
    let max = 0;
    for (const row of cells) {
        for (let h = 0; h < row.length; h++) {
            row[h] = Math.round(row[h]);
            max = Math.max(max, row[h]);
        }
    }
    return { cells, max };
}

/**
 * Order devices by how often or how long they were down.
 * @param {{deviceId: number, downCount: number, downSeconds: number}[]} devices Devices
 * @param {"count"|"seconds"} by Measure to rank by
 * @param {number} limit How many to keep (default 10)
 * @returns {object[]} Devices that were down, highest first; ties go to the other measure, then the lower id
 */
export function rankDevices(devices, by, limit = 10) {
    const primary = by === "count" ? "downCount" : "downSeconds";
    const secondary = by === "count" ? "downSeconds" : "downCount";
    return devices
        .filter((d) => d.downCount > 0 || d.downSeconds > 0)
        .sort((a, b) => b[primary] - a[primary] || b[secondary] - a[secondary] || a.deviceId - b.deviceId)
        .slice(0, limit);
}

/**
 * Position a time span on a track that stands for the range.
 * @param {number} start Start of the span (ms)
 * @param {number} end End of the span (ms)
 * @param {number} from Start of the range (ms)
 * @param {number} to End of the range (ms)
 * @returns {{leftPercent: number, widthPercent: number, start: number, end: number}|null} The bar, clipped to the range; null when it is outside
 */
function bar(start, end, from, to) {
    const clippedStart = Math.max(start, from);
    const clippedEnd = Math.min(end, to);
    if (clippedEnd <= clippedStart || to <= from) {
        return null;
    }
    const span = to - from;
    const widthPercent = Math.max(((clippedEnd - clippedStart) * 100) / span, MIN_BAR_PERCENT);
    const leftPercent = Math.min(((clippedStart - from) * 100) / span, 100 - widthPercent);
    return { leftPercent, widthPercent, start: clippedStart, end: clippedEnd };
}

/**
 * Rows of a down timeline for the devices that were down the longest.
 * @param {{deviceId: number, downSeconds: number, periods: [number, number][]}[]} devices Devices
 * @param {number} from Start of the range (ms)
 * @param {number} to End of the range (ms)
 * @param {number} limit How many devices to keep (default 30)
 * @returns {{deviceId: number, bars: {leftPercent: number, widthPercent: number, start: number, end: number}[]}[]} One row per device
 */
export function timelineRows(devices, from, to, limit = 30) {
    return devices
        .filter((d) => d.downSeconds > 0)
        .sort((a, b) => b.downSeconds - a.downSeconds || a.deviceId - b.deviceId)
        .slice(0, limit)
        .map((d) => ({
            deviceId: d.deviceId,
            bars: d.periods.map(([start, end]) => bar(start, end, from, to)).filter((b) => b !== null),
        }));
}

/**
 * Bars of a status timeline for one device.
 * @param {{start: number, end: number, state: string}[]} segments Status segments
 * @param {number} from Start of the range (ms)
 * @param {number} to End of the range (ms)
 * @returns {{leftPercent: number, widthPercent: number, state: string, start: number, end: number}[]} One bar per segment inside the range
 */
export function segmentBars(segments, from, to) {
    const bars = [];
    for (const segment of segments) {
        const b = bar(segment.start, segment.end, from, to);
        if (b !== null) {
            bars.push({ ...b, state: segment.state });
        }
    }
    return bars;
}
