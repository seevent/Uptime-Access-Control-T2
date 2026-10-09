const net = require("node:net");
const { R } = require("redbean-node");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
const { MIN_INTERVAL_SECOND } = require("../src/util");
const { listDevices } = require("./network-device-store");
const { parsePort } = require("./network-device-monitoring");

const MAX_ROWS = 1000;
const MAX_LABEL_LENGTH = 255;
const MAX_CATEGORY_NAME_LENGTH = 100;
const TYPES = new Set(["ping", "port"]);

/**
 * @param {unknown} value Raw cell value
 * @returns {string} Trimmed text, "" for nothing
 */
function text(value) {
    return String(value ?? "").trim();
}

/**
 * Check the settings that apply to the whole import.
 * @param {object} options Settings from the client
 * @returns {{type: string, port: number|null, interval: number, parent: number|null, notificationIDList: object}} Clean settings
 * @throws {Error} When a setting is invalid; nothing is imported then
 */
function normalizeOptions(options) {
    const settings = options || {};
    const type = text(settings.type).toLowerCase();
    if (!TYPES.has(type)) {
        throw new Error("Tipe monitor tidak valid");
    }
    const hasPort = text(settings.port) !== "";
    const port = hasPort ? parsePort(settings.port) : null;
    if ((hasPort || type === "port") && port === null) {
        throw new Error("Port bawaan tidak valid");
    }
    const interval = Number(settings.interval);
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL_SECOND) {
        throw new Error(`Interval tidak valid (minimal ${MIN_INTERVAL_SECOND} detik)`);
    }
    const parent = settings.parent ?? null;
    if (parent !== null && !Number.isInteger(parent)) {
        throw new Error("Grup induk tidak valid");
    }
    return { type, port, interval, parent, notificationIDList: settings.notificationIDList || {} };
}

/**
 * Check every row of the file and decide what an import would do with it. Nothing is written.
 * @param {object} params Parameters
 * @param {object[]} params.rows Items read from the file: `{ row, ip, name, category, subcategory, type, port }`
 * @param {object} params.options Settings for the whole import (type, port, interval, parent, notifications)
 * @param {object[]} params.devices The inventory, as `listDevices()` returns it
 * @returns {{rows: object[], counts: {new: number, update: number, error: number, monitorsToAdd: number}}} The plan
 * @throws {Error} When the settings are invalid or there are no rows or too many
 */
function planImport({ rows, options, devices }) {
    const settings = normalizeOptions(options);
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error("Tidak ada baris untuk diimpor");
    }
    if (rows.length > MAX_ROWS) {
        throw new Error(`Terlalu banyak baris (maksimal ${MAX_ROWS})`);
    }

    const byIp = new Map(devices.map((d) => [d.ip, d]));
    const firstRowOfIp = new Map();
    const counts = { new: 0, update: 0, error: 0, monitorsToAdd: 0 };

    const planned = rows.map((raw) => {
        const row = {
            row: raw.row,
            ip: text(raw.ip),
            name: text(raw.name),
            category: text(raw.category),
            subcategory: text(raw.subcategory),
            type: text(raw.type).toLowerCase(),
            port: null,
            status: "error",
            action: null,
        };
        const fail = (msg) => {
            counts.error++;
            return { ...row, status: "error", action: null, msg };
        };

        if (!net.isIPv4(row.ip)) {
            return fail("IP tidak valid");
        }
        if (firstRowOfIp.has(row.ip)) {
            return fail(`IP ganda pada baris ${firstRowOfIp.get(row.ip)}`);
        }
        firstRowOfIp.set(row.ip, row.row);

        if (row.name.length > MAX_LABEL_LENGTH) {
            return fail(`Nama terlalu panjang (maksimal ${MAX_LABEL_LENGTH} karakter)`);
        }
        if (row.category.length > MAX_CATEGORY_NAME_LENGTH || row.subcategory.length > MAX_CATEGORY_NAME_LENGTH) {
            return fail(`Nama kategori terlalu panjang (maksimal ${MAX_CATEGORY_NAME_LENGTH} karakter)`);
        }
        if (row.subcategory !== "" && row.category === "") {
            return fail("Sub kategori membutuhkan kategori");
        }

        if (row.type === "") {
            row.type = settings.type;
        } else if (row.type === "tcp") {
            row.type = "port";
        }
        if (!TYPES.has(row.type)) {
            return fail("Tipe monitor tidak valid");
        }
        if (row.type === "port") {
            const port = parsePort(text(raw.port) !== "" ? raw.port : settings.port);
            if (port === null) {
                return fail("Port tidak valid");
            }
            row.port = port;
        }

        const existing = byIp.get(row.ip);
        row.status = existing ? "update" : "new";
        row.action = existing && existing.monitorId !== null ? "has-monitor" : "add";
        counts[row.status]++;
        if (row.action === "add") {
            counts.monitorsToAdd++;
        }
        return row;
    });

    return { rows: planned, counts };
}

/**
 * Show what an import would do, without writing anything.
 * @param {object} params Parameters
 * @param {object[]} params.rows Items read from the file
 * @param {object} params.options Settings for the whole import
 * @returns {Promise<{rows: object[], counts: object}>} The plan, see `planImport`
 */
async function previewImport({ rows, options }) {
    return planImport({ rows, options, devices: await listDevices() });
}

/**
 * Import the valid rows: categories and devices in one transaction, then one monitor per device that has none.
 * @param {object} params Parameters
 * @param {object[]} params.rows Items read from the file
 * @param {object} params.options Settings for the whole import
 * @param {string} params.userID Owner of the new monitors
 * @param {object} params.deps Functions that live in server.js (`startMonitor`, `updateMonitorNotification`,
 *     `sendUpdateMonitorIntoList`), an optional `syncCategories(deviceIds)` run after the devices are saved and
 *     before monitors are added, plus an optional `monitoring` module to use instead of the real one
 * @param {Date} params.now Time stamp of the import (default: now)
 * @returns {Promise<object>} `{ created, updated, categoriesCreated, monitorsAdded, monitorsSkipped, rows }`
 * @throws {Error} When the settings are invalid or saving fails; nothing is saved then
 */
async function importDevices({ rows, options, userID, deps = {}, now = new Date() }) {
    const settings = normalizeOptions(options);
    const plan = planImport({ rows, options, devices: await listDevices() });
    const valid = plan.rows.filter((r) => r.status !== "error");
    const stamp = R.isoDateTimeMillis(dayjs.utc(now));
    const key = (name) => name.toLowerCase();

    const deviceIds = new Map();
    let categoriesCreated = 0;

    await R.knex.transaction(async (trx) => {
        const topIds = new Map();
        const subIds = new Map();
        for (const c of await trx("network_category").select("id", "name", "parent_id")) {
            if (c.parent_id === null) {
                topIds.set(key(c.name), c.id);
            } else {
                subIds.set(`${c.parent_id}|${key(c.name)}`, c.id);
            }
        }

        const categoryId = async (name) => {
            if (!topIds.has(key(name))) {
                const [id] = await trx("network_category").insert({ name, parent_id: null });
                topIds.set(key(name), id);
                categoriesCreated++;
            }
            return topIds.get(key(name));
        };
        const subcategoryId = async (parentId, name) => {
            const mapKey = `${parentId}|${key(name)}`;
            if (!subIds.has(mapKey)) {
                const [id] = await trx("network_category").insert({ name, parent_id: parentId });
                subIds.set(mapKey, id);
                categoriesCreated++;
            }
            return subIds.get(mapKey);
        };

        for (const r of valid) {
            const existing = await trx("network_device").where({ ip: r.ip }).first();
            const catId = r.category !== "" ? await categoryId(r.category) : null;

            if (existing) {
                const patch = {};
                if (r.name !== "") {
                    patch.label = r.name;
                }
                if (catId !== null) {
                    patch.category_id = catId;
                    if (r.subcategory !== "") {
                        patch.subcategory_id = await subcategoryId(catId, r.subcategory);
                    } else if (existing.category_id !== catId) {
                        patch.subcategory_id = null;
                    }
                }
                if (Object.keys(patch).length > 0) {
                    await trx("network_device").where({ id: existing.id }).update(patch);
                }
                deviceIds.set(r.ip, existing.id);
            } else {
                const subId = catId !== null && r.subcategory !== "" ? await subcategoryId(catId, r.subcategory) : null;
                const [id] = await trx("network_device").insert({
                    ip: r.ip,
                    label: r.name === "" ? null : r.name,
                    detected_via: "import",
                    first_seen: stamp,
                    last_seen: stamp,
                    is_online: 0,
                    category_id: catId,
                    subcategory_id: subId,
                });
                deviceIds.set(r.ip, id);
            }
        }
    });

    // New categories get their group monitors, and monitors of devices already in the inventory move into the
    // group of the category from the file, before new monitors are added (they go straight into those groups).
    if (deps.syncCategories) {
        await deps.syncCategories([...deviceIds.values()]);
    }

    const monitoring = deps.monitoring || require("./network-device-monitoring");
    const monitorDeps = {
        startMonitor: deps.startMonitor,
        updateMonitorNotification: deps.updateMonitorNotification,
        sendUpdateMonitorIntoList: deps.sendUpdateMonitorIntoList,
    };
    const result = {
        created: plan.counts.new,
        updated: plan.counts.update,
        categoriesCreated,
        monitorsAdded: 0,
        monitorsSkipped: 0,
        rows: [],
    };

    for (const r of plan.rows) {
        const out = { ...r, monitor: null };
        if (r.status === "error") {
            result.rows.push(out);
            continue;
        }
        if (r.action === "has-monitor") {
            out.monitor = "skipped";
            result.monitorsSkipped++;
            result.rows.push(out);
            continue;
        }

        try {
            const request = { id: deviceIds.get(r.ip), type: r.type, ...(r.type === "port" ? { port: r.port } : {}) };
            const added = await monitoring.addDevicesToMonitoring(
                {
                    userID,
                    devices: [request],
                    interval: settings.interval,
                    parent: settings.parent,
                    notificationIDList: settings.notificationIDList,
                },
                monitorDeps
            );
            if (added.failed.length > 0) {
                out.monitor = "failed";
                out.msg = added.failed[0].msg;
            } else if (added.added > 0) {
                out.monitor = "added";
                result.monitorsAdded++;
            } else {
                out.monitor = "skipped";
                result.monitorsSkipped++;
            }
        } catch (e) {
            out.monitor = "failed";
            out.msg = e.message;
        }
        result.rows.push(out);
    }

    return result;
}

module.exports = { MAX_ROWS, planImport, previewImport, importDevices };
