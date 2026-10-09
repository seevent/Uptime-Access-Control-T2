const dayjs = require("dayjs");
const { R } = require("redbean-node");
const { listDevices, listCategories } = require("./network-device-store");
const { buildXlsx } = require("./xlsx-writer");

/** The first eight columns are the ones the import reads, in the order of the import template. */
const HEADERS = [
    "IP",
    "Nama",
    "Kategori",
    "Sub kategori",
    "Tipe",
    "Port",
    "Path",
    "Community",
    "MAC",
    "Vendor",
    "Hostname",
    "Status",
    "Pertama terlihat",
    "Terakhir terlihat",
    "Dimonitor",
    "Bergantung pada",
    "Perangkat asing",
];

const MONITOR_TYPES = new Set(["ping", "port", "http", "rtsp", "snmp"]);

/**
 * Read the stored time of a device as local time.
 * @param {string|null} value Time as stored (UTC text) or null
 * @returns {string} "YYYY-MM-DD HH:mm:ss", "" when there is no time or it cannot be read
 */
function formatStamp(value) {
    if (!value) {
        return "";
    }
    const text = String(value);
    const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text.replace(" ", "T")}Z`);
    return Number.isFinite(ms) ? dayjs(ms).format("YYYY-MM-DD HH:mm:ss") : text;
}

/**
 * How the import has to be told to watch the same thing as a monitor does.
 * @param {{type: string, port: number|null, url: string|null}} monitor Row of the monitor table
 * @returns {{type: string, port: number|string, path: string}} Cells for Tipe, Port and Path; empty for a monitor of
 *     another kind (made on the dashboard), which the import has no word for
 */
function describeMonitor(monitor) {
    if (!monitor || !MONITOR_TYPES.has(monitor.type)) {
        return { type: "", port: "", path: "" };
    }
    if (monitor.type === "ping") {
        return { type: "ping", port: "", path: "" };
    }
    if (monitor.type === "http") {
        try {
            const url = new URL(monitor.url);
            const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
            const path = `${url.pathname}${url.search}`;
            return { type: "http", port, path: path === "/" ? "" : path };
        } catch (e) {
            return { type: "http", port: "", path: "" };
        }
    }
    return { type: monitor.type, port: monitor.port ?? "", path: "" };
}

/**
 * Collect the rows of the inventory sheet.
 * @returns {Promise<{rows: unknown[][], devices: number}>} Rows with the header row first, and how many devices there are
 */
async function getInventoryRows() {
    const devices = await listDevices();
    const categories = await listCategories();
    const categoryName = new Map();
    const subName = new Map();
    for (const category of categories) {
        categoryName.set(category.id, category.name);
        for (const sub of category.subcategories) {
            subName.set(sub.id, sub.name);
        }
    }

    // Only what the sheet shows is read from the monitors: never the SNMP community or any other secret
    const monitors = new Map();
    const monitorIds = devices.map((d) => d.monitorId).filter((id) => id !== null);
    for (let i = 0; i < monitorIds.length; i += 500) {
        const chunk = monitorIds.slice(i, i + 500);
        const rows = await R.getAll(
            `SELECT id, type, port, url FROM monitor WHERE id IN (${chunk.map(() => "?").join(",")})`,
            chunk
        );
        for (const row of rows) {
            monitors.set(row.id, row);
        }
    }

    const byId = new Map(devices.map((d) => [d.id, d]));
    const rows = [HEADERS.map((v) => ({ v, style: "header" }))];
    for (const device of devices) {
        const monitor = device.monitorId !== null ? monitors.get(device.monitorId) : undefined;
        const how = describeMonitor(monitor);
        const parent = device.dependsOnId !== null ? byId.get(device.dependsOnId) : undefined;
        rows.push([
            device.ip,
            device.label || "",
            device.categoryId !== null ? categoryName.get(device.categoryId) || "" : "",
            device.subcategoryId !== null ? subName.get(device.subcategoryId) || "" : "",
            how.type,
            how.port,
            how.path,
            // Left empty on purpose: a file that is mailed around must not carry the SNMP community
            "",
            device.mac || "",
            device.vendor || "",
            device.hostname || "",
            device.isOnline ? "online" : "offline",
            formatStamp(device.firstSeen),
            formatStamp(device.lastSeen),
            monitor ? "Ya" : "Tidak",
            parent ? parent.label || parent.ip : "",
            device.acknowledged ? "" : "Ya",
        ]);
    }
    return { rows, devices: devices.length };
}

/**
 * Make the Excel file of the whole inventory.
 * @param {object} params Parameters
 * @param {number} params.now Current time in ms (default: now)
 * @returns {Promise<{filename: string, buffer: Buffer, devices: number}>} The file
 */
async function buildInventoryExport({ now = Date.now() } = {}) {
    const { rows, devices } = await getInventoryRows();
    const info = [
        [{ v: "Inventaris perangkat jaringan", style: "title" }],
        [],
        ["Dibuat pada", dayjs(now).format("YYYY-MM-DD HH:mm:ss")],
        ["Jumlah perangkat", devices],
        [],
        [
            "Impor ulang",
            "Delapan kolom pertama (IP sampai Community) bisa diimpor lagi lewat tombol Impor. Kolom setelahnya hanya informasi.",
        ],
        [
            "Community",
            "Sengaja dikosongkan supaya file ini aman dikirim. Isi sendiri sebelum mengimpor perangkat SNMP.",
        ],
        [
            "Perangkat tanpa monitor",
            "Kolom Tipe kosong. Kalau diimpor, perangkat itu akan dimonitor dengan tipe bawaan di dialog impor.",
        ],
    ];
    const sheets = [
        {
            name: "Perangkat",
            rows,
            columns: [
                { width: 16 },
                { width: 32 },
                { width: 22 },
                { width: 20 },
                { width: 8 },
                { width: 8, format: "integer" },
                { width: 16 },
                { width: 14 },
                { width: 18 },
                { width: 24 },
                { width: 26 },
                { width: 10 },
                { width: 20 },
                { width: 20 },
                { width: 10 },
                { width: 28 },
                { width: 10 },
            ],
        },
        { name: "Info", rows: info, columns: [{ width: 26 }, { width: 100 }], freezeHeader: false },
    ];
    return {
        filename: `inventaris-jaringan-${dayjs(now).format("YYYYMMDD-HHmm")}.xlsx`,
        buffer: buildXlsx(sheets, new Date(now)),
        devices,
    };
}

module.exports = { HEADERS, describeMonitor, formatStamp, getInventoryRows, buildInventoryExport };
