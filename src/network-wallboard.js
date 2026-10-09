const DOWN = 0;
const UP = 1;
const PENDING = 2;
const MAINTENANCE = 3;

/** The name of the group of devices that have no category. */
export const NO_CATEGORY_KEY = "none";

/**
 * @returns {{up: number, down: number, pending: number, maintenance: number, paused: number, unknown: number, total: number}} Empty counts
 */
function emptyCounts() {
    return { up: 0, down: 0, pending: 0, maintenance: 0, paused: 0, unknown: 0, total: 0 };
}

/**
 * Tell the state of a device from the last beat of its monitor.
 * @param {{status: number}|undefined|null} beat Last heartbeat
 * @param {boolean} active False when the monitor is paused
 * @returns {"up"|"down"|"pending"|"maintenance"|"paused"|"unknown"} State
 */
export function deviceState(beat, active) {
    if (!active) {
        return "paused";
    }
    if (!beat) {
        return "unknown";
    }
    if (beat.status === UP) {
        return "up";
    }
    if (beat.status === DOWN) {
        return "down";
    }
    if (beat.status === PENDING) {
        return "pending";
    }
    if (beat.status === MAINTENANCE) {
        return "maintenance";
    }
    return "unknown";
}

/**
 * Colour of a group of devices: the worst state in it counts, a paused or unseen device does not.
 * @param {{up: number, down: number, pending: number, maintenance: number, total: number}} counts Counts of the group
 * @returns {"down"|"pending"|"maintenance"|"up"|"none"} The state of the group
 */
export function groupState(counts) {
    if (counts.down > 0) {
        return "down";
    }
    if (counts.pending > 0) {
        return "pending";
    }
    if (counts.maintenance > 0) {
        return "maintenance";
    }
    return counts.up > 0 ? "up" : "none";
}

/**
 * Read a heartbeat time as milliseconds. Kuma sends UTC text such as "2026-10-09 10:00:00.000".
 * @param {string|number|Date|undefined} time Time of a beat
 * @returns {number|null} Milliseconds since the epoch, null when the time cannot be read
 */
export function beatTime(time) {
    if (time instanceof Date) {
        return time.getTime();
    }
    if (typeof time === "number") {
        return Number.isFinite(time) ? time : null;
    }
    if (typeof time !== "string" || time === "") {
        return null;
    }
    const text = time.includes("T") ? time : time.replace(" ", "T");
    const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * Since when a monitor has been down, from the beats the page holds.
 * @param {{status: number, time: string}[]|undefined} beats Beats, oldest first
 * @returns {{since: number|null, atLeast: boolean}} Time of the first beat of the run of down beats that ends the list;
 *     `atLeast` is true when the run covers every beat the page holds, so the real start may be earlier
 */
export function downSince(beats) {
    if (!Array.isArray(beats) || beats.length === 0) {
        return { since: null, atLeast: false };
    }
    let index = beats.length - 1;
    if (beats[index].status !== DOWN) {
        return { since: null, atLeast: false };
    }
    while (index > 0 && beats[index - 1].status === DOWN) {
        index--;
    }
    return { since: beatTime(beats[index].time), atLeast: index === 0 };
}

/**
 * Work out what the wallboard shows.
 * @param {object} params Parameters
 * @param {object[]} params.devices Inventory devices (`id, ip, label, categoryId, subcategoryId, monitorId`)
 * @param {{id: number, name: string, subcategories: {id: number, name: string}[]}[]} params.categories Categories
 * @param {(monitorId: number) => ({status: number, time: string}|undefined)} params.lastBeat Last heartbeat of a monitor
 * @param {(monitorId: number) => boolean} params.isActive Whether the monitor is running (not paused)
 * @param {(monitorId: number) => ({status: number, time: string}[]|undefined)} params.beatsOf Beats of a monitor, oldest first
 * @param {string[]} params.only Names of the categories to show (any case); empty for all. "none" is the group without category
 * @returns {{total: object, groups: object[], downList: object[], state: string}} Totals, one group per category and the devices that are down
 */
export function buildWallboard({ devices, categories, lastBeat, isActive, beatsOf, only = [] }) {
    const wanted = new Set(only.map((name) => name.trim().toLowerCase()).filter((name) => name !== ""));
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    const groups = new Map();
    const total = emptyCounts();
    const downList = [];

    const groupFor = (key, name) => {
        if (!groups.has(key)) {
            groups.set(key, { key, name, counts: emptyCounts(), subs: new Map() });
        }
        return groups.get(key);
    };
    const add = (counts, state) => {
        counts[state]++;
        counts.total++;
    };

    for (const device of devices) {
        if (device.monitorId === null || device.monitorId === undefined) {
            continue;
        }
        const category = device.categoryId !== null ? categoryById.get(device.categoryId) : undefined;
        const name = category ? category.name : "";
        if (wanted.size > 0 && !wanted.has(category ? name.toLowerCase() : NO_CATEGORY_KEY)) {
            continue;
        }
        const sub = category ? category.subcategories.find((s) => s.id === device.subcategoryId) : undefined;
        const state = deviceState(lastBeat(device.monitorId), isActive(device.monitorId));

        const group = category ? groupFor(`c${category.id}`, name) : groupFor(NO_CATEGORY_KEY, "");
        add(group.counts, state);
        add(total, state);
        const subKey = sub ? `s${sub.id}` : "";
        if (!group.subs.has(subKey)) {
            group.subs.set(subKey, { key: subKey, name: sub ? sub.name : "", counts: emptyCounts() });
        }
        add(group.subs.get(subKey).counts, state);

        if (state === "down") {
            const { since, atLeast } = downSince(beatsOf(device.monitorId));
            downList.push({
                id: device.id,
                monitorId: device.monitorId,
                name: device.label || device.ip,
                ip: device.ip,
                category: name,
                subcategory: sub ? sub.name : "",
                since,
                atLeast,
            });
        }
    }

    // Categories in the order of the list, the devices without a category last; a sub category only when it has a name
    const order = new Map(categories.map((c, i) => [`c${c.id}`, i]));
    const subOrder = (category) => new Map((category?.subcategories || []).map((s, i) => [`s${s.id}`, i]));
    const result = [...groups.values()]
        .sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity))
        .map((group) => {
            const category = categories.find((c) => `c${c.id}` === group.key);
            const positions = subOrder(category);
            const subs = [...group.subs.values()]
                .sort((a, b) => (positions.get(a.key) ?? Infinity) - (positions.get(b.key) ?? Infinity))
                .map((s) => ({ ...s, state: groupState(s.counts) }));
            return { key: group.key, name: group.name, counts: group.counts, state: groupState(group.counts), subs };
        });

    // The ones that have been down longest come first; those without a known start last
    downList.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity) || a.name.localeCompare(b.name));
    return { total, groups: result, downList, state: groupState(total) };
}

/** Units of formatSince in Indonesian. */
export const DEFAULT_UNITS = { second: "dtk", minute: "mnt", hour: "jam", day: "hari" };

/**
 * @param {number} ms Length of time in milliseconds
 * @param {{second: string, minute: string, hour: string, day: string}} units Words for the units
 * @returns {string} Short text such as "45 dtk", "12 mnt", "3 jam 05 mnt" or "2 hari 4 jam"; "" for a negative length
 */
export function formatSince(ms, units = DEFAULT_UNITS) {
    if (!Number.isFinite(ms) || ms < 0) {
        return "";
    }
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
        return `${seconds} ${units.second}`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes} ${units.minute}`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} ${units.hour} ${String(minutes % 60).padStart(2, "0")} ${units.minute}`;
    }
    return `${Math.floor(hours / 24)} ${units.day} ${hours % 24} ${units.hour}`;
}
