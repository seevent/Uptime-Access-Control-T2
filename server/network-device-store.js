const { R } = require("redbean-node");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));

const MAX_LABEL_LENGTH = 255;
const MAX_CATEGORY_NAME_LENGTH = 100;
const MAX_BULK_DEVICES = 2000;
const BULK_CHUNK = 500;
const MAX_FILTER_IDS = 5000;

/**
 * Convert a database row into the object sent to the frontend.
 * @param {object} row Row of the network_device table
 * @returns {object} Device
 */
function toDevice(row) {
    return {
        id: row.id,
        ip: row.ip,
        mac: row.mac ?? null,
        hostname: row.hostname ?? null,
        vendor: row.vendor ?? null,
        label: row.label ?? null,
        detectedVia: row.detected_via,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        isOnline: Boolean(row.is_online),
        monitorId: row.monitor_id ?? null,
        categoryId: row.category_id ?? null,
        subcategoryId: row.subcategory_id ?? null,
    };
}

/**
 * Numeric comparison of two IPv4 addresses (falls back to string comparison).
 * @param {string} a First address
 * @param {string} b Second address
 * @returns {number} Sort order
 */
function compareIp(a, b) {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    if (pa.length === 4 && pb.length === 4) {
        for (let i = 0; i < 4; i++) {
            if (pa[i] !== pb[i]) {
                return pa[i] - pb[i];
            }
        }
        return 0;
    }
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * List all stored devices sorted by IP address.
 * @returns {Promise<object[]>} Devices
 */
async function listDevices() {
    const rows = await R.getAll("SELECT * FROM network_device");
    return rows.map(toDevice).sort((a, b) => compareIp(a.ip, b.ip));
}

/**
 * Get the devices with the given ids.
 * @param {number[]} ids Device ids
 * @returns {Promise<object[]>} Devices (unknown ids are left out)
 */
async function getDevicesByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
        return [];
    }
    const rows = await R.getAll(`SELECT * FROM network_device WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    return rows.map(toDevice);
}

/**
 * Merge the result of a scan into the stored inventory.
 * @param {object} params Parameters
 * @param {object[]} params.devices Devices found by the scan
 * @param {string[]} params.scannedIPs Every address the scan covered
 * @param {boolean} params.complete True when the scan ran to the end (only then devices can be marked missing)
 * @param {Date} params.now Time of the scan
 * @returns {Promise<{found: number, new: number, missing: number}>} Summary
 */
async function mergeScan({ devices, scannedIPs, complete, now = new Date() }) {
    const stamp = R.isoDateTimeMillis(dayjs.utc(now));
    const summary = { found: devices.length, new: 0, missing: 0 };
    const foundIPs = new Set(devices.map((d) => d.ip));

    const trx = await R.begin();
    try {
        for (const device of devices) {
            const existing = await trx.getRow("SELECT id FROM network_device WHERE ip = ?", [device.ip]);
            if (existing) {
                await trx.exec(
                    `UPDATE network_device
                     SET mac = COALESCE(?, mac), hostname = COALESCE(?, hostname), vendor = COALESCE(?, vendor),
                         detected_via = ?, last_seen = ?, is_online = 1
                     WHERE id = ?`,
                    [
                        device.mac ?? null,
                        device.hostname ?? null,
                        device.vendor ?? null,
                        device.detectedVia,
                        stamp,
                        existing.id,
                    ]
                );
            } else {
                await trx.exec(
                    `INSERT INTO network_device
                        (ip, mac, hostname, vendor, detected_via, first_seen, last_seen, is_online)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
                    [
                        device.ip,
                        device.mac ?? null,
                        device.hostname ?? null,
                        device.vendor ?? null,
                        device.detectedVia,
                        stamp,
                        stamp,
                    ]
                );
                summary.new++;
            }
        }

        if (complete) {
            const online = await trx.getAll("SELECT id, ip FROM network_device WHERE is_online = 1");
            const scanned = new Set(scannedIPs);
            for (const row of online) {
                if (scanned.has(row.ip) && !foundIPs.has(row.ip)) {
                    await trx.exec("UPDATE network_device SET is_online = 0 WHERE id = ?", [row.id]);
                    summary.missing++;
                }
            }
        }

        await trx.commit();
    } catch (error) {
        await trx.rollback();
        throw error;
    }
    return summary;
}

/**
 * Set or clear the label of a device.
 * @param {number} id Device id
 * @param {string} label New label (empty clears it)
 * @returns {Promise<boolean>} False when the device does not exist
 */
async function updateLabel(id, label) {
    const value = String(label ?? "").trim();
    if (value.length > MAX_LABEL_LENGTH) {
        throw new Error("Label terlalu panjang");
    }
    const existing = await R.getRow("SELECT id FROM network_device WHERE id = ?", [id]);
    if (!existing) {
        return false;
    }
    await R.exec("UPDATE network_device SET label = ? WHERE id = ?", [value === "" ? null : value, id]);
    return true;
}

/**
 * Delete a device from the inventory (its monitor, if any, is left alone).
 * @param {number} id Device id
 * @returns {Promise<boolean>} True when a device was deleted
 */
async function deleteDevice(id) {
    const existing = await R.getRow("SELECT id FROM network_device WHERE id = ?", [id]);
    if (!existing) {
        return false;
    }
    await R.exec("DELETE FROM network_device WHERE id = ?", [id]);
    return true;
}

/**
 * Validate and clean a category name.
 * @param {string} name Raw name
 * @returns {string} Trimmed name
 * @throws {Error} When the name is empty or too long
 */
function cleanCategoryName(name) {
    const value = String(name ?? "").trim();
    if (value === "") {
        throw new Error("Nama tidak boleh kosong");
    }
    if (value.length > MAX_CATEGORY_NAME_LENGTH) {
        throw new Error("Nama terlalu panjang");
    }
    return value;
}

/**
 * Make sure no sibling already uses the name (case insensitive).
 * @param {string} name Cleaned name
 * @param {number|null} parentId Parent category id, null for top level categories
 * @param {number|null} exceptId Row that is being renamed, if any
 * @returns {Promise<void>}
 * @throws {Error} When the name is taken
 */
async function assertNameFree(name, parentId, exceptId = null) {
    const siblings =
        parentId === null
            ? await R.getAll("SELECT id, name FROM network_category WHERE parent_id IS NULL")
            : await R.getAll("SELECT id, name FROM network_category WHERE parent_id = ?", [parentId]);
    const wanted = name.toLowerCase();
    if (siblings.some((row) => row.id !== exceptId && row.name.toLowerCase() === wanted)) {
        throw new Error("Nama sudah dipakai");
    }
}

/**
 * List the categories with their sub categories, sorted by name.
 * @returns {Promise<{id: number, name: string, subcategories: {id: number, name: string}[]}[]>} Categories
 */
async function listCategories() {
    const rows = await R.getAll("SELECT id, name, parent_id FROM network_category");
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    return rows
        .filter((row) => row.parent_id === null)
        .sort(byName)
        .map((category) => ({
            id: category.id,
            name: category.name,
            subcategories: rows
                .filter((row) => row.parent_id === category.id)
                .sort(byName)
                .map((sub) => ({ id: sub.id, name: sub.name })),
        }));
}

/**
 * Add a category (a location).
 * @param {string} name Name
 * @returns {Promise<{id: number, name: string}>} The new category
 */
async function addCategory(name) {
    const value = cleanCategoryName(name);
    await assertNameFree(value, null);
    const [id] = await R.knex("network_category").insert({ name: value, parent_id: null });
    return { id, name: value };
}

/**
 * Add a sub category to a category.
 * @param {number} categoryId Id of the category
 * @param {string} name Name
 * @returns {Promise<{id: number, name: string}>} The new sub category
 */
async function addSubcategory(categoryId, name) {
    const value = cleanCategoryName(name);
    const parent = Number.isInteger(categoryId)
        ? await R.getRow("SELECT id FROM network_category WHERE id = ? AND parent_id IS NULL", [categoryId])
        : null;
    if (!parent) {
        throw new Error("Kategori tidak ditemukan");
    }
    await assertNameFree(value, categoryId);
    const [id] = await R.knex("network_category").insert({ name: value, parent_id: categoryId });
    return { id, name: value };
}

/**
 * Rename a category or sub category.
 * @param {number} id Id of the category or sub category
 * @param {string} name New name
 * @returns {Promise<boolean>} False when it does not exist
 */
async function renameCategory(id, name) {
    const value = cleanCategoryName(name);
    const row = await R.getRow("SELECT id, parent_id FROM network_category WHERE id = ?", [id]);
    if (!row) {
        return false;
    }
    await assertNameFree(value, row.parent_id, row.id);
    await R.exec("UPDATE network_category SET name = ? WHERE id = ?", [value, id]);
    return true;
}

/**
 * Delete a category (with its sub categories) or a sub category. Devices in it become uncategorized
 * (or lose only their sub category).
 * @param {number} id Id of the category or sub category
 * @returns {Promise<boolean>} False when it does not exist
 */
async function deleteCategory(id) {
    const trx = await R.begin();
    try {
        const row = await trx.getRow("SELECT id, parent_id FROM network_category WHERE id = ?", [id]);
        if (!row) {
            await trx.rollback();
            return false;
        }
        if (row.parent_id === null) {
            await trx.exec(
                "UPDATE network_device SET category_id = NULL, subcategory_id = NULL WHERE category_id = ?",
                [id]
            );
            await trx.exec(
                "UPDATE network_device SET subcategory_id = NULL WHERE subcategory_id IN (SELECT id FROM network_category WHERE parent_id = ?)",
                [id]
            );
            await trx.exec("DELETE FROM network_category WHERE parent_id = ?", [id]);
        } else {
            await trx.exec("UPDATE network_device SET subcategory_id = NULL WHERE subcategory_id = ?", [id]);
        }
        await trx.exec("DELETE FROM network_category WHERE id = ?", [id]);
        await trx.commit();
        return true;
    } catch (error) {
        await trx.rollback();
        throw error;
    }
}

/**
 * Check that a category and sub category can be given to devices.
 * @param {number|null|undefined} categoryId Category id
 * @param {number|null|undefined} subcategoryId Sub category id, which must belong to the category
 * @param {object} db Where to read, `R` or an open transaction (default `R`)
 * @returns {Promise<{category: number|null, sub: number|null}>} The values to store (null when empty)
 * @throws {Error} When the category does not exist or the sub category does not belong to it
 */
async function checkCategoryPair(categoryId, subcategoryId, db = R) {
    const category = categoryId ?? null;
    const sub = subcategoryId ?? null;
    if (category === null) {
        if (sub !== null) {
            throw new Error("Sub kategori tidak sesuai");
        }
    } else {
        const row = Number.isInteger(category)
            ? await db.getRow("SELECT id FROM network_category WHERE id = ? AND parent_id IS NULL", [category])
            : null;
        if (!row) {
            throw new Error("Kategori tidak ditemukan");
        }
        if (sub !== null) {
            const subRow = Number.isInteger(sub)
                ? await db.getRow("SELECT id FROM network_category WHERE id = ? AND parent_id = ?", [sub, category])
                : null;
            if (!subRow) {
                throw new Error("Sub kategori tidak sesuai");
            }
        }
    }
    return { category, sub };
}

/**
 * Put a device in a category and sub category (null clears them).
 * @param {number} id Device id
 * @param {number|null} categoryId Category id
 * @param {number|null} subcategoryId Sub category id, which must belong to the category
 * @returns {Promise<boolean>} False when the device does not exist
 */
async function setDeviceCategory(id, categoryId, subcategoryId) {
    const device = await R.getRow("SELECT id FROM network_device WHERE id = ?", [id]);
    if (!device) {
        return false;
    }
    const { category, sub } = await checkCategoryPair(categoryId, subcategoryId);
    await R.exec("UPDATE network_device SET category_id = ?, subcategory_id = ? WHERE id = ?", [category, sub, id]);
    return true;
}

/**
 * Put many devices in a category and sub category at once (null clears them). Ids that do not exist are skipped.
 * @param {number[]} ids 1 to 2000 different device ids
 * @param {number|null} categoryId Category id
 * @param {number|null} subcategoryId Sub category id, which must belong to the category
 * @returns {Promise<number>} How many devices exist and were changed
 * @throws {Error} When the ids are not valid, or the category pair is not valid (nothing is changed then)
 */
async function setDevicesCategory(ids, categoryId, subcategoryId) {
    if (
        !Array.isArray(ids) ||
        ids.length < 1 ||
        ids.length > MAX_BULK_DEVICES ||
        !ids.every((id) => Number.isInteger(id)) ||
        new Set(ids).size !== ids.length
    ) {
        throw new Error(`Pilih 1 sampai ${MAX_BULK_DEVICES} perangkat`);
    }
    const trx = await R.begin();
    try {
        // Checked inside the transaction so a category deleted at the same time cannot slip through
        const { category, sub } = await checkCategoryPair(categoryId, subcategoryId, trx);
        let updated = 0;
        for (let i = 0; i < ids.length; i += BULK_CHUNK) {
            const chunk = ids.slice(i, i + BULK_CHUNK);
            const marks = chunk.map(() => "?").join(",");
            const found = await trx.getRow(`SELECT COUNT(*) AS n FROM network_device WHERE id IN (${marks})`, chunk);
            updated += Number(found.n);
            await trx.exec(`UPDATE network_device SET category_id = ?, subcategory_id = ? WHERE id IN (${marks})`, [
                category,
                sub,
                ...chunk,
            ]);
        }
        await trx.commit();
        return updated;
    } catch (error) {
        await trx.rollback();
        throw error;
    }
}

/**
 * Read a list of device ids that limits a query to some devices.
 * @param {unknown} value `undefined` for no limit, or an array of up to 5000 different whole numbers
 * @returns {Set<number>|null} The ids, or null for no limit (an empty set means no devices)
 * @throws {Error} When the value is not valid
 */
function parseDeviceIds(value) {
    if (value === undefined) {
        return null;
    }
    if (
        !Array.isArray(value) ||
        value.length > MAX_FILTER_IDS ||
        !value.every((id) => Number.isInteger(id)) ||
        new Set(value).size !== value.length
    ) {
        throw new Error("Daftar perangkat tidak valid");
    }
    return new Set(value);
}

/**
 * Link a device to the monitor created for it.
 * @param {number} id Device id
 * @param {number} monitorId Monitor id
 * @returns {Promise<void>}
 */
async function setMonitorId(id, monitorId) {
    await R.exec("UPDATE network_device SET monitor_id = ? WHERE id = ?", [monitorId, id]);
}

module.exports = {
    listDevices,
    getDevicesByIds,
    mergeScan,
    updateLabel,
    deleteDevice,
    setMonitorId,
    listCategories,
    addCategory,
    addSubcategory,
    renameCategory,
    deleteCategory,
    setDeviceCategory,
    checkCategoryPair,
    setDevicesCategory,
    parseDeviceIds,
};
