const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const knexFactory = require("knex");
const { R } = require("redbean-node");
const migration = require("../../db/knex_migrations/2026-10-06-0000-add-network-device");
const categoryMigration = require("../../db/knex_migrations/2026-10-08-0000-add-network-device-category");
const acknowledgedMigration = require("../../db/knex_migrations/2026-10-10-0000-add-network-device-acknowledged");
const store = require("../../server/network-device-store");

const COLUMNS = [
    "id",
    "ip",
    "mac",
    "hostname",
    "vendor",
    "label",
    "detected_via",
    "first_seen",
    "last_seen",
    "is_online",
    "monitor_id",
    "category_id",
    "subcategory_id",
    "acknowledged",
    "alert_note",
];

/**
 * An in-memory SQLite database with a minimal `monitor` table (the migration references it).
 * @returns {Promise<import("knex").Knex>} Knex instance
 */
async function createKnex() {
    const knex = knexFactory({
        client: "better-sqlite3",
        connection: { filename: ":memory:" },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 },
    });
    await knex.raw("PRAGMA foreign_keys = ON");
    await knex.schema.createTable("monitor", (table) => {
        table.increments("id");
    });
    return knex;
}

/**
 * @param {string} ip Address
 * @param {object} extra Fields that replace the defaults
 * @returns {object} A scanned device
 */
function scanned(ip, extra = {}) {
    return { ip, mac: "AA:BB:CC:00:00:01", hostname: "host.lan", vendor: "Vendor", detectedVia: "ping", ...extra };
}

describe("migration", () => {
    test("creates the table and drops it again", async () => {
        const knex = await createKnex();
        try {
            await migration.up(knex);
            await categoryMigration.up(knex);
            await acknowledgedMigration.up(knex);
            for (const column of COLUMNS) {
                assert.equal(await knex.schema.hasColumn("network_device", column), true, column);
            }
            const now = "2026-10-07 10:00:00";
            const row = { ip: "10.0.0.1", detected_via: "ping", first_seen: now, last_seen: now };
            await knex("network_device").insert(row);
            await assert.rejects(() => knex("network_device").insert(row), /UNIQUE/i);

            await acknowledgedMigration.down(knex);
            assert.equal(await knex.schema.hasColumn("network_device", "acknowledged"), false);

            await categoryMigration.down(knex);
            assert.equal(await knex.schema.hasTable("network_category"), false);
            assert.equal(await knex.schema.hasColumn("network_device", "category_id"), false);
            assert.equal(await knex.schema.hasColumn("network_device", "label"), true);

            await migration.down(knex);
            assert.equal(await knex.schema.hasTable("network_device"), false);
        } finally {
            await knex.destroy();
        }
    });
});

describe("network device store", () => {
    let knex;

    before(async () => {
        knex = await createKnex();
        await migration.up(knex);
        await categoryMigration.up(knex);
        await acknowledgedMigration.up(knex);
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

    test("inserts new devices", async () => {
        const now = new Date("2026-10-07T10:00:00Z");
        const summary = await store.mergeScan({
            devices: [scanned("10.0.0.5")],
            scannedIPs: ["10.0.0.5"],
            complete: true,
            now,
        });
        assert.deepEqual(summary, { found: 1, new: 1, missing: 0 });

        const [device] = await store.listDevices();
        assert.equal(device.ip, "10.0.0.5");
        assert.equal(device.mac, "AA:BB:CC:00:00:01");
        assert.equal(device.hostname, "host.lan");
        assert.equal(device.vendor, "Vendor");
        assert.equal(device.detectedVia, "ping");
        assert.equal(device.isOnline, true);
        assert.equal(device.monitorId, null);
        assert.equal(device.firstSeen, device.lastSeen);
        assert.ok(device.firstSeen.startsWith("2026-10-07 10:00:00"), device.firstSeen);
    });

    test("updates existing devices without touching labels", async () => {
        await store.mergeScan({
            devices: [scanned("10.0.0.5")],
            scannedIPs: ["10.0.0.5"],
            complete: true,
            now: new Date("2026-10-07T10:00:00Z"),
        });
        const [first] = await store.listDevices();
        assert.equal(await store.updateLabel(first.id, "Kamera lobi"), true);

        const summary = await store.mergeScan({
            devices: [scanned("10.0.0.5", { mac: "AA:BB:CC:00:00:99" })],
            scannedIPs: ["10.0.0.5"],
            complete: true,
            now: new Date("2026-10-07T11:00:00Z"),
        });
        assert.equal(summary.found, 1);
        assert.equal(summary.new, 0);
        assert.equal(summary.unknown.length, 1, "another MAC address on a known IP is reported");

        const [second] = await store.listDevices();
        assert.equal(second.id, first.id);
        assert.equal(second.label, "Kamera lobi");
        assert.equal(second.mac, "AA:BB:CC:00:00:99");
        assert.equal(second.firstSeen, first.firstSeen);
        assert.ok(second.lastSeen.startsWith("2026-10-07 11:00:00"), second.lastSeen);
    });

    test("does not overwrite known fields with nulls", async () => {
        await store.mergeScan({ devices: [scanned("10.0.0.5")], scannedIPs: ["10.0.0.5"], complete: true });
        await store.mergeScan({
            devices: [scanned("10.0.0.5", { mac: null, hostname: null, vendor: null, detectedVia: "arp" })],
            scannedIPs: ["10.0.0.5"],
            complete: true,
        });
        const [device] = await store.listDevices();
        assert.equal(device.mac, "AA:BB:CC:00:00:01");
        assert.equal(device.hostname, "host.lan");
        assert.equal(device.vendor, "Vendor");
        assert.equal(device.detectedVia, "arp");
    });

    test("marks missing only inside the scanned range", async () => {
        await store.mergeScan({
            devices: [scanned("10.0.0.9"), scanned("10.0.1.9")],
            scannedIPs: ["10.0.0.9", "10.0.1.9"],
            complete: true,
        });
        const summary = await store.mergeScan({ devices: [], scannedIPs: ["10.0.0.9"], complete: true });
        assert.deepEqual(summary, { found: 0, new: 0, missing: 1 });

        const byIp = Object.fromEntries((await store.listDevices()).map((d) => [d.ip, d.isOnline]));
        assert.deepEqual(byIp, { "10.0.0.9": false, "10.0.1.9": true });

        const again = await store.mergeScan({ devices: [], scannedIPs: ["10.0.0.9"], complete: true });
        assert.equal(again.missing, 0, "an already missing device is not counted twice");
    });

    test("never marks missing on partial scans", async () => {
        await store.mergeScan({ devices: [scanned("10.0.0.9")], scannedIPs: ["10.0.0.9"], complete: true });
        const summary = await store.mergeScan({ devices: [], scannedIPs: ["10.0.0.9"], complete: false });
        assert.equal(summary.missing, 0);
        assert.equal((await store.listDevices())[0].isOnline, true);
    });

    test("lists devices sorted by IP numerically", async () => {
        await store.mergeScan({
            devices: [scanned("10.0.0.10"), scanned("10.0.0.2")],
            scannedIPs: ["10.0.0.10", "10.0.0.2"],
            complete: true,
        });
        assert.deepEqual(
            (await store.listDevices()).map((d) => d.ip),
            ["10.0.0.2", "10.0.0.10"]
        );
    });

    test("gets devices by ids", async () => {
        await store.mergeScan({
            devices: [scanned("10.0.0.1"), scanned("10.0.0.2")],
            scannedIPs: ["10.0.0.1", "10.0.0.2"],
            complete: true,
        });
        const [a, b] = await store.listDevices();
        assert.deepEqual(
            (await store.getDevicesByIds([b.id])).map((d) => d.ip),
            ["10.0.0.2"]
        );
        assert.deepEqual(await store.getDevicesByIds([]), []);
        assert.ok(a.id !== b.id);
    });

    test("deleting the monitor clears monitor_id", async () => {
        await store.mergeScan({ devices: [scanned("10.0.0.5")], scannedIPs: ["10.0.0.5"], complete: true });
        const [monitorId] = await knex("monitor").insert({});
        const [device] = await store.listDevices();
        await store.setMonitorId(device.id, monitorId);
        assert.equal((await store.listDevices())[0].monitorId, monitorId);

        await knex("monitor").where({ id: monitorId }).del();
        assert.equal((await store.listDevices())[0].monitorId, null);
    });

    test("updateLabel trims, clears and validates", async () => {
        await store.mergeScan({ devices: [scanned("10.0.0.5")], scannedIPs: ["10.0.0.5"], complete: true });
        const [device] = await store.listDevices();

        assert.equal(await store.updateLabel(device.id, "  Kamera lobi  "), true);
        assert.equal((await store.listDevices())[0].label, "Kamera lobi");

        assert.equal(await store.updateLabel(device.id, ""), true);
        assert.equal((await store.listDevices())[0].label, null);

        assert.equal(await store.updateLabel(9999, "x"), false);
        await assert.rejects(() => store.updateLabel(device.id, "a".repeat(256)), /Label terlalu panjang/);
    });

    test("deleteDevice reports whether something was deleted", async () => {
        await store.mergeScan({ devices: [scanned("10.0.0.5")], scannedIPs: ["10.0.0.5"], complete: true });
        const [device] = await store.listDevices();
        assert.equal(await store.deleteDevice(device.id), true);
        assert.equal(await store.deleteDevice(device.id), false);
        assert.deepEqual(await store.listDevices(), []);
    });
    describe("categories", () => {
        /**
         * @param {string} ip Address
         * @returns {Promise<object>} The stored device
         */
        async function seedDevice(ip = "10.0.0.5") {
            await store.mergeScan({ devices: [scanned(ip)], scannedIPs: [ip], complete: true });
            return (await store.listDevices()).find((d) => d.ip === ip);
        }

        test("adds categories and sub categories and lists them sorted by name", async () => {
            const b = await store.addCategory("Terminal 2");
            const a = await store.addCategory("gedung A");
            const sub2 = await store.addSubcategory(b.id, "Lantai 2");
            const sub1 = await store.addSubcategory(b.id, "Lantai 1");

            assert.deepEqual(await store.listCategories(), [
                { id: a.id, name: "gedung A", subcategories: [] },
                {
                    id: b.id,
                    name: "Terminal 2",
                    subcategories: [
                        { id: sub1.id, name: "Lantai 1" },
                        { id: sub2.id, name: "Lantai 2" },
                    ],
                },
            ]);
        });

        test("trims names and rejects empty, long and duplicate names", async () => {
            const category = await store.addCategory("  Terminal 2  ");
            assert.equal(category.name, "Terminal 2");
            await assert.rejects(() => store.addCategory("   "), /Nama tidak boleh kosong/);
            await assert.rejects(() => store.addCategory("a".repeat(101)), /Nama terlalu panjang/);
            await assert.rejects(() => store.addCategory("terminal 2"), /Nama sudah dipakai/);

            await store.addSubcategory(category.id, "CCTV");
            await assert.rejects(() => store.addSubcategory(category.id, "cctv"), /Nama sudah dipakai/);

            // The same sub category name may exist under another category.
            const other = await store.addCategory("Terminal 3");
            await store.addSubcategory(other.id, "CCTV");
        });

        test("a sub category needs an existing top level category", async () => {
            const category = await store.addCategory("Terminal 2");
            const sub = await store.addSubcategory(category.id, "CCTV");
            await assert.rejects(() => store.addSubcategory(9999, "x"), /Kategori tidak ditemukan/);
            await assert.rejects(() => store.addSubcategory(sub.id, "x"), /Kategori tidak ditemukan/);
        });

        test("renames a category or sub category", async () => {
            const category = await store.addCategory("Terminal 2");
            const other = await store.addCategory("Terminal 3");
            const sub = await store.addSubcategory(category.id, "CCTV");

            assert.equal(await store.renameCategory(category.id, "Terminal Dua"), true);
            assert.equal(await store.renameCategory(sub.id, "Kamera"), true);
            assert.equal(await store.renameCategory(9999, "x"), false);
            await assert.rejects(() => store.renameCategory(category.id, "terminal 3"), /Nama sudah dipakai/);
            // Keeping its own name (even in another case) is fine.
            assert.equal(await store.renameCategory(other.id, "TERMINAL 3"), true);

            const first = (await store.listCategories()).find((c) => c.id === category.id);
            assert.equal(first.name, "Terminal Dua");
            assert.equal(first.subcategories[0].name, "Kamera");
        });

        test("assigns a category and sub category to a device", async () => {
            const category = await store.addCategory("Terminal 2");
            const sub = await store.addSubcategory(category.id, "CCTV");
            const device = await seedDevice();
            assert.equal(device.categoryId, null);
            assert.equal(device.subcategoryId, null);

            assert.equal(await store.setDeviceCategory(device.id, category.id, sub.id), true);
            let [stored] = await store.listDevices();
            assert.equal(stored.categoryId, category.id);
            assert.equal(stored.subcategoryId, sub.id);

            // Only the category: the sub category is cleared.
            assert.equal(await store.setDeviceCategory(device.id, category.id, null), true);
            [stored] = await store.listDevices();
            assert.equal(stored.categoryId, category.id);
            assert.equal(stored.subcategoryId, null);

            assert.equal(await store.setDeviceCategory(device.id, null, null), true);
            [stored] = await store.listDevices();
            assert.equal(stored.categoryId, null);
            assert.equal(await store.setDeviceCategory(9999, null, null), false);
        });

        test("rejects a sub category that does not belong to the category", async () => {
            const a = await store.addCategory("A");
            const b = await store.addCategory("B");
            const subOfB = await store.addSubcategory(b.id, "CCTV");
            const device = await seedDevice();

            await assert.rejects(
                () => store.setDeviceCategory(device.id, a.id, subOfB.id),
                /Sub kategori tidak sesuai/
            );
            await assert.rejects(
                () => store.setDeviceCategory(device.id, null, subOfB.id),
                /Sub kategori tidak sesuai/
            );
            await assert.rejects(() => store.setDeviceCategory(device.id, 9999, null), /Kategori tidak ditemukan/);
            await assert.rejects(() => store.setDeviceCategory(device.id, "abc", null), /Kategori tidak ditemukan/);
            const [stored] = await store.listDevices();
            assert.equal(stored.categoryId, null);
        });

        test("deleting a sub category leaves the device in its category", async () => {
            const category = await store.addCategory("Terminal 2");
            const sub = await store.addSubcategory(category.id, "CCTV");
            const device = await seedDevice();
            await store.setDeviceCategory(device.id, category.id, sub.id);

            assert.equal(await store.deleteCategory(sub.id), true);
            const [stored] = await store.listDevices();
            assert.equal(stored.categoryId, category.id);
            assert.equal(stored.subcategoryId, null);
            assert.equal(await store.deleteCategory(sub.id), false);
        });

        test("deleting a category removes its sub categories and uncategorizes devices", async () => {
            const category = await store.addCategory("Terminal 2");
            const sub = await store.addSubcategory(category.id, "CCTV");
            const keep = await store.addCategory("Terminal 3");
            const device = await seedDevice();
            await store.setDeviceCategory(device.id, category.id, sub.id);

            assert.equal(await store.deleteCategory(category.id), true);
            assert.deepEqual(await store.listCategories(), [{ id: keep.id, name: "Terminal 3", subcategories: [] }]);
            const [stored] = await store.listDevices();
            assert.equal(stored.categoryId, null);
            assert.equal(stored.subcategoryId, null);
        });

        test("a new scan keeps the category of a known device", async () => {
            const category = await store.addCategory("Terminal 2");
            const device = await seedDevice();
            await store.setDeviceCategory(device.id, category.id, null);
            await store.mergeScan({ devices: [scanned("10.0.0.5")], scannedIPs: ["10.0.0.5"], complete: true });
            assert.equal((await store.listDevices())[0].categoryId, category.id);
        });

        describe("bulk category", () => {
            /**
             * @param {string[]} ips Addresses
             * @returns {Promise<object[]>} The stored devices, in the order of the addresses
             */
            async function seedMany(ips) {
                await store.mergeScan({ devices: ips.map((ip) => scanned(ip)), scannedIPs: ips, complete: true });
                const all = await store.listDevices();
                return ips.map((ip) => all.find((d) => d.ip === ip));
            }

            test("setDevicesCategory puts all the devices in the category and sub category", async () => {
                const category = await store.addCategory("Terminal 2");
                const sub = await store.addSubcategory(category.id, "CCTV");
                const [a, b, c] = await seedMany(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);

                assert.equal(await store.setDevicesCategory([a.id, b.id, c.id], category.id, sub.id), 3);
                for (const d of await store.listDevices()) {
                    assert.equal(d.categoryId, category.id);
                    assert.equal(d.subcategoryId, sub.id);
                }

                assert.equal(await store.setDevicesCategory([a.id, b.id], null, null), 2);
                const after = await store.listDevices();
                assert.equal(after.find((d) => d.id === a.id).categoryId, null);
                assert.equal(after.find((d) => d.id === c.id).categoryId, category.id);
            });

            test("setDevicesCategory skips ids that do not exist and does not count them", async () => {
                const category = await store.addCategory("Terminal 2");
                const [a] = await seedMany(["10.0.0.1"]);
                assert.equal(await store.setDevicesCategory([a.id, 9999], category.id, null), 1);
            });

            test("setDevicesCategory refuses a wrong pair and changes nothing", async () => {
                const a = await store.addCategory("A");
                const b = await store.addCategory("B");
                const subOfB = await store.addSubcategory(b.id, "CCTV");
                const [d] = await seedMany(["10.0.0.1"]);

                await assert.rejects(
                    () => store.setDevicesCategory([d.id], a.id, subOfB.id),
                    /Sub kategori tidak sesuai/
                );
                await assert.rejects(() => store.setDevicesCategory([d.id], 9999, null), /Kategori tidak ditemukan/);
                assert.equal((await store.listDevices())[0].categoryId, null);
            });

            test("setDevicesCategory refuses a list of ids that is not 1 to 2000 different whole numbers", async () => {
                const category = await store.addCategory("A");
                const tooMany = Array.from({ length: 2001 }, (_, i) => i + 1);
                for (const bad of [[], [1, 1], [1.5], ["1"], undefined, null, tooMany]) {
                    await assert.rejects(
                        () => store.setDevicesCategory(bad, category.id, null),
                        /Pilih 1 sampai 2000 perangkat/
                    );
                }
                // The id check comes before the category check
                await assert.rejects(() => store.setDevicesCategory([], 9999, null), /Pilih 1 sampai 2000 perangkat/);
            });

            test("setDevicesCategory gives a clear message when the category is deleted just before it writes", async () => {
                const category = await store.addCategory("Hilang");
                const [d] = await seedMany(["10.0.0.1"]);

                // Another screen deletes the category right before the bulk change opens its transaction
                const begin = R.begin;
                R.begin = async (...args) => {
                    R.begin = begin;
                    await store.deleteCategory(category.id);
                    return begin.apply(R, args);
                };
                try {
                    await assert.rejects(
                        () => store.setDevicesCategory([d.id], category.id, null),
                        /Kategori tidak ditemukan/
                    );
                } finally {
                    R.begin = begin;
                }
                assert.equal((await store.listDevices())[0].categoryId, null);
            });

            test("setDevicesCategory handles more devices than one chunk of 500", async () => {
                const category = await store.addCategory("Besar");
                const ips = [];
                for (let i = 0; i < 1200; i++) {
                    ips.push(`10.1.${Math.floor(i / 250)}.${(i % 250) + 1}`);
                }
                const devices = await seedMany(ips);
                assert.equal(
                    await store.setDevicesCategory(
                        devices.map((d) => d.id),
                        category.id,
                        null
                    ),
                    1200
                );
                assert.ok((await store.listDevices()).every((d) => d.categoryId === category.id));
            });
        });
    });

    describe("parseDeviceIds", () => {
        test("no value means no filter", () => {
            assert.equal(store.parseDeviceIds(undefined), null);
        });

        test("an array becomes a set, an empty array means no devices", () => {
            assert.deepEqual(store.parseDeviceIds([]), new Set());
            assert.deepEqual(store.parseDeviceIds([3, 1]), new Set([1, 3]));
            assert.equal(store.parseDeviceIds(Array.from({ length: 5000 }, (_, i) => i)).size, 5000);
        });

        test("anything else is refused", () => {
            const tooMany = Array.from({ length: 5001 }, (_, i) => i);
            for (const bad of [null, "1", {}, 5, [1, 1], [1.5], ["1"], [null], tooMany]) {
                assert.throws(() => store.parseDeviceIds(bad), /Daftar perangkat tidak valid/);
            }
        });
    });
});
