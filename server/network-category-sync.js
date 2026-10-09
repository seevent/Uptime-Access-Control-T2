/*
 * Keeps the network categories and the group monitors of the dashboard in step, both ways:
 *   category (location)  <->  group monitor at the top level
 *   sub category         <->  group monitor inside the group of its category
 * Each category row stores the id of its group in `group_monitor_id`.
 *
 * `syncCategories` does the whole job and is called after every change on either side:
 *   - after a change on the dashboard (group added, renamed, moved, deleted, a monitor dragged into a group)
 *     the group tree is the truth: categories follow it, and a monitored device takes the category of the
 *     group its monitor sits in;
 *   - after a change on the Network Scan page (category added, renamed, deleted, devices given a category,
 *     import) the category of the devices named in `place` is the truth: their monitors are moved into the
 *     matching group.
 * Rules:
 *   - a category whose group no longer exists (deleted on the dashboard, or turned into another monitor type)
 *     is deleted; its devices lose that category, and its sub categories are kept when their groups still exist;
 *   - a category with no group yet (`group_monitor_id` null: made by the import, or older data) gets a new group;
 *   - only two levels are categories: a group three levels deep is not a category (the nearest category above
 *     it counts for the monitors in it);
 *   - names are unique among siblings (case insensitive): a clash gets " (2)", " (3)", ... and the group is
 *     renamed the same way, so the dashboard and the Network Scan page always show the same names.
 * Monitors that do not belong to a device (HTTP, DNS, ...) may sit in a category group; they are never moved.
 */
const { R } = require("redbean-node");
const { log } = require("../src/util");
const store = require("./network-device-store");

const MAX_NAME_LENGTH = 100;

// One sync at a time: two syncs reading the same rows could create the same group twice.
let queue = Promise.resolve();

/**
 * Run a function after every sync that was started before it.
 * @param {Function} fn Async function
 * @returns {Promise<any>} Result of fn
 */
function serialize(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
}

/**
 * Monitors that are running in this process (their in-memory copy must follow parent and name changes).
 * @param {object} deps Dependencies
 * @returns {object} Map of monitor id to running monitor
 */
function runningMonitors(deps) {
    if (deps.runningMonitors) {
        return deps.runningMonitors;
    }
    try {
        // Only an existing server: getInstance() would create one
        const { UptimeKumaServer } = require("./uptime-kuma-server");
        return UptimeKumaServer.instance?.monitorList || {};
    } catch {
        return {};
    }
}

/**
 * Make a name free among its siblings by adding " (2)", " (3)", ...
 * @param {string} name Wanted name
 * @param {Set<string>} taken Lower case names already used by siblings
 * @returns {string} Name that is free
 */
function uniqueName(name, taken) {
    let base = String(name ?? "").trim();
    if (base === "") {
        base = "Grup";
    }
    base = base.slice(0, MAX_NAME_LENGTH);
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
        const suffix = ` (${n})`;
        candidate = base.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
    }
    return candidate;
}

/**
 * Create a group monitor.
 * @param {string} name Name
 * @param {number|null} parent Parent group, null for the top level
 * @param {string} userID Owner
 * @returns {Promise<number>} Id of the new monitor
 */
async function createGroupMonitor(name, parent, userID) {
    const bean = R.dispense("monitor");
    bean.import({
        type: "group",
        name,
        parent,
        interval: 60,
        retryInterval: 60,
        resendInterval: 0,
        maxretries: 0,
        accepted_statuscodes_json: JSON.stringify(["200-299"]),
        conditions: "[]",
        user_id: userID,
        active: 1,
    });
    bean.validate();
    await R.store(bean);
    return bean.id;
}

/**
 * Stop a monitor if it runs, then delete it.
 * @param {number} id Monitor id
 * @param {object} deps Dependencies
 * @returns {Promise<void>}
 */
async function deleteMonitorRow(id, deps) {
    const running = runningMonitors(deps);
    if (running[id]) {
        try {
            await running[id].stop();
        } catch (e) {
            log.error("network-scan", `Could not stop monitor ${id}: ${e.message}`);
        }
        delete running[id];
    }
    await R.exec("DELETE FROM monitor WHERE id = ?", [id]);
}

/**
 * Bring categories, group monitors and device monitors in line with each other (see the top of this file).
 * @param {object} options Options
 * @param {"all"|Set<number>|number[]|null} options.place Devices whose category wins over the position of their
 *     monitor: "all" for every device that has a category, a set of device ids (also moves the monitor of a device
 *     without category out of the category groups), or null (the dashboard wins for every device)
 * @param {string|null} options.userID Owner of new group monitors; without it no group is created
 * @param {object} options.deps `startMonitor(userID, id)` to start new groups (left out at boot, where every
 *     monitor is started afterwards), `runningMonitors` (tests)
 * @returns {Promise<{categoriesChanged: boolean, devicesChanged: boolean, monitorsCreated: number[], monitorsUpdated: number[], monitorsDeleted: number[]}>} What changed
 */
function syncCategories({ place = null, userID = null, deps = {} } = {}) {
    return serialize(() => runSync({ place, userID, deps }));
}

/**
 * Body of syncCategories (runs inside the queue).
 * @param {object} options See syncCategories
 * @param {"all"|Set<number>|number[]|null} options.place Devices whose category wins
 * @param {string|null} options.userID Owner of new group monitors
 * @param {object} options.deps Dependencies
 * @returns {Promise<object>} What changed
 */
async function runSync({ place, userID, deps }) {
    const placeSet = place === "all" || place === null ? place : new Set(place);
    const result = {
        categoriesChanged: false,
        devicesChanged: false,
        monitorsCreated: [],
        monitorsUpdated: new Set(),
        monitorsDeleted: [],
    };
    const running = runningMonitors(deps);

    const monitors = new Map(
        (await R.getAll("SELECT id, name, type, parent, user_id FROM monitor")).map((m) => [m.id, { ...m }])
    );
    const isGroup = (id) => id !== null && monitors.get(id)?.type === "group";

    /**
     * Level of a group: 1 at the top, 2 inside a top level group, and so on.
     * @param {number} id Group id
     * @returns {number} Level
     */
    const levelOf = (id) => {
        let level = 1;
        const seen = new Set([id]);
        let parent = monitors.get(id).parent;
        while (parent !== null && parent !== undefined && monitors.has(parent) && !seen.has(parent)) {
            seen.add(parent);
            level++;
            parent = monitors.get(parent).parent;
        }
        return level;
    };

    const rows = new Map(
        (await R.getAll("SELECT id, name, parent_id, group_monitor_id FROM network_category ORDER BY id")).map((c) => [
            c.id,
            { id: c.id, name: c.name, parent: c.parent_id, group: c.group_monitor_id },
        ])
    );

    // 1. Categories whose group is gone (or is no category any more) are deleted.
    const catOfGroup = new Map();
    const gone = [];
    for (const row of rows.values()) {
        if (row.group === null) {
            continue;
        }
        if (!isGroup(row.group) || levelOf(row.group) > 2 || catOfGroup.has(row.group)) {
            gone.push(row.id);
        } else {
            catOfGroup.set(row.group, row.id);
        }
    }
    for (const id of gone) {
        // Detach the sub categories first: they live on if their own group still exists (the parent foreign key
        // would delete them otherwise).
        await R.exec("UPDATE network_category SET parent_id = NULL WHERE parent_id = ?", [id]);
        for (const row of rows.values()) {
            if (row.parent === id) {
                row.parent = null;
            }
        }
        await R.exec("DELETE FROM network_category WHERE id = ?", [id]);
        rows.delete(id);
        result.categoriesChanged = true;
    }

    // 2. Every group on level 1 or 2 is a category: add the missing ones (parents first).
    const groups = [...monitors.values()]
        .filter((m) => m.type === "group")
        .map((m) => ({ id: m.id, level: levelOf(m.id) }))
        .filter((g) => g.level <= 2)
        .sort((a, b) => a.level - b.level || a.id - b.id);
    for (const g of groups) {
        if (!catOfGroup.has(g.id)) {
            const [id] = await R.knex("network_category").insert({
                name: String(monitors.get(g.id).name ?? "").slice(0, MAX_NAME_LENGTH) || "Grup",
                parent_id: null,
                group_monitor_id: g.id,
            });
            rows.set(id, { id, name: monitors.get(g.id).name, parent: null, group: g.id });
            catOfGroup.set(g.id, id);
            result.categoriesChanged = true;
        }
    }

    // 3. Place and name of every linked category follow its group.
    for (const row of rows.values()) {
        if (row.group !== null) {
            const groupParent = monitors.get(row.group).parent;
            row.wantedParent = groupParent === null ? null : (catOfGroup.get(groupParent) ?? null);
        } else {
            // No group yet: keep the place, unless the parent is gone.
            row.wantedParent = row.parent !== null && rows.has(row.parent) ? row.parent : null;
        }
    }
    // A category that has sub categories cannot become a sub category itself (only two levels).
    for (const row of rows.values()) {
        if (row.wantedParent !== null && rows.get(row.wantedParent)?.wantedParent !== null) {
            row.wantedParent = null;
        }
    }

    // Unique names per parent, in id order so the older one keeps the plain name.
    const taken = new Map();
    for (const row of [...rows.values()].sort((a, b) => a.id - b.id)) {
        const key = row.wantedParent ?? "top";
        if (!taken.has(key)) {
            taken.set(key, new Set());
        }
        const source = row.group !== null ? monitors.get(row.group).name : row.name;
        const name = uniqueName(source, taken.get(key));
        taken.get(key).add(name.toLowerCase());

        if (name !== row.name || row.wantedParent !== row.parent) {
            await R.exec("UPDATE network_category SET name = ?, parent_id = ? WHERE id = ?", [
                name,
                row.wantedParent,
                row.id,
            ]);
            row.name = name;
            row.parent = row.wantedParent;
            result.categoriesChanged = true;
        }
        if (row.group !== null && monitors.get(row.group).name !== name) {
            await R.exec("UPDATE monitor SET name = ? WHERE id = ?", [name, row.group]);
            monitors.get(row.group).name = name;
            if (running[row.group]) {
                running[row.group].name = name;
            }
            result.monitorsUpdated.add(row.group);
        }
    }

    // 4. Categories without a group get one (categories first, then sub categories inside them).
    if (userID) {
        const ordered = [...rows.values()].sort((a, b) => (a.parent === null ? 0 : 1) - (b.parent === null ? 0 : 1));
        for (const row of ordered) {
            if (row.group !== null) {
                continue;
            }
            const parentGroup = row.parent === null ? null : (rows.get(row.parent)?.group ?? null);
            if (row.parent !== null && parentGroup === null) {
                continue;
            }
            try {
                const id = await createGroupMonitor(row.name, parentGroup, userID);
                await R.exec("UPDATE network_category SET group_monitor_id = ? WHERE id = ?", [id, row.id]);
                row.group = id;
                monitors.set(id, { id, name: row.name, type: "group", parent: parentGroup, user_id: userID });
                catOfGroup.set(id, row.id);
                result.monitorsCreated.push(id);
                result.categoriesChanged = true;
            } catch (e) {
                log.error("network-scan", `Could not create the group for category ${row.id}: ${e.message}`);
            }
        }
    }

    // 5. Devices: category pair always valid; monitored devices follow (or lead) their monitor.
    /**
     * The category pair of a category row.
     * @param {number|null} id Row id
     * @returns {[number|null, number|null]} [category, sub category]
     */
    const pairOf = (id) => {
        if (id === null || !rows.has(id)) {
            return [null, null];
        }
        const row = rows.get(id);
        return row.parent === null ? [row.id, null] : [row.parent, row.id];
    };
    /**
     * Nearest category above a monitor.
     * @param {number} monitorId Monitor id
     * @returns {number|null} Category row id
     */
    const nearestCategory = (monitorId) => {
        const seen = new Set([monitorId]);
        let parent = monitors.get(monitorId)?.parent ?? null;
        while (parent !== null && !seen.has(parent)) {
            if (catOfGroup.has(parent)) {
                return catOfGroup.get(parent);
            }
            seen.add(parent);
            parent = monitors.get(parent)?.parent ?? null;
        }
        return null;
    };

    const devices = await R.getAll("SELECT id, monitor_id, category_id, subcategory_id FROM network_device");
    for (const device of devices) {
        // The most precise category that still exists decides (a sub category may have moved).
        const own =
            device.subcategory_id !== null && rows.has(device.subcategory_id)
                ? device.subcategory_id
                : device.category_id !== null && rows.has(device.category_id)
                  ? device.category_id
                  : null;
        let final = pairOf(own);

        const monitorId = device.monitor_id;
        if (monitorId !== null && monitors.has(monitorId) && monitors.get(monitorId).type !== "group") {
            const current = nearestCategory(monitorId);
            const placeIt = placeSet === "all" ? own !== null : placeSet !== null && placeSet.has(device.id);
            if (placeIt) {
                if (current !== own) {
                    const target = own === null ? null : rows.get(own).group;
                    if (own === null || target !== null) {
                        await R.exec("UPDATE monitor SET parent = ? WHERE id = ?", [target, monitorId]);
                        monitors.get(monitorId).parent = target;
                        if (running[monitorId]) {
                            running[monitorId].parent = target;
                        }
                        result.monitorsUpdated.add(monitorId);
                    }
                }
            } else {
                final = pairOf(current);
            }
        }

        if (final[0] !== device.category_id || final[1] !== device.subcategory_id) {
            await R.exec("UPDATE network_device SET category_id = ?, subcategory_id = ? WHERE id = ?", [
                final[0],
                final[1],
                device.id,
            ]);
            result.devicesChanged = true;
        }
    }

    // New groups start last, when they already have their children.
    if (deps.startMonitor && userID) {
        for (const id of result.monitorsCreated) {
            try {
                await deps.startMonitor(userID, id);
            } catch (e) {
                log.error("network-scan", `Could not start group monitor ${id}: ${e.message}`);
            }
        }
    }

    return { ...result, monitorsUpdated: [...result.monitorsUpdated] };
}

/**
 * Group monitor of a device's category (its sub category when it has one), if that group exists.
 * @param {{categoryId: number|null, subcategoryId: number|null}} device Device
 * @returns {Promise<number|null>} Group monitor id
 */
async function groupOfDevice(device) {
    const id = device.subcategoryId ?? device.categoryId ?? null;
    if (id === null) {
        return null;
    }
    const row = await R.getRow(
        `SELECT m.id FROM network_category c JOIN monitor m ON m.id = c.group_monitor_id AND m.type = 'group'
         WHERE c.id = ?`,
        [id]
    );
    return row ? row.id : null;
}

/**
 * Rename a category and its group.
 * @param {number} id Category id
 * @param {string} name New name
 * @param {object} deps Dependencies
 * @returns {Promise<{monitorsUpdated: number[]}|false>} The renamed group, or false when the category does not exist
 */
function renameCategory(id, name, deps = {}) {
    return serialize(async () => {
        if (!(await store.renameCategory(id, name))) {
            return false;
        }
        const row = await R.getRow("SELECT name, group_monitor_id FROM network_category WHERE id = ?", [id]);
        const monitorsUpdated = [];
        if (row.group_monitor_id !== null) {
            await R.exec("UPDATE monitor SET name = ? WHERE id = ? AND type = 'group'", [
                row.name,
                row.group_monitor_id,
            ]);
            const running = runningMonitors(deps);
            if (running[row.group_monitor_id]) {
                running[row.group_monitor_id].name = row.name;
            }
            monitorsUpdated.push(row.group_monitor_id);
        }
        return { monitorsUpdated };
    });
}

/**
 * Delete a category with its sub categories, or one sub category, together with their groups.
 * Monitors in a deleted sub category go up into the group of the category; monitors in a deleted category
 * go to the top level. The monitors themselves (and their history) stay.
 * @param {number} id Category or sub category id
 * @param {object} deps Dependencies (`runningMonitors` for tests)
 * @returns {Promise<{deleted: boolean, monitorsUpdated: number[], monitorsDeleted: number[]}>} What changed
 */
function deleteCategory(id, deps = {}) {
    return serialize(async () => {
        const out = { deleted: false, monitorsUpdated: [], monitorsDeleted: [] };
        const row = await R.getRow("SELECT id, parent_id, group_monitor_id FROM network_category WHERE id = ?", [id]);
        if (!row) {
            return out;
        }
        const groupExists = async (groupId) =>
            groupId !== null &&
            Boolean(await R.getRow("SELECT id FROM monitor WHERE id = ? AND type = 'group'", [groupId]));

        const doomed = [];
        let newParent = null;
        if (row.parent_id === null) {
            const subs = await R.getAll("SELECT group_monitor_id FROM network_category WHERE parent_id = ?", [id]);
            for (const sub of subs) {
                if (await groupExists(sub.group_monitor_id)) {
                    doomed.push(sub.group_monitor_id);
                }
            }
        } else {
            const parent = await R.getRow("SELECT group_monitor_id FROM network_category WHERE id = ?", [
                row.parent_id,
            ]);
            if (parent && (await groupExists(parent.group_monitor_id))) {
                newParent = parent.group_monitor_id;
            }
        }
        if (await groupExists(row.group_monitor_id)) {
            doomed.push(row.group_monitor_id);
        }

        const running = runningMonitors(deps);
        for (const groupId of doomed) {
            const children = await R.getAll("SELECT id FROM monitor WHERE parent = ?", [groupId]);
            for (const child of children) {
                if (doomed.includes(child.id)) {
                    continue;
                }
                await R.exec("UPDATE monitor SET parent = ? WHERE id = ?", [newParent, child.id]);
                if (running[child.id]) {
                    running[child.id].parent = newParent;
                }
                out.monitorsUpdated.push(child.id);
            }
        }
        // Sub groups before the category group.
        for (const groupId of doomed) {
            await deleteMonitorRow(groupId, deps);
            out.monitorsDeleted.push(groupId);
        }
        out.deleted = await store.deleteCategory(id);
        return out;
    });
}

/**
 * Sync once at start up. The first time (after the update that links categories to groups) the categories
 * of the devices win, so every existing category gets its group and the monitors move into it; later the
 * dashboard wins, as after any dashboard change.
 * @returns {Promise<void>}
 */
async function syncAtBoot() {
    const { Settings } = require("./settings");
    const firstTime = !(await Settings.get("networkCategoryGroupsLinked"));
    const owner =
        (await R.getRow(
            "SELECT m.user_id FROM monitor m JOIN network_device d ON d.monitor_id = m.id ORDER BY m.id LIMIT 1"
        )) ?? null;
    let userID = owner ? owner.user_id : null;
    if (!userID) {
        const user = await R.getRow("SELECT id FROM better_auth_user ORDER BY createdAt LIMIT 1");
        userID = user ? user.id : null;
    }
    const result = await syncCategories({ place: firstTime ? "all" : null, userID });
    if (firstTime && userID) {
        await Settings.set("networkCategoryGroupsLinked", true, "general");
    }
    log.info(
        "network-scan",
        `Category groups synced: ${result.monitorsCreated.length} groups created, ${result.monitorsUpdated.length} monitors moved or renamed`
    );
}

module.exports = {
    syncCategories,
    syncAtBoot,
    renameCategory,
    deleteCategory,
    groupOfDevice,
    uniqueName,
};
