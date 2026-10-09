const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const realScanner = require("../../server/network-scanner");
const { networkScanSocketHandler } = require("../../server/socket-handlers/network-scan-socket-handler");

const { ScanToolError } = realScanner;
const NO_PAYLOAD_EVENTS = new Set([
    "getLocalSubnets",
    "getNetworkDevices",
    "getNetworkScanStatus",
    "getNetworkCategories",
    "getNetworkScanSchedule",
    "getNetworkReportSettings",
]);
const ALL_EVENTS = [
    "getLocalSubnets",
    "getNetworkDevices",
    "startNetworkScan",
    "cancelNetworkScan",
    "getNetworkScanStatus",
    "updateNetworkDevice",
    "deleteNetworkDevice",
    "getNetworkCategories",
    "addNetworkCategory",
    "renameNetworkCategory",
    "deleteNetworkCategory",
    "setNetworkDeviceCategory",
    "getNetworkDeviceUptime",
    "getNetworkUptimeSummary",
    "importNetworkDevices",
    "getNetworkDeviceHistory",
    "getNetworkDownHistory",
    "getNetworkPingSummary",
    "getNetworkPingSeries",
    "getNetworkDownEvents",
    "setNetworkDevicesCategory",
    "getNetworkScanSchedule",
    "saveNetworkScanSchedule",
    "acknowledgeNetworkDevices",
    "setNetworkDevicesDependency",
    "getNetworkReportSettings",
    "saveNetworkReportSettings",
    "downloadNetworkReport",
    "saveNetworkReportNow",
    "exportNetworkInventory",
];

/**
 * Wait until the harness has recorded an event with the given name.
 * @param {object[]} emitted Recorded server events
 * @param {string} event Event name
 * @returns {Promise<object>} The first matching record
 */
async function waitForEvent(emitted, event) {
    for (let i = 0; i < 500; i++) {
        const found = emitted.find((e) => e.event === event);
        if (found) {
            return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`Timed out waiting for ${event}`);
}

/**
 * Build a fake socket, server, scanner and store around the real handler.
 * @param {object} options Overrides
 * @param {boolean} options.loggedIn Whether the socket has a session
 * @param {Function} options.scan Replacement for scanner.scan
 * @returns {object} Harness
 */
function createHarness({ loggedIn = true, scan } = {}) {
    const handlers = new Map();
    const emitted = [];
    const mergeCalls = [];
    const calls = [];
    const socket = {
        userID: 1,
        session: loggedIn ? {} : undefined,
        on: (event, fn) => handlers.set(event, fn),
    };
    const server = {
        io: {
            to: (room) => ({ emit: (event, data) => emitted.push({ room, event, data }) }),
        },
    };
    const devices = [{ id: 1, ip: "10.0.0.1" }];
    const store = {
        listDevices: async () => devices,
        mergeScan: async (args) => {
            mergeCalls.push(args);
            return { found: args.devices.length, new: args.devices.length, missing: 0 };
        },
        updateLabel: async (id) => id === 1,
        deleteDevice: async (id) => id === 1,
        listCategories: async () => [{ id: 7, name: "Terminal 2", subcategories: [] }],
        addCategory: async (name) => {
            calls.push(["addCategory", name]);
            return { id: 8, name };
        },
        addSubcategory: async (categoryId, name) => {
            calls.push(["addSubcategory", categoryId, name]);
            if (categoryId !== 7) {
                throw new Error("Kategori tidak ditemukan");
            }
            return { id: 9, name };
        },
        renameCategory: async (id, name) => {
            calls.push(["renameCategory", id, name]);
            return id === 7;
        },
        deleteCategory: async (id) => {
            calls.push(["deleteCategory", id]);
            return id === 7;
        },
        setDeviceCategory: async (id, categoryId, subcategoryId) => {
            calls.push(["setDeviceCategory", id, categoryId, subcategoryId]);
            if (categoryId === 99) {
                throw new Error("Kategori tidak ditemukan");
            }
            return id === 1;
        },
        getDevicesByIds: async (ids) =>
            ids.filter((id) => id === 1 || id === 2).map((id) => ({ id, categoryId: id === 1 ? 7 : null })),
        setDevicesCategory: async (ids, categoryId, subcategoryId) => {
            calls.push(["setDevicesCategory", ids, categoryId, subcategoryId]);
            if (!Array.isArray(ids)) {
                // Same message as the real store
                throw new Error("Pilih 1 sampai 2000 perangkat");
            }
            if (categoryId === 99) {
                throw new Error("Kategori tidak ditemukan");
            }
            return ids.filter((id) => id === 1 || id === 2).length;
        },
    };
    store.acknowledgeDevices = async (ids) => {
        calls.push(["acknowledgeDevices", ids]);
        if (ids !== "all" && !Array.isArray(ids)) {
            throw new Error("Pilih 1 sampai 2000 perangkat");
        }
        return ids === "all" ? 3 : ids.length;
    };
    store.setDevicesDependency = async (ids, dependsOnId) => {
        calls.push(["setDevicesDependency", ids, dependsOnId]);
        if (!Array.isArray(ids)) {
            throw new Error("Pilih 1 sampai 2000 perangkat");
        }
        if (dependsOnId !== null && ids.includes(dependsOnId)) {
            throw new Error("Perangkat tidak bisa bergantung pada dirinya sendiri");
        }
        return ids.length;
    };
    let storedSchedule = { enabled: false, intervalMinutes: 60, ranges: [], notificationIDList: [] };
    const schedule = {
        getSchedule: async () => storedSchedule,
        saveSchedule: async (input) => {
            calls.push(["saveSchedule", input]);
            if (!input || input.intervalMinutes < 5) {
                throw new Error("Jeda scan harus 5 sampai 1440 menit");
            }
            storedSchedule = input;
            return storedSchedule;
        },
        nextRunAt: (value) => (value.enabled ? 1234 : null),
    };
    const uptime = {
        getDeviceUptime: async (params) => {
            calls.push(["getDeviceUptime", params]);
            if (params.deviceId === 99) {
                throw new Error("Perangkat tidak ditemukan");
            }
            return { upSeconds: 10 };
        },
        getUptimeSummary: async (params) => {
            calls.push(["getUptimeSummary", params]);
            return { items: [{ deviceId: 1, upSeconds: 10 }] };
        },
    };
    const importer = {
        previewImport: async (params) => {
            calls.push(["previewImport", params]);
            if (params.options.interval === "bad") {
                throw new Error("Interval tidak valid");
            }
            return { rows: [{ row: 2, status: "new" }], counts: { new: 1, update: 0, error: 0, monitorsToAdd: 1 } };
        },
        importDevices: async (params) => {
            calls.push(["importDevices", params]);
            return { created: 1, updated: 0, categoriesCreated: 0, monitorsAdded: 1, monitorsSkipped: 0, rows: [] };
        },
    };
    const history = {
        getDeviceHistory: async (params) => {
            calls.push(["getDeviceHistory", params]);
            if (params.deviceId === 99) {
                throw new Error("Perangkat tidak ditemukan");
            }
            return { segments: [] };
        },
        getDownHistory: async (params) => {
            calls.push(["getDownHistory", params]);
            return { devices: [] };
        },
        getDownEvents: async (params) => {
            calls.push(["getDownEvents", params]);
            return { events: [], effectiveTo: 5, truncated: false };
        },
    };
    const ping = {
        getPingSummary: async (params) => {
            calls.push(["getPingSummary", params]);
            return { resolution: "hour", items: [] };
        },
        getPingSeries: async (params) => {
            calls.push(["getPingSeries", params]);
            if (params.ids.length > 5) {
                throw new Error("Pilih 1 sampai 5 perangkat");
            }
            return { resolution: "hour", series: [] };
        },
    };
    const scanner = {
        ...realScanner,
        getLocalSubnets: () => ["10.0.0.0/24"],
        scan:
            scan ||
            (async ({ ips, onProgress }) => {
                onProgress({ done: ips.length, total: ips.length, found: 1 });
                return {
                    devices: [{ ip: ips[0], mac: null, hostname: null, vendor: null, detectedVia: "ping" }],
                    completed: true,
                    arpAvailable: true,
                    total: ips.length,
                };
            }),
    };
    let reportSettings = { enabled: false, folder: "", hour: 7 };
    const report = {
        previousMonth: () => "2026-09",
        buildMonthlyReport: async (params) => {
            calls.push(["buildMonthlyReport", params]);
            if (params.month !== "2026-09") {
                throw new Error("Bulan tidak valid (tulis sebagai TTTT-BB, misalnya 2026-09)");
            }
            return { filename: "laporan-jaringan-2026-09.xlsx", buffer: Buffer.from("PKfake"), devices: 3 };
        },
    };
    const inventoryExport = {
        buildInventoryExport: async (params) => {
            calls.push(["buildInventoryExport", params]);
            return { filename: "inventaris-jaringan-20261009-0805.xlsx", buffer: Buffer.from("PKinv"), devices: 4 };
        },
    };
    const reportSchedule = {
        getSchedule: async () => reportSettings,
        saveSchedule: async (input, dataDir) => {
            calls.push(["saveReportSchedule", input, dataDir]);
            if (input.hour > 23) {
                throw new Error("Jam harus antara 0 dan 23");
            }
            reportSettings = input;
            return reportSettings;
        },
        reportFolder: (settings, dataDir) => settings.folder || `${dataDir}/reports`,
        saveReport: async (params) => {
            calls.push(["saveReport", params]);
            return { file: `${params.folder}/laporan-jaringan-${params.month}.xlsx`, devices: 3 };
        },
    };
    // Category <-> group sync: records what the handler asks for; rename and delete go through the fake store.
    const syncCalls = [];
    const categorySync = {
        syncCategories: async ({ place, userID }) => {
            syncCalls.push({ place, userID });
            return {
                categoriesChanged: false,
                devicesChanged: false,
                monitorsCreated: [],
                monitorsUpdated: [],
                monitorsDeleted: [],
            };
        },
        renameCategory: async (id, name) => ((await store.renameCategory(id, name)) ? { monitorsUpdated: [] } : false),
        deleteCategory: async (id) => ({
            deleted: await store.deleteCategory(id),
            monitorsUpdated: [],
            monitorsDeleted: [],
        }),
    };
    networkScanSocketHandler(socket, server, {
        categorySync,
        schedule,
        report,
        inventoryExport,
        reportSchedule,
        dataDir: "/data",
        startMonitor: async () => {},
        updateMonitorNotification: async () => {},
        scanner,
        store,
        uptime,
        importer,
        history,
        ping,
    });
    return {
        emitted,
        mergeCalls,
        calls,
        syncCalls,
        /**
         * Invoke a handler the way Socket.IO does and resolve with the callback argument.
         * @param {string} event Event name
         * @param {object} payload Payload (ignored for events without one)
         * @returns {Promise<object>} Callback argument
         */
        call: (event, payload) =>
            new Promise((resolve, reject) => {
                const handler = handlers.get(event);
                if (!handler) {
                    reject(new Error(`No handler for ${event}`));
                    return;
                }
                const args = NO_PAYLOAD_EVENTS.has(event) ? [resolve] : [payload, resolve];
                Promise.resolve(handler(...args)).catch(reject);
            }),
    };
}

describe("network scan socket handler", () => {
    test("rejects every event when not logged in", async () => {
        const h = createHarness({ loggedIn: false });
        for (const event of ALL_EVENTS) {
            const reply = await h.call(event, {});
            assert.deepEqual(reply, { ok: false, msg: "You are not logged in." }, event);
        }
    });

    test("getLocalSubnets returns the machine subnets", async () => {
        const h = createHarness();
        assert.deepEqual(await h.call("getLocalSubnets"), { ok: true, subnets: ["10.0.0.0/24"] });
    });

    test("getNetworkDevices returns the inventory", async () => {
        const h = createHarness();
        assert.deepEqual(await h.call("getNetworkDevices"), { ok: true, devices: [{ id: 1, ip: "10.0.0.1" }] });
    });

    test("rejects invalid ranges without starting a scan", async () => {
        let started = false;
        const h = createHarness({
            scan: async () => {
                started = true;
            },
        });
        const reply = await h.call("startNetworkScan", { ranges: ["10.0.0.999"] });
        assert.equal(reply.ok, false);
        assert.match(reply.msg, /10\.0\.0\.999/);
        assert.equal(started, false);
        assert.equal((await h.call("getNetworkScanStatus")).running, false);
    });

    test("rejects a payload without a ranges array", async () => {
        const h = createHarness();
        for (const payload of [undefined, null, {}, { ranges: "10.0.0.0/24" }]) {
            const reply = await h.call("startNetworkScan", payload);
            assert.equal(reply.ok, false);
        }
    });

    test("rejects ranges with nothing scannable", async () => {
        const h = createHarness();
        assert.deepEqual(await h.call("startNetworkScan", { ranges: ["127.0.0.1"] }), {
            ok: false,
            msg: "Tidak ada alamat yang bisa di-scan",
        });
    });

    test("runs a scan and merges results", async () => {
        const h = createHarness();
        const reply = await h.call("startNetworkScan", { ranges: ["10.0.0.0/30"] });
        assert.equal(reply.ok, true);
        assert.equal(typeof reply.scanId, "number");

        const done = await waitForEvent(h.emitted, "networkScanDone");
        await waitForEvent(h.emitted, "networkDeviceList");
        assert.deepEqual(
            h.emitted.map((e) => e.event),
            ["networkScanProgress", "networkScanDone", "networkDeviceList"]
        );
        assert.ok(h.emitted.every((e) => e.room === 1));
        assert.deepEqual(h.emitted[0].data, { scanId: reply.scanId, done: 2, total: 2, found: 1 });
        assert.deepEqual(done.data, {
            scanId: reply.scanId,
            cancelled: false,
            summary: { found: 1, new: 1, missing: 0, arpAvailable: true },
        });
        assert.equal(h.mergeCalls.length, 1);
        assert.equal(h.mergeCalls[0].complete, true);
        assert.deepEqual(h.mergeCalls[0].scannedIPs, ["10.0.0.1", "10.0.0.2"]);
        assert.deepEqual(h.emitted[2].data, [{ id: 1, ip: "10.0.0.1" }]);
    });

    test("refuses a second scan while one runs and reports status", async () => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const h = createHarness({
            scan: async ({ ips, onProgress }) => {
                onProgress({ done: 1, total: ips.length, found: 1 });
                await gate;
                return { devices: [], completed: true, arpAvailable: true, total: ips.length };
            },
        });
        const first = await h.call("startNetworkScan", { ranges: ["10.0.0.0/30"] });
        assert.equal(first.ok, true);

        assert.deepEqual(await h.call("startNetworkScan", { ranges: ["10.0.1.0/30"] }), {
            ok: false,
            msg: "Scan sedang berjalan",
        });
        assert.deepEqual(await h.call("getNetworkScanStatus"), {
            ok: true,
            running: true,
            scanId: first.scanId,
            done: 1,
            total: 2,
            found: 1,
        });

        release();
        await waitForEvent(h.emitted, "networkDeviceList");
        assert.equal((await h.call("getNetworkScanStatus")).running, false);
    });

    test("cancel stops the scan and merges without marking devices missing", async () => {
        const h = createHarness({
            scan: async ({ ips, signal }) => {
                await new Promise((resolve) => signal.addEventListener("abort", resolve));
                return {
                    devices: [{ ip: ips[0], mac: null, hostname: null, vendor: null, detectedVia: "ping" }],
                    completed: false,
                    arpAvailable: false,
                    total: ips.length,
                };
            },
        });
        const { scanId } = await h.call("startNetworkScan", { ranges: ["10.0.0.0/30"] });
        assert.deepEqual(await h.call("cancelNetworkScan", { scanId }), { ok: true });

        const done = await waitForEvent(h.emitted, "networkScanDone");
        assert.equal(done.data.cancelled, true);
        assert.equal(done.data.summary.arpAvailable, true, "no ARP warning for a cancelled scan");
        assert.equal(h.mergeCalls.length, 1);
        assert.equal(h.mergeCalls[0].complete, false);
    });

    test("cancel with nothing running or a wrong scan id fails", async () => {
        const h = createHarness();
        assert.equal((await h.call("cancelNetworkScan", { scanId: 1 })).ok, false);

        const h2 = createHarness({
            scan: async ({ ips, signal }) => {
                await new Promise((resolve) => signal.addEventListener("abort", resolve));
                return { devices: [], completed: false, arpAvailable: false, total: ips.length };
            },
        });
        const { scanId } = await h2.call("startNetworkScan", { ranges: ["10.0.0.0/30"] });
        assert.equal((await h2.call("cancelNetworkScan", { scanId: scanId + 100 })).ok, false);
        assert.equal((await h2.call("cancelNetworkScan", { scanId })).ok, true);
        await waitForEvent(h2.emitted, "networkScanDone");
    });

    test("a tool failure resets the scanner and leaves the inventory alone", async () => {
        let calls = 0;
        const h = createHarness({
            scan: async ({ ips }) => {
                calls++;
                if (calls === 1) {
                    throw new ScanToolError("PING_UNAVAILABLE", "Perintah ping tidak tersedia di server ini");
                }
                return { devices: [], completed: true, arpAvailable: true, total: ips.length };
            },
        });
        await h.call("startNetworkScan", { ranges: ["10.0.0.0/30"] });
        const done = await waitForEvent(h.emitted, "networkScanDone");
        assert.equal(done.data.cancelled, false);
        assert.equal(done.data.error, "Perintah ping tidak tersedia di server ini");
        assert.equal(h.mergeCalls.length, 0);

        const again = await h.call("startNetworkScan", { ranges: ["10.0.0.0/30"] });
        assert.equal(again.ok, true);
        for (let i = 0; i < 500 && h.mergeCalls.length === 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
        assert.equal(h.mergeCalls.length, 1);
    });

    test("reports arpAvailable false when the scanner says so", async () => {
        const h = createHarness({
            scan: async ({ ips }) => ({ devices: [], completed: true, arpAvailable: false, total: ips.length }),
        });
        await h.call("startNetworkScan", { ranges: ["10.0.0.0/30"] });
        const done = await waitForEvent(h.emitted, "networkScanDone");
        assert.equal(done.data.summary.arpAvailable, false);
    });

    test("updateNetworkDevice and deleteNetworkDevice reply and refresh the list", async () => {
        const h = createHarness();
        assert.deepEqual(await h.call("updateNetworkDevice", { id: 1, label: "Kamera" }), { ok: true });
        assert.equal(h.emitted.filter((e) => e.event === "networkDeviceList").length, 1);
        assert.deepEqual(await h.call("deleteNetworkDevice", { id: 1 }), { ok: true });
        assert.equal(h.emitted.filter((e) => e.event === "networkDeviceList").length, 2);

        const missing = await h.call("updateNetworkDevice", { id: 99, label: "x" });
        assert.equal(missing.ok, false);
        assert.equal((await h.call("deleteNetworkDevice", { id: 99 })).ok, false);
        assert.equal((await h.call("updateNetworkDevice", undefined)).ok, false);
        assert.equal((await h.call("deleteNetworkDevice", null)).ok, false);
        assert.equal(h.emitted.filter((e) => e.event === "networkDeviceList").length, 2);
    });
    test("getNetworkCategories returns the categories", async () => {
        const h = createHarness();
        assert.deepEqual(await h.call("getNetworkCategories"), {
            ok: true,
            categories: [{ id: 7, name: "Terminal 2", subcategories: [] }],
        });
    });

    test("addNetworkCategory adds a category or a sub category and refreshes the list", async () => {
        const h = createHarness();
        assert.deepEqual(await h.call("addNetworkCategory", { name: "Terminal 3" }), { ok: true, id: 8 });
        assert.deepEqual(await h.call("addNetworkCategory", { name: "CCTV", parentId: 7 }), { ok: true, id: 9 });
        assert.deepEqual(h.calls, [
            ["addCategory", "Terminal 3"],
            ["addSubcategory", 7, "CCTV"],
        ]);
        assert.equal(h.emitted.filter((e) => e.event === "networkCategoryList").length, 2);

        const bad = await h.call("addNetworkCategory", { name: "CCTV", parentId: 99 });
        assert.deepEqual(bad, { ok: false, msg: "Kategori tidak ditemukan" });
        assert.equal((await h.call("addNetworkCategory", undefined)).ok, false);
        assert.equal(h.emitted.filter((e) => e.event === "networkCategoryList").length, 2);
    });

    test("renameNetworkCategory renames and reports unknown ids", async () => {
        const h = createHarness();
        assert.deepEqual(await h.call("renameNetworkCategory", { id: 7, name: "T2" }), { ok: true });
        assert.deepEqual(await h.call("renameNetworkCategory", { id: 99, name: "T2" }), {
            ok: false,
            msg: "Kategori tidak ditemukan",
        });
        assert.equal((await h.call("renameNetworkCategory", null)).ok, false);
        assert.equal(h.emitted.filter((e) => e.event === "networkCategoryList").length, 1);
        // Devices only carry category ids, so a rename does not change them.
        assert.equal(h.emitted.filter((e) => e.event === "networkDeviceList").length, 0);
    });

    test("deleteNetworkCategory refreshes categories and devices", async () => {
        const h = createHarness();
        assert.deepEqual(await h.call("deleteNetworkCategory", { id: 7 }), { ok: true });
        assert.deepEqual(h.emitted.map((e) => e.event).sort(), ["networkCategoryList", "networkDeviceList"]);
        assert.deepEqual(await h.call("deleteNetworkCategory", { id: 99 }), {
            ok: false,
            msg: "Kategori tidak ditemukan",
        });
        assert.equal((await h.call("deleteNetworkCategory", undefined)).ok, false);
    });

    test("setNetworkDeviceCategory assigns the category and refreshes the devices", async () => {
        const h = createHarness();
        const reply = await h.call("setNetworkDeviceCategory", { id: 1, categoryId: 7, subcategoryId: null });
        assert.deepEqual(reply, { ok: true });
        assert.deepEqual(h.calls, [["setDeviceCategory", 1, 7, null]]);
        assert.equal(h.emitted.filter((e) => e.event === "networkDeviceList").length, 1);

        assert.deepEqual(await h.call("setNetworkDeviceCategory", { id: 5, categoryId: null }), {
            ok: false,
            msg: "Perangkat tidak ditemukan",
        });
        assert.deepEqual(await h.call("setNetworkDeviceCategory", { id: 1, categoryId: 99 }), {
            ok: false,
            msg: "Kategori tidak ditemukan",
        });
        assert.equal((await h.call("setNetworkDeviceCategory", undefined)).ok, false);
        assert.equal(h.emitted.filter((e) => e.event === "networkDeviceList").length, 1);
    });

    test("getNetworkDeviceUptime passes the device and range on and replies with the uptime", async () => {
        const h = createHarness();
        const reply = await h.call("getNetworkDeviceUptime", {
            id: 1,
            from: "2026-10-07T10:00:00Z",
            to: "2026-10-07T11:00:00Z",
        });
        assert.deepEqual(reply, { ok: true, uptime: { upSeconds: 10 } });
        assert.deepEqual(h.calls, [
            ["getDeviceUptime", { deviceId: 1, from: "2026-10-07T10:00:00Z", to: "2026-10-07T11:00:00Z" }],
        ]);
    });

    test("getNetworkUptimeSummary replies with the items", async () => {
        const h = createHarness();
        const reply = await h.call("getNetworkUptimeSummary", {
            from: "2026-10-07T10:00:00Z",
            to: "2026-10-07T11:00:00Z",
        });
        assert.deepEqual(reply, { ok: true, items: [{ deviceId: 1, upSeconds: 10 }] });
        assert.deepEqual(h.calls, [["getUptimeSummary", { from: "2026-10-07T10:00:00Z", to: "2026-10-07T11:00:00Z" }]]);
    });

    test("the uptime events refuse an empty payload without calling the uptime module", async () => {
        const h = createHarness();
        for (const event of ["getNetworkDeviceUptime", "getNetworkUptimeSummary"]) {
            assert.deepEqual(await h.call(event, undefined), { ok: false, msg: "Rentang waktu tidak valid" }, event);
            assert.deepEqual(await h.call(event, null), { ok: false, msg: "Rentang waktu tidak valid" }, event);
        }
        assert.deepEqual(h.calls, []);
    });

    describe("history and ping events", () => {
        const FROM = "2026-10-07T10:00:00Z";
        const TO = "2026-10-07T11:00:00Z";

        test("they forward the payload to the modules and answer under their own key", async () => {
            const h = createHarness();
            assert.deepEqual(await h.call("getNetworkDeviceHistory", { id: 1, from: FROM, to: TO }), {
                ok: true,
                history: { segments: [] },
            });
            assert.deepEqual(await h.call("getNetworkDownHistory", { from: FROM, to: TO }), {
                ok: true,
                history: { devices: [] },
            });
            assert.deepEqual(await h.call("getNetworkPingSummary", { from: FROM, to: TO }), {
                ok: true,
                summary: { resolution: "hour", items: [] },
            });
            assert.deepEqual(await h.call("getNetworkPingSeries", { ids: [1, 2], from: FROM, to: TO }), {
                ok: true,
                ping: { resolution: "hour", series: [] },
            });
            assert.deepEqual(h.calls, [
                ["getDeviceHistory", { deviceId: 1, from: FROM, to: TO }],
                ["getDownHistory", { from: FROM, to: TO }],
                ["getPingSummary", { from: FROM, to: TO }],
                ["getPingSeries", { ids: [1, 2], from: FROM, to: TO }],
            ]);
        });

        test("they refuse an empty payload without calling a module", async () => {
            const h = createHarness();
            for (const event of [
                "getNetworkDeviceHistory",
                "getNetworkDownHistory",
                "getNetworkPingSummary",
                "getNetworkPingSeries",
                "getNetworkDownEvents",
            ]) {
                assert.deepEqual(
                    await h.call(event, undefined),
                    { ok: false, msg: "Rentang waktu tidak valid" },
                    event
                );
                assert.deepEqual(await h.call(event, null), { ok: false, msg: "Rentang waktu tidak valid" }, event);
            }
            assert.deepEqual(h.calls, []);
        });

        test("they pass module errors through", async () => {
            const h = createHarness();
            assert.deepEqual(await h.call("getNetworkDeviceHistory", { id: 99, from: FROM, to: TO }), {
                ok: false,
                msg: "Perangkat tidak ditemukan",
            });
            assert.deepEqual(await h.call("getNetworkPingSeries", { ids: [1, 2, 3, 4, 5, 6], from: FROM, to: TO }), {
                ok: false,
                msg: "Pilih 1 sampai 5 perangkat",
            });
        });
    });

    test("an error from the uptime module becomes a failed reply", async () => {
        const h = createHarness();
        const reply = await h.call("getNetworkDeviceUptime", { id: 99, from: "a", to: "b" });
        assert.deepEqual(reply, { ok: false, msg: "Perangkat tidak ditemukan" });
    });
    test("importNetworkDevices with dryRun only previews and sends no list", async () => {
        const h = createHarness();
        const options = { type: "ping", interval: 60 };
        const reply = await h.call("importNetworkDevices", {
            rows: [{ row: 2, ip: "10.0.0.1" }],
            options,
            dryRun: true,
        });
        assert.equal(reply.ok, true);
        assert.deepEqual(reply.counts, { new: 1, update: 0, error: 0, monitorsToAdd: 1 });
        assert.deepEqual(
            h.calls.map((c) => c[0]),
            ["previewImport"]
        );
        assert.equal(
            h.emitted.some((e) => e.event === "networkDeviceList" || e.event === "networkCategoryList"),
            false
        );
    });

    test("importNetworkDevices imports with the user and sends the device and category lists", async () => {
        const h = createHarness();
        const rows = [{ row: 2, ip: "10.0.0.1" }];
        const options = { type: "ping", interval: 60 };
        const reply = await h.call("importNetworkDevices", { rows, options });
        assert.equal(reply.ok, true);
        assert.equal(reply.created, 1);
        assert.equal(reply.monitorsAdded, 1);

        const [name, params] = h.calls[0];
        assert.equal(name, "importDevices");
        assert.deepEqual(params.rows, rows);
        assert.deepEqual(params.options, options);
        assert.equal(params.userID, 1);
        assert.equal(typeof params.deps.startMonitor, "function");
        assert.equal(typeof params.deps.sendUpdateMonitorIntoList, "function");

        const events = h.emitted.map((e) => e.event);
        assert.ok(events.includes("networkDeviceList"));
        assert.ok(events.includes("networkCategoryList"));
    });

    test("importNetworkDevices refuses an empty payload or rows that are not a list", async () => {
        const h = createHarness();
        assert.equal((await h.call("importNetworkDevices", undefined)).ok, false);
        assert.equal((await h.call("importNetworkDevices", { rows: "nope", options: {} })).ok, false);
        assert.equal(h.calls.length, 0);
    });

    test("an error from the import module becomes a failed reply", async () => {
        const h = createHarness();
        const reply = await h.call("importNetworkDevices", {
            rows: [{ row: 2, ip: "10.0.0.1" }],
            options: { interval: "bad" },
            dryRun: true,
        });
        assert.deepEqual(reply, { ok: false, msg: "Interval tidak valid" });
    });

    describe("device filter and bulk category events", () => {
        const FROM = "2026-10-07T10:00:00Z";
        const TO = "2026-10-07T11:00:00Z";

        test("the summary events pass deviceIds on when the client sends them, even an empty list", async () => {
            const h = createHarness();
            await h.call("getNetworkUptimeSummary", { from: FROM, to: TO, deviceIds: [1, 2] });
            await h.call("getNetworkDownHistory", { from: FROM, to: TO, deviceIds: [1, 2] });
            await h.call("getNetworkPingSummary", { from: FROM, to: TO, deviceIds: [] });
            assert.deepEqual(h.calls, [
                ["getUptimeSummary", { from: FROM, to: TO, deviceIds: [1, 2] }],
                ["getDownHistory", { from: FROM, to: TO, deviceIds: [1, 2] }],
                ["getPingSummary", { from: FROM, to: TO, deviceIds: [] }],
            ]);
        });

        test("getNetworkDownEvents forwards the range and the devices and replies with the events", async () => {
            const h = createHarness();
            assert.deepEqual(await h.call("getNetworkDownEvents", { from: FROM, to: TO, deviceIds: [1] }), {
                ok: true,
                events: [],
                effectiveTo: 5,
                truncated: false,
            });
            await h.call("getNetworkDownEvents", { from: FROM, to: TO });
            assert.deepEqual(h.calls, [
                ["getDownEvents", { from: FROM, to: TO, deviceIds: [1] }],
                ["getDownEvents", { from: FROM, to: TO }],
            ]);
        });

        test("setNetworkDevicesCategory changes the devices and refreshes the list once", async () => {
            const h = createHarness();
            const reply = await h.call("setNetworkDevicesCategory", {
                ids: [1, 2, 3],
                categoryId: 7,
                subcategoryId: null,
            });
            assert.deepEqual(reply, { ok: true, updated: 2 });
            assert.deepEqual(h.calls, [["setDevicesCategory", [1, 2, 3], 7, null]]);
            assert.equal(h.emitted.filter((e) => e.event === "networkDeviceList").length, 1);
        });

        test("setNetworkDevicesCategory reports a store error and does not refresh the list", async () => {
            const h = createHarness();
            assert.deepEqual(await h.call("setNetworkDevicesCategory", { ids: [1], categoryId: 99 }), {
                ok: false,
                msg: "Kategori tidak ditemukan",
            });
            assert.deepEqual(await h.call("setNetworkDevicesCategory", undefined), {
                ok: false,
                msg: "Pilih 1 sampai 2000 perangkat",
            });
            assert.equal(h.emitted.filter((e) => e.event === "networkDeviceList").length, 0);
        });
    });
    describe("unknown devices and schedule", () => {
        test("acknowledgeNetworkDevices confirms the chosen devices, or all of them, and refreshes the list", async () => {
            const h = createHarness();
            assert.deepEqual(await h.call("acknowledgeNetworkDevices", { ids: [1, 2] }), { ok: true, updated: 2 });
            assert.deepEqual(await h.call("acknowledgeNetworkDevices", { all: true }), { ok: true, updated: 3 });
            assert.deepEqual(h.calls, [
                ["acknowledgeDevices", [1, 2]],
                ["acknowledgeDevices", "all"],
            ]);
            assert.equal(h.emitted.filter((e) => e.event === "networkDeviceList").length, 2);
        });

        test("acknowledgeNetworkDevices reports a store error", async () => {
            const h = createHarness();
            assert.deepEqual(await h.call("acknowledgeNetworkDevices", undefined), {
                ok: false,
                msg: "Pilih 1 sampai 2000 perangkat",
            });
        });

        test("setNetworkDevicesDependency sets or clears the dependency and refreshes the list", async () => {
            const h = createHarness();
            assert.deepEqual(await h.call("setNetworkDevicesDependency", { ids: [1, 2], dependsOnId: 5 }), {
                ok: true,
                updated: 2,
            });
            assert.deepEqual(await h.call("setNetworkDevicesDependency", { ids: [1] }), { ok: true, updated: 1 });
            assert.deepEqual(h.calls, [
                ["setDevicesDependency", [1, 2], 5],
                ["setDevicesDependency", [1], null],
            ]);
            assert.equal(h.emitted.filter((e) => e.event === "networkDeviceList").length, 2);
        });

        test("setNetworkDevicesDependency reports a store error and does not refresh the list", async () => {
            const h = createHarness();
            assert.deepEqual(await h.call("setNetworkDevicesDependency", { ids: [3], dependsOnId: 3 }), {
                ok: false,
                msg: "Perangkat tidak bisa bergantung pada dirinya sendiri",
            });
            assert.deepEqual(await h.call("setNetworkDevicesDependency", undefined), {
                ok: false,
                msg: "Pilih 1 sampai 2000 perangkat",
            });
            assert.equal(h.emitted.filter((e) => e.event === "networkDeviceList").length, 0);
        });

        test("the monthly report can be downloaded and saved in the folder", async () => {
            const h = createHarness();
            assert.deepEqual(await h.call("downloadNetworkReport", { month: "2026-09" }), {
                ok: true,
                filename: "laporan-jaringan-2026-09.xlsx",
                data: Buffer.from("PKfake").toString("base64"),
                devices: 3,
            });
            assert.deepEqual(await h.call("downloadNetworkReport", { month: "bad" }), {
                ok: false,
                msg: "Bulan tidak valid (tulis sebagai TTTT-BB, misalnya 2026-09)",
            });
            assert.deepEqual(await h.call("saveNetworkReportNow", { month: "2026-09" }), {
                ok: true,
                file: "/data/reports/laporan-jaringan-2026-09.xlsx",
                devices: 3,
            });
        });

        test("the inventory can be exported to Excel, and only when logged in", async () => {
            const h = createHarness();
            assert.deepEqual(await h.call("exportNetworkInventory"), {
                ok: true,
                filename: "inventaris-jaringan-20261009-0805.xlsx",
                data: Buffer.from("PKinv").toString("base64"),
                devices: 4,
            });
            const out = createHarness({ loggedIn: false });
            assert.equal((await out.call("exportNetworkInventory")).ok, false);
        });

        test("the settings of the automatic report can be read and saved", async () => {
            const h = createHarness();
            assert.deepEqual(await h.call("getNetworkReportSettings"), {
                ok: true,
                settings: { enabled: false, folder: "", hour: 7 },
                folder: "/data/reports",
                lastMonth: "2026-09",
            });
            assert.deepEqual(await h.call("saveNetworkReportSettings", { enabled: true, folder: "/x", hour: 6 }), {
                ok: true,
                settings: { enabled: true, folder: "/x", hour: 6 },
                folder: "/x",
            });
            assert.deepEqual(await h.call("saveNetworkReportSettings", { enabled: true, folder: "", hour: 30 }), {
                ok: false,
                msg: "Jam harus antara 0 dan 23",
            });
        });

        test("the schedule can be read and saved", async () => {
            const h = createHarness();
            const first = await h.call("getNetworkScanSchedule");
            assert.equal(first.ok, true);
            assert.equal(first.schedule.enabled, false);
            assert.equal(first.nextRunAt, null);

            const input = { enabled: true, intervalMinutes: 30, ranges: ["10.0.0.0/24"], notificationIDList: [1] };
            assert.deepEqual(await h.call("saveNetworkScanSchedule", input), {
                ok: true,
                schedule: input,
                nextRunAt: 1234,
            });
            assert.equal((await h.call("getNetworkScanSchedule")).schedule.intervalMinutes, 30);
        });

        test("a wrong schedule is refused with the message of the validation", async () => {
            const h = createHarness();
            assert.deepEqual(await h.call("saveNetworkScanSchedule", { intervalMinutes: 1 }), {
                ok: false,
                msg: "Jeda scan harus 5 sampai 1440 menit",
            });
        });
    });
});
