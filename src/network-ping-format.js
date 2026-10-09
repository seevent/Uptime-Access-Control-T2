/** Highest ping (ms) that counts as good. */
export const PING_GOOD_MAX = 50;

/** Highest ping (ms) that counts as fair; above it the ping is slow. */
export const PING_FAIR_MAX = 150;

/**
 * Tell how good a ping is.
 * @param {number|null|undefined} ms Ping in milliseconds
 * @returns {"good"|"fair"|"slow"|null} The level, or null when there is no ping
 */
export function pingLevel(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) {
        return null;
    }
    if (ms <= PING_GOOD_MAX) {
        return "good";
    }
    return ms <= PING_FAIR_MAX ? "fair" : "slow";
}

/**
 * Write a ping the way the locale does.
 * @param {number|null} ms Ping in milliseconds
 * @param {string} locale Locale such as "id" or "en"
 * @returns {string} For example "0,8 ms" or "12 ms"; "—" when there is no ping
 */
export function formatPing(ms, locale) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) {
        return "—";
    }
    const digits = ms < 10 ? 1 : 0;
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(ms)} ms`;
}

/**
 * Order devices by a ping measure, highest first.
 * @param {{deviceId: number, samples: number, avg: number|null, min: number|null, max: number|null}[]} items Ping summary items
 * @param {"avg"|"max"|"spread"} metric Measure to rank by; `spread` is the highest minus the lowest ping
 * @param {number} limit How many to keep (default 10)
 * @returns {object[]} The items with a ping, ties broken by the average and then the device id
 */
export function rankPing(items, metric, limit = 10) {
    const value = (item) => (metric === "spread" ? item.max - item.min : item[metric]);
    return items
        .filter((item) => item.samples > 0 && item.avg !== null)
        .sort((a, b) => value(b) - value(a) || b.avg - a.avg || a.deviceId - b.deviceId)
        .slice(0, limit);
}

/**
 * Turn the buckets of a ping series into chart points, leaving a gap (a null point) where buckets are missing.
 * @param {[number, number|null, number|null, number|null, number, number][]} points Buckets `[timeMs, avg, min, max, up, down]`
 * @param {number} stepSeconds Length of a bucket
 * @returns {{x: number, y: number|null, min: number|null, max: number|null, up: number, down: number}[]} Chart points
 */
export function pingChartPoints(points, stepSeconds) {
    const out = [];
    let previous = null;
    for (const [time, avg, min, max, up, down] of points) {
        if (previous !== null && time - previous > stepSeconds * 1500) {
            out.push({ x: previous + stepSeconds * 1000, y: null, min: null, max: null, up: 0, down: 0 });
        }
        out.push({ x: time, y: avg, min, max, up, down });
        previous = time;
    }
    return out;
}

/**
 * Pick the devices to draw by default: the ones with the highest average ping.
 * @param {object[]} items Ping summary items
 * @param {number} count How many to pick (default 3)
 * @returns {number[]} Device ids
 */
export function defaultSeriesIds(items, count = 3) {
    return rankPing(items, "avg", count).map((item) => item.deviceId);
}
