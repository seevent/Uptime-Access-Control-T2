const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { R } = require("redbean-node");
// better-auth must load before database (as in server.js): the two modules import each other.
require("../../server/better-auth");
const Database = require("../../server/database");
const { Settings } = require("../../server/settings");
const store = require("../../server/network-device-store");
const sync = require("../../server/network-category-sync");

const USER_ID = "test-user-1";
const NOW = new Date("2026-10-09T10:00:00Z");

describe("network categories <-> group monitors", () => {
    let dataDir;
    let started;
    let running;
    let deps;

    before(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-category-sync-test-"));
        Database.initDataDir({ "data-dir": dataDir + path.sep });
        Database.writeDBConfig({ type: "sqlite" });
        await Database.connect(true);
        await Database.patch();
        await R.exec(
            "INSERT INTO better_auth_user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Tester', 'tester@example.com', 1, '2026-10-07 10:00:00', '2026-10-07 10:00:00')",
            [USER_ID]
        );
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await Database.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        await R.exec("DELETE FROM network_device");
        await R.exec("DELETE FROM network_category");
        await R.exec("DELETE FROM monitor");
        await R.exec("DELETE FROM setting WHERE `key` = 'networkCategoryGroupsLinked'");
        started = [];
        running = {};
        deps = { startMonitor: async (userID, id) => started.push([userID, id]), runningMonitors: running };
    });

    /**
     * Sync as a logged in user would.
     * @param {"all"|number[]|null} place Devices whose category wins
     * @returns {Promise<object>} Result
     */
    const run = (place = null) => sync.syncCategories({ place, userID: USER_ID, deps });

    /**
     * Insert a monitor the way the dashboard would.
     * @param {string} name Name
     * @param {object} fields Other columns (type defaults to group)
     * @returns {Promise<number>} Monitor id
     */
    async function monitor(name, fields = {}) {
        const row = { type: "group", parent: null, hostname: null, ...fields };
        const [id] = await R.knex("monitor").insert({
            name,
            type: row.type,
            parent: row.parent,
            hostname: row.hostname,
            interval: 60,
            retry_interval: 60,
            user_id: USER_ID,
            active: 1,
        });
        return id;
    }

    /**
     * Add devices to the inventory.
     * @param {string[]} ips Addresses
     * @returns {Promise<object[]>} Devices in IP order
     */
    async function devices(ips) {
        await store.mergeScan({
            devices: ips.map((ip) => ({ ip, mac: null, hostname: null, vendor: null, detectedVia: "ping" })),
            scannedIPs: ips,
            complete: true,
            now: NOW,
        });
        return store.listDevices();
    }

    /**
     * Give a device a ping monitor.
     * @param {object} device Device
     * @param {number|null} parent Parent group
     * @returns {Promise<number>} Monitor id
     */
    async function monitorFor(device, parent = null) {
        const id = await monitor(device.ip, { type: "ping", hostname: device.ip, parent });
        await store.setMonitorId(device.id, id);
        return id;
    }

    const categories = () => R.getAll("SELECT id, name, parent_id, group_monitor_id FROM network_category ORDER BY id");
    const groupOf = async (categoryId) =>
        R.getRow("SELECT m.* FROM monitor m JOIN network_category c ON c.group_monitor_id = m.id WHERE c.id = ?", [
            categoryId,
        ]);
    const parentOf = async (monitorId) =>
        (await R.getRow("SELECT parent FROM monitor WHERE id = ?", [monitorId])).parent;
    const device = async (id) => (await store.listDevices()).find((d) => d.id === id);

    describe("from the Network Scan page to the dashboard", () => {
        test("a new category and sub category get group monitors, the sub group inside the category group", async () => {
            const cat = await store.addCategory("Terminal 2");
            const sub = await store.addSubcategory(cat.id, "CCTV");
            const result = await run();

            const catGroup = await groupOf(cat.id);
            const subGroup = await groupOf(sub.id);
            assert.equal(catGroup.type, "group");
            assert.equal(catGroup.name, "Terminal 2");
            assert.equal(catGroup.parent, null);
            assert.equal(catGroup.user_id, USER_ID);
            assert.equal(subGroup.name, "CCTV");
            assert.equal(subGroup.parent, catGroup.id);
            assert.deepEqual(result.monitorsCreated, [catGroup.id, subGroup.id]);
            assert.deepEqual(started, [
                [USER_ID, catGroup.id],
                [USER_ID, subGroup.id],
            ]);
            assert.equal(result.categoriesChanged, true);

            // Nothing left to do the second time
            const again = await run();
            assert.deepEqual(again.monitorsCreated, []);
            assert.equal(again.categoriesChanged, false);
        });

        test("without a user no group is made (and nothing is deleted)", async () => {
            await store.addCategory("Terminal 2");
            const result = await sync.syncCategories({ place: null, userID: null, deps });
            assert.deepEqual(result.monitorsCreated, []);
            assert.equal((await categories()).length, 1);
        });

        test("renaming a category renames its group", async () => {
            const cat = await store.addCategory("Terminal 2");
            await run();
            const group = await groupOf(cat.id);
            running[group.id] = { name: "Terminal 2" };

            const renamed = await sync.renameCategory(cat.id, "T2 Keberangkatan", deps);
            assert.deepEqual(renamed, { monitorsUpdated: [group.id] });
            assert.equal((await groupOf(cat.id)).name, "T2 Keberangkatan");
            assert.equal(running[group.id].name, "T2 Keberangkatan");
            assert.equal(await sync.renameCategory(9999, "x", deps), false);
            await assert.rejects(() => sync.renameCategory(cat.id, "", deps), /kosong/);
        });

        test("giving a device a category moves its monitor into the group, clearing it moves the monitor out", async () => {
            const [a] = await devices(["10.0.0.1"]);
            const cat = await store.addCategory("Terminal 2");
            const sub = await store.addSubcategory(cat.id, "CCTV");
            await run();
            const m = await monitorFor(a);

            await store.setDeviceCategory(a.id, cat.id, sub.id);
            const result = await run([a.id]);
            assert.equal(await parentOf(m), (await groupOf(sub.id)).id);
            assert.deepEqual(result.monitorsUpdated, [m]);

            await store.setDeviceCategory(a.id, cat.id, null);
            await run([a.id]);
            assert.equal(await parentOf(m), (await groupOf(cat.id)).id);

            await store.setDeviceCategory(a.id, null, null);
            await run([a.id]);
            assert.equal(await parentOf(m), null);
            assert.equal((await device(a.id)).categoryId, null);
        });

        test("a monitor already deeper inside its category (a group of the user) is left there", async () => {
            const [a] = await devices(["10.0.0.1"]);
            const cat = await store.addCategory("Terminal 2");
            const sub = await store.addSubcategory(cat.id, "CCTV");
            await run();
            const deep = await monitor("Lantai 3", { parent: (await groupOf(sub.id)).id });
            const m = await monitorFor(a, deep);
            await store.setDeviceCategory(a.id, cat.id, sub.id);

            await run([a.id]);
            assert.equal(await parentOf(m), deep);
        });

        test("deleting a sub category moves its monitors into the category group and deletes the sub group", async () => {
            const [a] = await devices(["10.0.0.1"]);
            const cat = await store.addCategory("Terminal 2");
            const sub = await store.addSubcategory(cat.id, "CCTV");
            await run();
            const catGroup = (await groupOf(cat.id)).id;
            const subGroup = (await groupOf(sub.id)).id;
            const m = await monitorFor(a, subGroup);
            const http = await monitor("Web NVR", { type: "http", parent: subGroup });
            await store.setDeviceCategory(a.id, cat.id, sub.id);
            let stopped = 0;
            running[subGroup] = { stop: async () => stopped++ };

            const out = await sync.deleteCategory(sub.id, deps);
            assert.equal(out.deleted, true);
            assert.deepEqual(out.monitorsDeleted, [subGroup]);
            assert.deepEqual(out.monitorsUpdated.sort(), [m, http].sort());
            assert.equal(stopped, 1);
            assert.equal(running[subGroup], undefined);
            assert.equal(await parentOf(m), catGroup);
            assert.equal(await parentOf(http), catGroup);
            assert.ok(!(await R.getRow("SELECT id FROM monitor WHERE id = ?", [subGroup])));

            await run();
            const d = await device(a.id);
            assert.equal(d.categoryId, cat.id);
            assert.equal(d.subcategoryId, null);
        });

        test("deleting a category moves every monitor in it to the top level and deletes all its groups", async () => {
            const [a, b] = await devices(["10.0.0.1", "10.0.0.2"]);
            const cat = await store.addCategory("Terminal 2");
            const sub = await store.addSubcategory(cat.id, "CCTV");
            await run();
            const catGroup = (await groupOf(cat.id)).id;
            const subGroup = (await groupOf(sub.id)).id;
            const ma = await monitorFor(a, catGroup);
            const mb = await monitorFor(b, subGroup);

            const out = await sync.deleteCategory(cat.id, deps);
            assert.deepEqual(out.monitorsDeleted, [subGroup, catGroup]);
            assert.equal(await parentOf(ma), null);
            assert.equal(await parentOf(mb), null);
            assert.equal((await categories()).length, 0);
            assert.equal((await R.getAll("SELECT id FROM monitor WHERE type = 'group'")).length, 0);
            assert.deepEqual(await sync.deleteCategory(cat.id, deps), {
                deleted: false,
                monitorsUpdated: [],
                monitorsDeleted: [],
            });
        });
    });

    describe("from the dashboard to the Network Scan page", () => {
        test("groups on the first two levels become categories, deeper groups do not", async () => {
            const top = await monitor("Terminal 3");
            const mid = await monitor("Kedatangan", { parent: top });
            await monitor("Lantai 1", { parent: mid });
            await run();

            const rows = await categories();
            assert.deepEqual(
                rows.map((r) => [r.name, r.parent_id === null ? null : rows.find((p) => p.id === r.parent_id).name]),
                [
                    ["Terminal 3", null],
                    ["Kedatangan", "Terminal 3"],
                ]
            );
            assert.deepEqual(started, []);
        });

        test("a renamed group renames its category; a clash among siblings gets a number on both sides", async () => {
            const first = await monitor("CCTV");
            const second = await monitor("cctv");
            await run();
            const names = (await categories()).map((r) => r.name);
            assert.deepEqual(names, ["CCTV", "cctv (2)"]);
            assert.equal((await R.getRow("SELECT name FROM monitor WHERE id = ?", [second])).name, "cctv (2)");

            await R.exec("UPDATE monitor SET name = 'Kamera' WHERE id = ?", [first]);
            const result = await run();
            assert.deepEqual(
                (await categories()).map((r) => r.name),
                ["Kamera", "cctv (2)"]
            );
            assert.equal(result.categoriesChanged, true);
        });

        test("a device monitor dragged into a group takes the category of that group", async () => {
            const [a] = await devices(["10.0.0.1"]);
            const top = await monitor("Terminal 2");
            const mid = await monitor("CCTV", { parent: top });
            const deep = await monitor("Lantai 3", { parent: mid });
            const m = await monitorFor(a);
            await run();
            const [cat, sub] = await categories();

            await R.exec("UPDATE monitor SET parent = ? WHERE id = ?", [deep, m]);
            let result = await run();
            assert.equal(result.devicesChanged, true);
            let d = await device(a.id);
            assert.deepEqual([d.categoryId, d.subcategoryId], [cat.id, sub.id]);

            await R.exec("UPDATE monitor SET parent = ? WHERE id = ?", [top, m]);
            await run();
            d = await device(a.id);
            assert.deepEqual([d.categoryId, d.subcategoryId], [cat.id, null]);

            await R.exec("UPDATE monitor SET parent = NULL WHERE id = ?", [m]);
            result = await run();
            d = await device(a.id);
            assert.deepEqual([d.categoryId, d.subcategoryId], [null, null]);
            assert.deepEqual(result.monitorsUpdated, []);
        });

        test("a device without a monitor keeps its category", async () => {
            const [a] = await devices(["10.0.0.1"]);
            await monitor("Terminal 2");
            await run();
            const [cat] = await categories();
            await store.setDeviceCategory(a.id, cat.id, null);
            await run();
            assert.equal((await device(a.id)).categoryId, cat.id);
        });

        test("a deleted group deletes its category; a sub group that survives becomes a category", async () => {
            const [a, b] = await devices(["10.0.0.1", "10.0.0.2"]);
            const top = await monitor("Terminal 2");
            await monitor("CCTV", { parent: top });
            await run();
            const [cat, sub] = await categories();
            await store.setDeviceCategory(a.id, cat.id, null);
            await store.setDeviceCategory(b.id, cat.id, sub.id);

            // What Kuma does for "delete group, keep children": children to the top, then the group goes.
            await R.exec("UPDATE monitor SET parent = NULL WHERE parent = ?", [top]);
            await R.exec("DELETE FROM monitor WHERE id = ?", [top]);
            const result = await run();
            assert.equal(result.categoriesChanged, true);

            const rows = await categories();
            assert.deepEqual(
                rows.map((r) => [r.id, r.name, r.parent_id]),
                [[sub.id, "CCTV", null]]
            );
            assert.equal((await device(a.id)).categoryId, null);
            const db = await device(b.id);
            assert.deepEqual([db.categoryId, db.subcategoryId], [sub.id, null]);
        });

        test("a group that becomes another monitor type deletes its category", async () => {
            const top = await monitor("Terminal 2");
            await run();
            await R.exec("UPDATE monitor SET type = 'http' WHERE id = ?", [top]);
            await run();
            assert.equal((await categories()).length, 0);
        });

        test("a category group moved into another category becomes its sub category; its own subs drop out", async () => {
            const [a] = await devices(["10.0.0.1"]);
            const t2 = await monitor("Terminal 2");
            const t3 = await monitor("Terminal 3");
            const cctv = await monitor("CCTV", { parent: t3 });
            const m = await monitorFor(a, cctv);
            await run();
            const t3cat = (await categories()).find((r) => r.name === "Terminal 3");

            await R.exec("UPDATE monitor SET parent = ? WHERE id = ?", [t2, t3]);
            await run();
            const rows = await categories();
            const t2cat = rows.find((r) => r.name === "Terminal 2");
            assert.deepEqual(rows.map((r) => r.name).sort(), ["Terminal 2", "Terminal 3"]);
            assert.equal(rows.find((r) => r.name === "Terminal 3").parent_id, t2cat.id);
            // The monitor sits three levels deep now: the nearest category above it counts
            const d = await device(a.id);
            assert.deepEqual([d.categoryId, d.subcategoryId], [t2cat.id, t3cat.id]);
            assert.equal(await parentOf(m), cctv);
        });

        test("monitors that belong to no device are never moved", async () => {
            const top = await monitor("Terminal 2");
            const http = await monitor("Web NVR", { type: "http" });
            await run("all");
            assert.equal(await parentOf(http), null);
            assert.equal(await parentOf(top), null);
        });
    });

    describe("first start after the update", () => {
        test("existing categories get groups and the device monitors move into them", async () => {
            const [a, b, c] = await devices(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
            const cat = await store.addCategory("Terminal 2");
            const sub = await store.addSubcategory(cat.id, "CCTV");
            await store.setDeviceCategory(a.id, cat.id, null);
            await store.setDeviceCategory(b.id, cat.id, sub.id);
            // An older group chosen as "parent group" when adding devices
            const old = await monitor("Gedung lama");
            const ma = await monitorFor(a, old);
            const mb = await monitorFor(b);
            const mc = await monitorFor(c, old);

            await sync.syncAtBoot();

            const catGroup = (await groupOf(cat.id)).id;
            const subGroup = (await groupOf(sub.id)).id;
            assert.equal(await parentOf(ma), catGroup);
            assert.equal(await parentOf(mb), subGroup);
            // A device without a category takes the category of the group it already was in
            assert.equal(await parentOf(mc), old);
            const oldCat = (await categories()).find((r) => r.name === "Gedung lama");
            assert.equal((await device(c.id)).categoryId, oldCat.id);
            assert.equal(await Settings.get("networkCategoryGroupsLinked"), true);

            // Later starts: the dashboard wins
            await R.exec("UPDATE monitor SET parent = NULL WHERE id = ?", [ma]);
            await sync.syncAtBoot();
            assert.equal(await parentOf(ma), null);
            assert.equal((await device(a.id)).categoryId, null);
        });
    });

    test("uniqueName adds a number until the name is free and keeps the length limit", () => {
        assert.equal(sync.uniqueName("CCTV", new Set()), "CCTV");
        assert.equal(sync.uniqueName("CCTV", new Set(["cctv"])), "CCTV (2)");
        assert.equal(sync.uniqueName("CCTV", new Set(["cctv", "cctv (2)"])), "CCTV (3)");
        assert.equal(sync.uniqueName("  ", new Set()), "Grup");
        const long = "x".repeat(100);
        const renamed = sync.uniqueName(long, new Set([long]));
        assert.equal(renamed.length, 100);
        assert.ok(renamed.endsWith(" (2)"));
    });
});
