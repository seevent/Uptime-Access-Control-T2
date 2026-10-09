const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");

const NO_SCAN_RUNNING = "Tidak ada scan yang berjalan";

// Only one scan can run at a time on the whole server, so its state lives in the module.
const state = {
    running: false,
    scanId: 0,
    done: 0,
    total: 0,
    found: 0,
    abortController: null,
};
let lastScanId = 0;

/**
 * Forget the running scan. Always called from a finally block so a failed or cancelled scan can never block the next one.
 * @returns {void}
 */
function resetState() {
    state.running = false;
    state.done = 0;
    state.total = 0;
    state.found = 0;
    state.abortController = null;
}

/**
 * Tell the user's clients about monitors that the category sync created, changed or deleted.
 * @param {object} server Uptime Kuma server
 * @param {import("socket.io").Socket} socket Socket of the user
 * @param {{monitorsCreated?: number[], monitorsUpdated?: number[], monitorsDeleted?: number[]}} changes What changed
 * @returns {Promise<void>}
 */
async function notifyMonitorChanges(server, socket, changes) {
    const deleted = changes.monitorsDeleted || [];
    const changed = [...new Set([...(changes.monitorsCreated || []), ...(changes.monitorsUpdated || [])])].filter(
        (id) => !deleted.includes(id)
    );
    for (const id of deleted) {
        if (typeof server.sendDeleteMonitorFromList === "function") {
            await server.sendDeleteMonitorFromList(socket, id);
        }
    }
    if (changed.length > 20 && typeof server.sendMonitorList === "function") {
        await server.sendMonitorList(socket);
    } else if (typeof server.sendUpdateMonitorIntoList === "function") {
        for (const id of changed) {
            await server.sendUpdateMonitorIntoList(socket, id);
        }
    }
}

/**
 * After a monitor was added, edited or deleted on the dashboard: let the categories follow the group monitors and
 * refresh the lists of the user's clients. Never throws, so it cannot spoil the monitor change itself.
 * @param {import("socket.io").Socket} socket Socket of the user
 * @param {object} server Uptime Kuma server
 * @param {Function} startMonitor Starts a monitor (from server.js)
 * @returns {Promise<void>}
 */
module.exports.syncCategoriesAfterDashboardChange = async (socket, server, startMonitor) => {
    try {
        const result = await require("../network-category-sync").syncCategories({
            place: null,
            userID: socket.userID,
            deps: { startMonitor },
        });
        await notifyMonitorChanges(server, socket, result);
        const store = require("../network-device-store");
        if (result.categoriesChanged) {
            server.io.to(socket.userID).emit("networkCategoryList", await store.listCategories());
        }
        if (result.categoriesChanged || result.devicesChanged) {
            server.io.to(socket.userID).emit("networkDeviceList", await store.listDevices());
        }
    } catch (e) {
        log.error("network-scan", `Could not sync categories with the groups: ${e.message}`);
    }
};

/**
 * Register the Network Scan socket events.
 * @param {import("socket.io").Socket} socket Socket.io instance
 * @param {object} server Uptime Kuma server (needs `io`)
 * @param {object} deps Dependencies
 * @param {Function} deps.startMonitor Starts a monitor (from server.js)
 * @param {Function} deps.updateMonitorNotification Saves the notifications of a monitor (from server.js)
 * @param {object} deps.scanner Replacement for server/network-scanner (tests)
 * @param {object} deps.store Replacement for server/network-device-store (tests)
 * @param {object} deps.monitoring Replacement for server/network-device-monitoring (tests)
 * @param {object} deps.uptime Replacement for server/network-device-uptime (tests)
 * @param {object} deps.history Replacement for server/network-device-history (tests)
 * @param {object} deps.ping Replacement for server/network-device-ping (tests)
 * @returns {void}
 */
module.exports.networkScanSocketHandler = (socket, server, deps = {}) => {
    const getScanner = () => deps.scanner || require("../network-scanner");
    const getStore = () => deps.store || require("../network-device-store");
    const getMonitoring = () => deps.monitoring || require("../network-device-monitoring");
    const getUptime = () => deps.uptime || require("../network-device-uptime");
    const getImporter = () => deps.importer || require("../network-device-import");
    const getHistory = () => deps.history || require("../network-device-history");
    const getPing = () => deps.ping || require("../network-device-ping");
    const getSync = () => deps.categorySync || require("../network-category-sync");

    /**
     * Sync categories and group monitors, then tell the clients about changed monitors.
     * @param {"all"|number[]|null} place Devices whose category wins (see syncCategories)
     * @returns {Promise<object>} Result of the sync
     */
    const runSync = async (place) => {
        const result = await getSync().syncCategories({
            place,
            userID: socket.userID,
            deps: { startMonitor: deps.startMonitor },
        });
        await notifyMonitorChanges(server, socket, result);
        return result;
    };

    /**
     * The devices, out of the given ids, that have a category (their monitors go into the category group;
     * the others keep the group they were put in).
     * @param {number[]} ids Device ids
     * @returns {Promise<number[]>} Ids of devices with a category
     */
    const withCategory = async (ids) =>
        (await getStore().getDevicesByIds(ids.filter((id) => Number.isInteger(id))))
            .filter((d) => d.categoryId !== null)
            .map((d) => d.id);

    /**
     * Send the current inventory to every client of this user.
     * @returns {Promise<void>}
     */
    const emitDeviceList = async () => {
        server.io.to(socket.userID).emit("networkDeviceList", await getStore().listDevices());
    };

    /**
     * Wrap an event handler: login check, error to callback.
     * @param {string} event Event name
     * @param {boolean} hasPayload False for events the client sends with only a callback
     * @param {Function} fn Handler `(payload) => Promise<object>` returning the reply fields
     * @returns {void}
     */
    const register = (event, hasPayload, fn) => {
        socket.on(event, async (...args) => {
            const callback = args[args.length - 1];
            try {
                checkLogin(socket);
                const payload = hasPayload ? args[0] : undefined;
                callback({ ok: true, ...(await fn(payload)) });
            } catch (e) {
                callback({ ok: false, msg: e.message });
            }
        });
    };

    /**
     * Parameters of a summary query: the range, and the device ids only when the client sent them.
     * @param {{from: string, to: string, deviceIds?: number[]}} payload Payload of the event
     * @returns {{from: string, to: string, deviceIds?: number[]}} Parameters for the module
     */
    const rangeParams = (payload) => {
        const params = { from: payload.from, to: payload.to };
        if (payload.deviceIds !== undefined) {
            params.deviceIds = payload.deviceIds;
        }
        return params;
    };

    /**
     * Run the scan in the background and report the outcome to the user's clients.
     * @param {number} scanId Id of this scan
     * @param {string[]} ips Addresses to scan
     * @param {AbortController} abortController Used to cancel
     * @returns {Promise<void>}
     */
    const runScan = async (scanId, ips, abortController) => {
        const scanner = getScanner();
        const store = getStore();
        const done = { scanId, cancelled: false };

        try {
            const result = await scanner.scan({
                ips,
                signal: abortController.signal,
                onProgress: (progress) => {
                    state.done = progress.done;
                    state.total = progress.total;
                    state.found = progress.found;
                    server.io.to(socket.userID).emit("networkScanProgress", { scanId, ...progress });
                },
            });
            const cancelled = !result.completed;
            const merged = await store.mergeScan({
                devices: result.devices,
                scannedIPs: ips,
                complete: result.completed,
            });
            done.cancelled = cancelled;
            done.summary = { ...merged, arpAvailable: cancelled ? true : result.arpAvailable };
        } catch (e) {
            done.error = e.message;
        } finally {
            resetState();
        }

        // Emitted after the reset, so a client reacting to "done" can start the next scan right away.
        server.io.to(socket.userID).emit("networkScanDone", done);
        try {
            await emitDeviceList();
        } catch (e) {
            log.error("network-scan", `Could not send the device list: ${e.message}`);
        }
    };

    register("getLocalSubnets", false, async () => ({ subnets: getScanner().getLocalSubnets() }));

    register("getNetworkDevices", false, async () => ({ devices: await getStore().listDevices() }));

    register("getNetworkScanStatus", false, async () => ({
        running: state.running,
        scanId: state.scanId,
        done: state.done,
        total: state.total,
        found: state.found,
    }));

    register("startNetworkScan", true, async (payload) => {
        if (state.running) {
            throw new Error("Scan sedang berjalan");
        }
        if (!payload || !Array.isArray(payload.ranges)) {
            throw new Error("Masukkan minimal satu rentang IP");
        }
        const ips = getScanner().expandRanges(payload.ranges);
        if (ips.length === 0) {
            throw new Error("Tidak ada alamat yang bisa di-scan");
        }

        // No await between the check above and this block, so two requests cannot both start.
        const abortController = new AbortController();
        const scanId = ++lastScanId;
        state.running = true;
        state.scanId = scanId;
        state.done = 0;
        state.total = ips.length;
        state.found = 0;
        state.abortController = abortController;

        runScan(scanId, ips, abortController).catch((e) => {
            log.error("network-scan", `Network scan failed unexpectedly: ${e.message}`);
            resetState();
        });
        return { scanId };
    });

    register("cancelNetworkScan", true, async (payload) => {
        if (!state.running || !payload || payload.scanId !== state.scanId) {
            throw new Error(NO_SCAN_RUNNING);
        }
        state.abortController.abort();
        return {};
    });

    register("updateNetworkDevice", true, async (payload) => {
        if (!payload) {
            throw new Error("Perangkat tidak ditemukan");
        }
        if (!(await getStore().updateLabel(payload.id, payload.label))) {
            throw new Error("Perangkat tidak ditemukan");
        }
        await emitDeviceList();
        return {};
    });

    /**
     * Send the categories to every client of this user.
     * @returns {Promise<void>}
     */
    const emitCategoryList = async () => {
        server.io.to(socket.userID).emit("networkCategoryList", await getStore().listCategories());
    };

    register("getNetworkCategories", false, async () => ({ categories: await getStore().listCategories() }));

    register("addNetworkCategory", true, async (payload) => {
        if (!payload) {
            throw new Error("Nama tidak boleh kosong");
        }
        const store = getStore();
        const created =
            payload.parentId === undefined || payload.parentId === null
                ? await store.addCategory(payload.name)
                : await store.addSubcategory(payload.parentId, payload.name);
        // Creates the group monitor of the new category
        await runSync(null);
        await emitCategoryList();
        return { id: created.id };
    });

    register("renameNetworkCategory", true, async (payload) => {
        const renamed = payload ? await getSync().renameCategory(payload.id, payload.name) : false;
        if (!renamed) {
            throw new Error("Kategori tidak ditemukan");
        }
        await notifyMonitorChanges(server, socket, renamed);
        await emitCategoryList();
        return {};
    });

    register("deleteNetworkCategory", true, async (payload) => {
        const removed = payload ? await getSync().deleteCategory(payload.id) : { deleted: false };
        if (!removed.deleted) {
            throw new Error("Kategori tidak ditemukan");
        }
        await notifyMonitorChanges(server, socket, removed);
        await runSync(null);
        // Devices that were in it are uncategorized now (or only lost their sub category).
        await emitCategoryList();
        await emitDeviceList();
        return {};
    });

    register("setNetworkDeviceCategory", true, async (payload) => {
        if (!payload || !(await getStore().setDeviceCategory(payload.id, payload.categoryId, payload.subcategoryId))) {
            throw new Error("Perangkat tidak ditemukan");
        }
        // Its monitor moves into the group of the new category (or out of the category groups)
        await runSync([payload.id]);
        await emitDeviceList();
        return {};
    });

    register("setNetworkDevicesCategory", true, async (payload) => {
        // The store refuses a missing list of ids with the message that names the limit
        const { ids, categoryId, subcategoryId } = payload || {};
        const updated = await getStore().setDevicesCategory(ids, categoryId, subcategoryId);
        await runSync(ids);
        await emitDeviceList();
        return { updated };
    });

    register("getNetworkDeviceUptime", true, async (payload) => {
        if (!payload) {
            throw new Error("Rentang waktu tidak valid");
        }
        const uptime = await getUptime().getDeviceUptime({ deviceId: payload.id, from: payload.from, to: payload.to });
        return { uptime };
    });

    register("getNetworkUptimeSummary", true, async (payload) => {
        if (!payload) {
            throw new Error("Rentang waktu tidak valid");
        }
        const { items } = await getUptime().getUptimeSummary(rangeParams(payload));
        return { items };
    });

    register("getNetworkDeviceHistory", true, async (payload) => {
        if (!payload) {
            throw new Error("Rentang waktu tidak valid");
        }
        const history = await getHistory().getDeviceHistory({
            deviceId: payload.id,
            from: payload.from,
            to: payload.to,
        });
        return { history };
    });

    register("getNetworkDownHistory", true, async (payload) => {
        if (!payload) {
            throw new Error("Rentang waktu tidak valid");
        }
        const history = await getHistory().getDownHistory(rangeParams(payload));
        return { history };
    });

    register("getNetworkDownEvents", true, async (payload) => {
        if (!payload) {
            throw new Error("Rentang waktu tidak valid");
        }
        const { events, effectiveTo, truncated } = await getHistory().getDownEvents(rangeParams(payload));
        return { events, effectiveTo, truncated };
    });

    register("getNetworkPingSummary", true, async (payload) => {
        if (!payload) {
            throw new Error("Rentang waktu tidak valid");
        }
        const summary = await getPing().getPingSummary(rangeParams(payload));
        return { summary };
    });

    register("getNetworkPingSeries", true, async (payload) => {
        if (!payload) {
            throw new Error("Rentang waktu tidak valid");
        }
        const ping = await getPing().getPingSeries({ ids: payload.ids, from: payload.from, to: payload.to });
        return { ping };
    });

    register("addDevicesToMonitoring", true, async (payload) => {
        if (!payload) {
            throw new Error("Pilih minimal satu perangkat");
        }
        const result = await getMonitoring().addDevicesToMonitoring(
            {
                userID: socket.userID,
                devices: payload.devices,
                interval: payload.interval,
                parent: payload.parent ?? null,
                notificationIDList: payload.notificationIDList || {},
            },
            {
                startMonitor: deps.startMonitor,
                updateMonitorNotification: deps.updateMonitorNotification,
                sendUpdateMonitorIntoList: (monitorID) => server.sendUpdateMonitorIntoList(socket, monitorID),
            }
        );
        // A device linked to a monitor that already existed: that monitor moves into the device's category group.
        // Devices without a category take the category of the group they were put in.
        const requested = Array.isArray(payload.devices) ? payload.devices.map((d) => d?.id) : [];
        const sync = await runSync(await withCategory(requested));
        if (sync.categoriesChanged) {
            await emitCategoryList();
        }
        await emitDeviceList();
        return result;
    });

    register("importNetworkDevices", true, async (payload) => {
        if (!payload || !Array.isArray(payload.rows)) {
            throw new Error("Tidak ada baris untuk diimpor");
        }
        const importer = getImporter();
        if (payload.dryRun === true) {
            return await importer.previewImport({ rows: payload.rows, options: payload.options });
        }
        const result = await importer.importDevices({
            rows: payload.rows,
            options: payload.options,
            userID: socket.userID,
            deps: {
                startMonitor: deps.startMonitor,
                updateMonitorNotification: deps.updateMonitorNotification,
                sendUpdateMonitorIntoList: (monitorID) => server.sendUpdateMonitorIntoList(socket, monitorID),
                syncCategories: async (deviceIds) => {
                    await runSync(await withCategory(deviceIds));
                },
            },
        });
        // New monitors of devices without a category take the category of the group they were put in.
        await runSync(null);
        await emitCategoryList();
        await emitDeviceList();
        return result;
    });

    register("deleteNetworkDevice", true, async (payload) => {
        if (!payload || !(await getStore().deleteDevice(payload.id))) {
            throw new Error("Perangkat tidak ditemukan");
        }
        await emitDeviceList();
        return {};
    });
};
