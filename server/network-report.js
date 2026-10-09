const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
const { listDevices, listCategories } = require("./network-device-store");
const { summarizeMonitor } = require("./network-device-uptime");
const { getPingSummary } = require("./network-device-ping");
const { buildXlsx } = require("./xlsx-writer");

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MAX_EVENT_ROWS = 20000;
const NO_CATEGORY = "(tanpa kategori)";
const NO_SUBCATEGORY = "(tanpa sub kategori)";
const ALL = "(semua)";
const MONTH_NAMES = [
    "Januari",
    "Februari",
    "Maret",
    "April",
    "Mei",
    "Juni",
    "Juli",
    "Agustus",
    "September",
    "Oktober",
    "November",
    "Desember",
];

/**
 * Start and end of a month in the time zone of the server.
 * @param {string} month Month as "YYYY-MM"
 * @returns {{year: number, monthIndex: number, fromMs: number, toMs: number}} The month; the end is the start of the next month
 * @throws {Error} When the month is not written as YYYY-MM or the year is not between 2000 and 2100
 */
function monthRange(month) {
    const match = typeof month === "string" ? MONTH_PATTERN.exec(month) : null;
    const year = match ? Number(match[1]) : NaN;
    if (!match || year < 2000 || year > 2100) {
        throw new Error("Bulan tidak valid (tulis sebagai TTTT-BB, misalnya 2026-09)");
    }
    const monthIndex = Number(match[2]) - 1;
    return {
        year,
        monthIndex,
        fromMs: new Date(year, monthIndex, 1).getTime(),
        toMs: new Date(year, monthIndex + 1, 1).getTime(),
    };
}

/**
 * The month before the one that contains a moment.
 * @param {number} nowMs Moment (ms)
 * @returns {string} "YYYY-MM"
 */
function previousMonth(nowMs) {
    const now = new Date(nowMs);
    const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * @param {number} seconds Seconds
 * @returns {string} For example "1 hari 2 jam 5 mnt", at most three units, "0 dtk" for nothing
 */
function formatDuration(seconds) {
    let rest = Math.max(0, Math.round(seconds));
    const units = [
        ["hari", 86400],
        ["jam", 3600],
        ["mnt", 60],
        ["dtk", 1],
    ];
    const parts = [];
    for (const [name, size] of units) {
        const count = Math.floor(rest / size);
        rest -= count * size;
        if (count > 0 && parts.length < 3) {
            parts.push(`${count} ${name}`);
        }
    }
    return parts.length > 0 ? parts.join(" ") : "0 dtk";
}

/**
 * Add up the results of several devices.
 * @param {{upSeconds: number, downSeconds: number, downCount: number, ping: {samples: number, avg: number|null, min: number|null, max: number|null}}[]} rows Results per device
 * @returns {object} Device count, uptime (up / (up + down), null without data), down count, down seconds and ping
 */
function aggregate(rows) {
    let up = 0;
    let down = 0;
    let downCount = 0;
    let samples = 0;
    let weighted = 0;
    let min = null;
    let max = null;
    for (const row of rows) {
        up += row.upSeconds;
        down += row.downSeconds;
        downCount += row.downCount;
        if (row.ping.samples > 0 && row.ping.avg !== null) {
            samples += row.ping.samples;
            weighted += row.ping.avg * row.ping.samples;
            min = min === null ? row.ping.min : Math.min(min, row.ping.min);
            max = max === null ? row.ping.max : Math.max(max, row.ping.max);
        }
    }
    return {
        devices: rows.length,
        uptimePercent: up + down > 0 ? (up / (up + down)) * 100 : null,
        downCount,
        downSeconds: down,
        pingAvg: samples > 0 ? weighted / samples : null,
        pingMin: min,
        pingMax: max,
    };
}

/**
 * Collect the figures of a month for every monitored device.
 * @param {object} params Parameters
 * @param {string} params.month Month as "YYYY-MM"
 * @param {number} params.now Current time in ms (default: now)
 * @returns {Promise<object>} `{ month, label, fromMs, effectiveTo, partial, devices, categories, events, truncatedDevices, eventsTruncated }`
 * @throws {Error} When the month is not valid or has not started yet
 */
async function getMonthlyReport({ month, now = Date.now() }) {
    const range = monthRange(month);
    if (range.fromMs >= now) {
        throw new Error("Bulan ini belum dimulai");
    }
    const from = new Date(range.fromMs).toISOString();
    const to = new Date(range.toMs).toISOString();

    const categories = await listCategories();
    const categoryName = new Map();
    const subName = new Map();
    for (const category of categories) {
        categoryName.set(category.id, category.name);
        for (const sub of category.subcategories) {
            subName.set(sub.id, sub.name);
        }
    }
    const ping = new Map((await getPingSummary({ from, to, now })).items.map((item) => [item.deviceId, item]));

    const devices = [];
    const events = [];
    const truncatedDevices = [];
    for (const device of await listDevices()) {
        if (device.monitorId === null) {
            continue;
        }
        let result;
        try {
            result = await summarizeMonitor(device.monitorId, range, now);
        } catch (e) {
            // A monitor that was removed behind the back of the inventory has nothing to report
            continue;
        }
        const p = ping.get(device.id);
        const row = {
            id: device.id,
            ip: device.ip,
            name: device.label || "",
            category: device.categoryId !== null ? categoryName.get(device.categoryId) || "" : "",
            subcategory: device.subcategoryId !== null ? subName.get(device.subcategoryId) || "" : "",
            upSeconds: result.upSeconds,
            downSeconds: result.downSeconds,
            downCount: result.downCount,
            uptimePercent: result.uptimePercent,
            ping: { samples: p?.samples ?? 0, avg: p?.avg ?? null, min: p?.min ?? null, max: p?.max ?? null },
        };
        devices.push(row);
        if (result.downPeriodsTruncated) {
            truncatedDevices.push(row.name || row.ip);
        }
        for (const period of result.downPeriods) {
            events.push({
                ...period,
                ip: row.ip,
                name: row.name,
                category: row.category,
                subcategory: row.subcategory,
            });
        }
    }
    events.sort((a, b) => a.start - b.start);

    // Totals per category and sub category, in the order of the category list; devices without a category last
    const groups = [];
    const names = [...categories.map((c) => c.name), ""];
    for (const name of names) {
        const inCategory = devices.filter((d) => d.category === name);
        if (inCategory.length === 0) {
            continue;
        }
        const category = categories.find((c) => c.name === name);
        const subs = [];
        for (const sub of category ? category.subcategories : []) {
            const rows = inCategory.filter((d) => d.subcategory === sub.name);
            if (rows.length > 0) {
                subs.push({ name: sub.name, ...aggregate(rows) });
            }
        }
        const without = inCategory.filter((d) => d.subcategory === "");
        if (without.length > 0 && subs.length > 0) {
            subs.push({ name: "", ...aggregate(without) });
        }
        groups.push({ name, total: aggregate(inCategory), subs });
    }

    return {
        month,
        label: `${MONTH_NAMES[range.monthIndex]} ${range.year}`,
        fromMs: range.fromMs,
        toMs: range.toMs,
        effectiveTo: Math.min(range.toMs, now),
        partial: range.toMs > now,
        devices,
        groups,
        total: aggregate(devices),
        events: events.slice(0, MAX_EVENT_ROWS),
        eventsTruncated: events.length > MAX_EVENT_ROWS,
        truncatedDevices,
        generatedAt: now,
    };
}

/**
 * @param {number} ms Moment (ms)
 * @returns {string} Local time as "YYYY-MM-DD HH:mm:ss"
 */
function formatTime(ms) {
    return dayjs(ms).format("YYYY-MM-DD HH:mm:ss");
}

/**
 * Lay the report out as the sheets of an Excel file.
 * @param {object} report Result of `getMonthlyReport`
 * @returns {object[]} Sheets for `buildXlsx`
 */
function reportToSheets(report) {
    const h = (v) => ({ v, style: "header" });
    const minutes = (seconds) => Math.round((seconds / 60) * 10) / 10;
    const round2 = (value) => (value === null || value === undefined ? null : Math.round(value * 100) / 100);

    const summaryRows = [
        [
            h("Kategori"),
            h("Sub kategori"),
            h("Jumlah perangkat"),
            h("Uptime (%)"),
            h("Jumlah down"),
            h("Total down"),
            h("Total down (menit)"),
            h("Ping rata-rata (ms)"),
            h("Ping terendah (ms)"),
            h("Ping tertinggi (ms)"),
        ],
    ];
    const summaryLine = (category, sub, a) => [
        category,
        sub,
        a.devices,
        round2(a.uptimePercent),
        a.downCount,
        formatDuration(a.downSeconds),
        minutes(a.downSeconds),
        round2(a.pingAvg),
        round2(a.pingMin),
        round2(a.pingMax),
    ];
    for (const group of report.groups) {
        const category = group.name || NO_CATEGORY;
        summaryRows.push(summaryLine({ v: category, style: "header" }, ALL, group.total));
        for (const sub of group.subs) {
            summaryRows.push(summaryLine(category, sub.name || NO_SUBCATEGORY, sub));
        }
    }
    summaryRows.push(summaryLine({ v: "SEMUA PERANGKAT", style: "header" }, "", report.total));

    const deviceRows = [
        [
            h("Kategori"),
            h("Sub kategori"),
            h("IP"),
            h("Nama"),
            h("Uptime (%)"),
            h("Jumlah down"),
            h("Total down"),
            h("Total down (menit)"),
            h("Ping rata-rata (ms)"),
            h("Ping terendah (ms)"),
            h("Ping tertinggi (ms)"),
        ],
    ];
    for (const d of report.devices) {
        deviceRows.push([
            d.category,
            d.subcategory,
            d.ip,
            d.name,
            round2(d.uptimePercent),
            d.downCount,
            formatDuration(d.downSeconds),
            minutes(d.downSeconds),
            round2(d.ping.avg),
            round2(d.ping.min),
            round2(d.ping.max),
        ]);
    }

    const eventRows = [
        [
            h("Kategori"),
            h("Sub kategori"),
            h("IP"),
            h("Nama"),
            h("Mulai"),
            h("Selesai"),
            h("Durasi"),
            h("Durasi (menit)"),
            h("Pesan"),
        ],
    ];
    for (const e of report.events) {
        eventRows.push([
            e.category,
            e.subcategory,
            e.ip,
            e.name,
            formatTime(e.start),
            formatTime(e.end),
            formatDuration(e.seconds),
            minutes(e.seconds),
            e.msg || "",
        ]);
    }

    const info = [
        [{ v: `Laporan jaringan ${report.label}`, style: "title" }],
        [],
        ["Periode", `${formatTime(report.fromMs)} sampai ${formatTime(report.effectiveTo)}`],
        ["Dibuat pada", formatTime(report.generatedAt)],
        ["Jumlah perangkat dimonitor", report.devices.length],
        [],
        ["Uptime", "Waktu up dibagi (waktu up + waktu down). Waktu pemeliharaan dan waktu tanpa data tidak dihitung."],
        ["Jumlah down", "Berapa kali perangkat berpindah ke status down (kejadian down berurutan dihitung satu)."],
        ["Ping", "Rata-rata dibobot jumlah pengecekan yang berhasil; terendah dan tertinggi dari seluruh periode."],
    ];
    if (report.partial) {
        info.push([], ["Catatan", "Bulan ini belum selesai: angka hanya sampai waktu pembuatan laporan."]);
    }
    if (report.eventsTruncated) {
        info.push([], ["Catatan", `Lembar kejadian hanya memuat ${MAX_EVENT_ROWS} kejadian pertama.`]);
    }
    if (report.truncatedDevices.length > 0) {
        info.push(
            [],
            [
                "Catatan",
                `Kejadian down terlalu banyak dan sebagian tidak tercantum: ${report.truncatedDevices.join(", ")}`,
            ]
        );
    }

    return [
        {
            name: "Ringkasan",
            rows: summaryRows,
            columns: [
                { width: 24 },
                { width: 22 },
                { width: 12, format: "integer" },
                { width: 12, format: "decimal" },
                { width: 12, format: "integer" },
                { width: 24 },
                { width: 14, format: "decimal" },
                { width: 14, format: "decimal" },
                { width: 14, format: "decimal" },
                { width: 14, format: "decimal" },
            ],
        },
        {
            name: "Per perangkat",
            rows: deviceRows,
            columns: [
                { width: 24 },
                { width: 22 },
                { width: 16 },
                { width: 30 },
                { width: 12, format: "decimal" },
                { width: 12, format: "integer" },
                { width: 24 },
                { width: 14, format: "decimal" },
                { width: 14, format: "decimal" },
                { width: 14, format: "decimal" },
                { width: 14, format: "decimal" },
            ],
        },
        {
            name: "Kejadian down",
            rows: eventRows,
            columns: [
                { width: 24 },
                { width: 22 },
                { width: 16 },
                { width: 30 },
                { width: 20 },
                { width: 20 },
                { width: 22 },
                { width: 14, format: "decimal" },
                { width: 60 },
            ],
        },
        { name: "Info", rows: info, columns: [{ width: 28 }, { width: 100 }], freezeHeader: false },
    ];
}

/**
 * Make the Excel report of a month.
 * @param {object} params Parameters
 * @param {string} params.month Month as "YYYY-MM"
 * @param {number} params.now Current time in ms (default: now)
 * @returns {Promise<{filename: string, buffer: Buffer, devices: number, partial: boolean}>} The file
 * @throws {Error} When the month is not valid or has not started yet
 */
async function buildMonthlyReport({ month, now = Date.now() }) {
    const report = await getMonthlyReport({ month, now });
    return {
        filename: `laporan-jaringan-${report.month}.xlsx`,
        buffer: buildXlsx(reportToSheets(report), new Date(now)),
        devices: report.devices.length,
        partial: report.partial,
    };
}

module.exports = {
    monthRange,
    previousMonth,
    formatDuration,
    aggregate,
    getMonthlyReport,
    reportToSheets,
    buildMonthlyReport,
};
