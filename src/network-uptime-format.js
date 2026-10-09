/** Presets of the period picker, in seconds. */
export const PRESETS = {
    "1h": 3600,
    "24h": 86400,
    "7d": 604800,
    "30d": 2592000,
};

/**
 * Turn the period chosen in the picker into a concrete range.
 * @param {{preset: string, from?: string, to?: string}} period A preset name, or "custom" with `from` and `to`
 * @param {number} now Current time in ms; a preset counts back from it
 * @returns {{from: string, to: string}} The range as ISO 8601 strings in UTC
 */
export function resolveRange(period, now = Date.now()) {
    if (period.preset === "custom") {
        return { from: period.from, to: period.to };
    }
    return {
        from: new Date(now - PRESETS[period.preset] * 1000).toISOString(),
        to: new Date(now).toISOString(),
    };
}

/**
 * Write a number of seconds as days, hours, minutes and seconds.
 * @param {number} seconds Duration in seconds
 * @param {{day: string, hour: string, minute: string, second: string}} units Text after each number
 * @param {number} maxParts How many units to show at most, counting from the largest non-zero one (default 4)
 * @returns {string} For example "2h 3j 5m 10d"
 */
export function formatDuration(seconds, units, maxParts = 4) {
    const total = Math.max(0, Math.round(seconds));
    const parts = [
        [Math.floor(total / 86400), units.day],
        [Math.floor((total % 86400) / 3600), units.hour],
        [Math.floor((total % 3600) / 60), units.minute],
        [total % 60, units.second],
    ]
        .filter(([value]) => value > 0)
        .slice(0, maxParts)
        .map(([value, unit]) => `${value}${unit}`);
    return parts.length > 0 ? parts.join(" ") : `0${units.second}`;
}

/**
 * Write a percentage the way the locale does, with at most two decimals.
 * @param {number|null} value Percentage, or null when there is none
 * @param {string} locale Locale such as "id" or "en"
 * @returns {string} For example "99,2", or "" for null
 */
export function formatPercent(value, locale) {
    if (value === null || value === undefined) {
        return "";
    }
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

/**
 * Build the text of a CSV file for Excel: BOM, comma separated, text quoted, numbers bare.
 * @param {string[]} headers Column titles
 * @param {(string|number|null|undefined)[][]} rows Rows of cells
 * @returns {string} The CSV text
 */
export function buildUptimeCsv(headers, rows) {
    const cell = (value) => {
        if (value === null || value === undefined) {
            return "";
        }
        if (typeof value === "number") {
            return String(value);
        }
        let text = String(value);
        // Excel runs text starting with one of these as a formula; an apostrophe keeps it as text.
        if (/^[=+\-@\t\r]/.test(text)) {
            text = "'" + text;
        }
        return `"${text.replaceAll('"', '""')}"`;
    };
    const lines = [headers, ...rows].map((row) => row.map((value) => cell(value)).join(","));
    return "﻿" + lines.join("\r\n");
}

/**
 * Name of the CSV file for a range.
 * @param {string} from Start, ISO 8601 in UTC
 * @param {string} to End, ISO 8601 in UTC
 * @param {string} prefix Start of the file name (default "uptime-device")
 * @returns {string} For example "uptime-device-20261007-1000-20261007-1130.csv"
 */
export function csvFileName(from, to, prefix = "uptime-device") {
    const stamp = (iso) => iso.slice(0, 16).replaceAll("-", "").replace("T", "-").replace(":", "");
    return `${prefix}-${stamp(from)}-${stamp(to)}.csv`;
}
