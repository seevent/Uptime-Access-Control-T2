const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const knexFactory = require("knex");
const { R } = require("redbean-node");
const migration = require("../../db/knex_migrations/2026-10-06-0000-add-network-device");
const categoryMigration = require("../../db/knex_migrations/2026-10-08-0000-add-network-device-category");
const store = require("../../server/network-device-store");
const importer = require("../../server/network-device-import");

/**
 * @param {number} row Row number in the file
 * @param {string} ip Address
 * @param {object} extra Fields that replace the defaults
 * @returns {object} An import item
 */
function item(row, ip, extra = {}) {
    return { row, ip, name: "", category: "", subcategory: "", type: "", port: "", ...extra };
}

/**
 * @param {object} extra Fields that replace the defaults
 * @returns {object} Settings for the whole import
 */
function opts(extra = {}) {
    return { type: "ping", interval: 60, parent: null, notificationIDList: {}, ...extra };
}

/**
 * @param {string} ip Address
 * @param {object} extra Fields that replace the defaults
 * @returns {object} A device of the inventory
 */
function device(ip, extra = {}) {
    return { id: 1, ip, label: null, categoryId: null, subcategoryId: null, monitorId: null, ...extra };
}

describe("planImport", () => {
    const plan = (rows, devices = [], options = opts()) => importer.planImport({ rows, options, devices });

    test("accepts valid rows and tells new from existing devices", () => {
        const result = plan(
            [item(2, "10.0.0.1", { name: "A" }), item(3, "10.0.0.2"), item(4, "10.0.0.3")],
            [device("10.0.0.2"), device("10.0.0.3", { id: 2, monitorId: 7 })]
        );
        assert.deepEqual(
            result.rows.map((r) => [r.row, r.status, r.action]),
            [
                [2, "new", "add"],
                [3, "update", "add"],
                [4, "update", "has-monitor"],
            ]
        );
        assert.deepEqual(result.counts, { new: 1, update: 2, error: 0, monitorsToAdd: 2 });
    });

    test("rejects an invalid, empty or duplicate IP", () => {
        const result = plan([
            item(2, "10.0.0.300"),
            item(3, "abc"),
            item(4, ""),
            item(5, "10.0.0.5"),
            item(6, " 10.0.0.5 "),
        ]);
        assert.deepEqual(
            result.rows.map((r) => r.status),
            ["error", "error", "error", "new", "error"]
        );
        assert.equal(result.rows[0].msg, "IP tidak valid");
        assert.equal(result.rows[4].msg, "IP ganda pada baris 5");
        assert.equal(result.counts.error, 4);
    });

    test("rejects names that are too long and a sub category without a category", () => {
        const result = plan([
            item(2, "10.0.0.1", { name: "x".repeat(256) }),
            item(3, "10.0.0.2", { category: "y".repeat(101) }),
            item(4, "10.0.0.3", { category: "A", subcategory: "z".repeat(101) }),
            item(5, "10.0.0.4", { subcategory: "Rak" }),
            item(6, "10.0.0.5", { name: "x".repeat(255), category: "y".repeat(100) }),
        ]);
        assert.deepEqual(
            result.rows.map((r) => r.status),
            ["error", "error", "error", "error", "new"]
        );
        assert.match(result.rows[3].msg, /Sub kategori/);
    });

    test("resolves the monitor type and port of each row", () => {
        const result = plan(
            [
                item(2, "10.0.0.1", { type: "TCP", port: "443" }),
                item(3, "10.0.0.2", { type: "port" }),
                item(4, "10.0.0.3", { type: "foo" }),
                item(5, "10.0.0.4"),
                item(6, "10.0.0.5", { type: "port", port: "70000" }),
            ],
            [],
            opts({ port: 8080 })
        );
        assert.deepEqual(
            result.rows.map((r) => [r.status, r.type, r.port]),
            [
                ["new", "port", 443],
                ["new", "port", 8080],
                ["error", "foo", null],
                ["new", "ping", null],
                ["error", "port", null],
            ]
        );
    });

    test("a port row without any port is an error", () => {
        const result = plan([item(2, "10.0.0.1", { type: "port" })]);
        assert.equal(result.rows[0].status, "error");
        assert.match(result.rows[0].msg, /Port/);
    });

    test("refuses invalid settings and too many rows", () => {
        const rows = [item(2, "10.0.0.1")];
        assert.throws(() => plan(rows, [], opts({ interval: 0 })), /Interval/);
        assert.throws(() => plan(rows, [], opts({ parent: "x" })), /Grup/);
        assert.throws(() => plan(rows, [], opts({ type: "udp" })), /Tipe/);
        assert.throws(() => plan(rows, [], opts({ type: "port" })), /Port/);
        assert.throws(() => plan("nope"), /baris/);
        assert.throws(() => plan([]), /baris/);
        const many = Array.from({ length: 1001 }, (_, i) => item(i + 2, `10.0.${Math.floor(i / 250)}.${i % 250}`));
        assert.throws(() => plan(many), /1000/);
        assert.equal(importer.MAX_ROWS, 1000);
    });
});

describe("importDevices", () => {
    let knex;
    const notStarted = { startMonitor: async () => {}, updateMonitorNotification: async () => {} };

    /**
     * A stand-in for network-device-monitoring that links a fresh monitor row to each device.
     * @param {object} behaviour Options
     * @param {string[]} behaviour.failIps Addresses whose monitor cannot be created
     * @returns {object} The stand-in with a `calls` list of the device ids it was asked for
     */
    function fakeMonitoring({ failIps = [] } = {}) {
        const calls = [];
        return {
            calls,
            addDevicesToMonitoring: async (params) => {
                const result = { added: 0, skipped: 0, failed: [] };
                for (const request of params.devices) {
                    calls.push(request.id);
                    const row = await knex("network_device").where({ id: request.id }).first();
                    if (failIps.includes(row.ip)) {
                        result.failed.push({ id: request.id, msg: "Gagal membuat monitor" });
                        continue;
                    }
                    const [monitorId] = await knex("monitor").insert({});
                    await store.setMonitorId(request.id, monitorId);
                    result.added++;
                }
                return result;
            },
        };
    }

    /**
     * @param {object[]} rows Items
     * @param {object} extra Replaces parts of the call
     * @returns {Promise<object>} Result of importDevices
     */
    const run = (rows, extra = {}) =>
        importer.importDevices({
            rows,
            options: opts(),
            userID: "u1",
            deps: { ...notStarted, monitoring: fakeMonitoring() },
            ...extra,
        });

    before(async () => {
        knex = knexFactory({
            client: "better-sqlite3",
            connection: { filename: ":memory:" },
            useNullAsDefault: true,
            pool: { min: 1, max: 1 },
        });
        await knex.raw("PRAGMA foreign_keys = ON");
        await knex.schema.createTable("monitor", (table) => {
            table.increments("id");
        });
        await migration.up(knex);
        await categoryMigration.up(knex);
        R.setup(knex);
    });

    after(async () => {
        await knex.destroy();
    });

    beforeEach(async () => {
        await knex("network_device").del();
        await knex("network_category").del();
        await knex("monitor").del();
    });

    test("creates devices, categories and sub categories that do not exist yet", async () => {
        const monitoring = fakeMonitoring();
        const result = await run(
            [
                item(2, "10.0.0.1", { name: "CCTV Lobi", category: "Terminal 2", subcategory: "Lobi" }),
                item(3, "10.0.0.2", { name: "CCTV Gate", category: "Terminal 2", subcategory: "Gate" }),
            ],
            { deps: { ...notStarted, monitoring } }
        );
        assert.equal(result.created, 2);
        assert.equal(result.updated, 0);
        assert.equal(result.categoriesCreated, 3);
        assert.equal(result.monitorsAdded, 2);
        assert.deepEqual(
            result.rows.map((r) => r.monitor),
            ["added", "added"]
        );

        const devices = await store.listDevices();
        assert.equal(devices.length, 2);
        const [first] = devices;
        assert.equal(first.label, "CCTV Lobi");
        assert.equal(first.detectedVia, "import");
        assert.equal(first.isOnline, false);
        assert.equal(first.firstSeen, first.lastSeen);
        assert.notEqual(first.monitorId, null);

        const categories = await store.listCategories();
        assert.equal(categories.length, 1);
        assert.deepEqual(
            categories[0].subcategories.map((s) => s.name),
            ["Gate", "Lobi"]
        );
    });

    test("syncs the categories with the groups after saving and before adding monitors", async () => {
        const monitoring = fakeMonitoring();
        const order = [];
        const original = monitoring.addDevicesToMonitoring;
        monitoring.addDevicesToMonitoring = async (params, deps) => {
            order.push("monitor");
            return original(params, deps);
        };
        const synced = [];
        await run([item(2, "10.0.0.1", { category: "Terminal 2" }), item(3, "10.0.0.2")], {
            deps: {
                ...notStarted,
                monitoring,
                syncCategories: async (ids) => {
                    order.push("sync");
                    // The devices are saved by now
                    synced.push((await store.getDevicesByIds(ids)).map((d) => d.ip).sort());
                },
            },
        });
        assert.deepEqual(synced, [["10.0.0.1", "10.0.0.2"]]);
        assert.deepEqual(order, ["sync", "monitor", "monitor"]);
    });

    test("matches categories whatever the case and spaces, and keeps same-named sub categories apart", async () => {
        await run([
            item(2, "10.0.0.1", { category: "Lobi" }),
            item(3, "10.0.0.2", { category: "lobi " }),
            item(4, "10.0.0.3", { category: "LOBI", subcategory: "Rak 1" }),
            item(5, "10.0.0.4", { category: "Gate", subcategory: "Rak 1" }),
        ]);
        const categories = await store.listCategories();
        assert.deepEqual(
            categories.map((c) => c.name),
            ["Gate", "Lobi"]
        );
        assert.equal(categories[0].subcategories.length, 1);
        assert.equal(categories[1].subcategories.length, 1);
        assert.notEqual(categories[0].subcategories[0].id, categories[1].subcategories[0].id);
    });

    test("updates existing devices and never erases with an empty cell", async () => {
        const lobi = await store.addCategory("Lobi");
        const rak = await store.addSubcategory(lobi.id, "Rak 1");
        const gate = await store.addCategory("Gate");
        const now = "2026-10-07 10:00:00";
        const base = { detected_via: "ping", first_seen: now, last_seen: now };
        await knex("network_device").insert([
            { ip: "10.0.0.1", label: "Lama", category_id: lobi.id, subcategory_id: rak.id, ...base },
            { ip: "10.0.0.2", label: "Lama", category_id: lobi.id, subcategory_id: rak.id, ...base },
            { ip: "10.0.0.3", label: "Lama", category_id: lobi.id, subcategory_id: rak.id, ...base },
        ]);
        const result = await run([
            item(2, "10.0.0.1", { name: "", category: "" }),
            item(3, "10.0.0.2", { name: "Baru", category: "lobi" }),
            item(4, "10.0.0.3", { name: "", category: "Gate" }),
        ]);
        assert.equal(result.created, 0);
        assert.equal(result.updated, 3);

        const byIp = Object.fromEntries((await store.listDevices()).map((d) => [d.ip, d]));
        assert.equal(byIp["10.0.0.1"].label, "Lama");
        assert.equal(byIp["10.0.0.1"].categoryId, lobi.id);
        assert.equal(byIp["10.0.0.1"].subcategoryId, rak.id);
        assert.equal(byIp["10.0.0.2"].label, "Baru");
        assert.equal(byIp["10.0.0.2"].subcategoryId, rak.id);
        assert.equal(byIp["10.0.0.3"].categoryId, gate.id);
        assert.equal(byIp["10.0.0.3"].subcategoryId, null);
        assert.equal(byIp["10.0.0.3"].label, "Lama");
    });

    test("importing the same file twice adds nothing the second time", async () => {
        const monitoring = fakeMonitoring();
        const rows = [
            item(2, "10.0.0.1", { name: "A", category: "T2", subcategory: "Lobi" }),
            item(3, "10.0.0.2", { name: "B", category: "T2" }),
        ];
        await run(rows, { deps: { ...notStarted, monitoring } });
        const second = await run(rows, { deps: { ...notStarted, monitoring } });

        assert.equal(second.created, 0);
        assert.equal(second.updated, 2);
        assert.equal(second.categoriesCreated, 0);
        assert.equal(second.monitorsAdded, 0);
        assert.equal(second.monitorsSkipped, 2);
        assert.deepEqual(
            second.rows.map((r) => r.monitor),
            ["skipped", "skipped"]
        );
        assert.equal(monitoring.calls.length, 2);
        assert.equal((await store.listDevices()).length, 2);
        assert.equal((await knex("network_category")).length, 2);
        assert.equal((await knex("monitor")).length, 2);
    });

    test("rolls back everything when saving fails halfway", async () => {
        await knex.raw(
            "CREATE TRIGGER boom BEFORE INSERT ON network_device WHEN NEW.ip = '10.0.0.9' " +
                "BEGIN SELECT RAISE(ABORT, 'boom'); END"
        );
        try {
            await assert.rejects(
                () =>
                    run([
                        item(2, "10.0.0.1", { category: "Baru A" }),
                        item(3, "10.0.0.2", { category: "Baru B" }),
                        item(4, "10.0.0.9", { category: "Baru C" }),
                    ]),
                /boom/
            );
        } finally {
            await knex.raw("DROP TRIGGER boom");
        }
        assert.equal((await store.listDevices()).length, 0);
        assert.equal((await knex("network_category")).length, 0);
    });

    test("a monitor that cannot be created is reported while the device stays saved", async () => {
        const result = await run(
            [item(2, "10.0.0.1", { name: "A" }), item(3, "10.0.0.2", { name: "B" }), item(4, "10.0.0.3")],
            { deps: { ...notStarted, monitoring: fakeMonitoring({ failIps: ["10.0.0.2"] }) } }
        );
        assert.deepEqual(
            result.rows.map((r) => r.monitor),
            ["added", "failed", "added"]
        );
        assert.equal(result.rows[1].msg, "Gagal membuat monitor");
        assert.equal(result.monitorsAdded, 2);
        const failed = (await store.listDevices()).find((d) => d.ip === "10.0.0.2");
        assert.equal(failed.label, "B");
        assert.equal(failed.monitorId, null);
    });

    test("rows with an error never touch the database", async () => {
        const monitoring = fakeMonitoring();
        const result = await run(
            [item(2, "10.0.0.300", { category: "Tidak Boleh Ada" }), item(3, "10.0.0.1", { name: "OK" })],
            { deps: { ...notStarted, monitoring } }
        );
        assert.deepEqual(
            result.rows.map((r) => [r.status, r.monitor]),
            [
                ["error", null],
                ["new", "added"],
            ]
        );
        assert.equal(result.created, 1);
        assert.equal((await knex("network_category")).length, 0);
        assert.equal(monitoring.calls.length, 1);
    });

    test("previewImport reports the same plan without writing", async () => {
        const preview = await importer.previewImport({
            rows: [item(2, "10.0.0.1", { category: "Baru" })],
            options: opts(),
        });
        assert.equal(preview.rows[0].status, "new");
        assert.equal((await store.listDevices()).length, 0);
        assert.equal((await knex("network_category")).length, 0);
    });
});
