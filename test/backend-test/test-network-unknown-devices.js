const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const knexFactory = require("knex");
const { R } = require("redbean-node");
const migration = require("../../db/knex_migrations/2026-10-06-0000-add-network-device");
const categoryMigration = require("../../db/knex_migrations/2026-10-08-0000-add-network-device-category");
const acknowledgedMigration = require("../../db/knex_migrations/2026-10-10-0000-add-network-device-acknowledged");
const store = require("../../server/network-device-store");
const runner = require("../../server/network-scan-runner");
const schedule = require("../../server/network-scan-schedule");
const { alertUnknownDevices, buildMessage } = require("../../server/network-unknown-alert");

/**
 * @param {string} ip Address
 * @param {object} extra Fields that replace the defaults
 * @returns {object} A scanned device
 */
function scanned(ip, extra = {}) {
    return { ip, mac: "AA:BB:CC:00:00:01", hostname: null, vendor: "Vendor", detectedVia: "ping", ...extra };
}

/**
 * @param {object[]} devices Devices a scan finds
 * @returns {Promise<object>} Summary of the merge
 */
async function scan(devices) {
    return await store.mergeScan({ devices, scannedIPs: devices.map((d) => d.ip), complete: true });
}

describe("unknown devices", () => {
    let knex;

    before(async () => {
        knex = knexFactory({
            client: "better-sqlite3",
            connection: { filename: ":memory:" },
            useNullAsDefault: true,
            pool: { min: 1, max: 1 },
        });
        await knex.schema.createTable("monitor", (table) => table.increments("id"));
        await knex.schema.createTable("notification", (table) => {
            table.increments("id");
            table.string("name");
            table.boolean("active").notNullable().defaultTo(true);
            table.text("config");
        });
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
        await knex("notification").del();
    });

    test("the first scan of an empty inventory is the baseline", async () => {
        const summary = await scan([scanned("10.0.0.1"), scanned("10.0.0.2", { mac: "AA:BB:CC:00:00:02" })]);
        assert.equal(summary.new, 2);
        assert.equal(summary.unknown, undefined);
        assert.ok((await store.listDevices()).every((d) => d.acknowledged && d.alertNote === null));
    });

    test("a new device after the baseline is unknown and reported once", async () => {
        await scan([scanned("10.0.0.1")]);
        const summary = await scan([scanned("10.0.0.1"), scanned("10.0.0.9", { mac: "AA:BB:CC:00:00:09" })]);
        assert.equal(summary.unknown.length, 1);
        assert.deepEqual(
            { ip: summary.unknown[0].ip, reason: summary.unknown[0].reason },
            { ip: "10.0.0.9", reason: "new" }
        );
        const byIp = Object.fromEntries((await store.listDevices()).map((d) => [d.ip, d]));
        assert.equal(byIp["10.0.0.9"].acknowledged, false);
        assert.equal(byIp["10.0.0.9"].alertNote, "Perangkat baru");
        assert.equal(byIp["10.0.0.1"].acknowledged, true);

        const again = await scan([scanned("10.0.0.1"), scanned("10.0.0.9", { mac: "AA:BB:CC:00:00:09" })]);
        assert.equal(again.unknown, undefined, "the same device is not reported again");
        assert.equal((await store.listDevices()).find((d) => d.ip === "10.0.0.9").acknowledged, false);
    });

    test("another MAC address on a known IP makes the device unknown again", async () => {
        await scan([scanned("10.0.0.1")]);
        const summary = await scan([scanned("10.0.0.1", { mac: "aa:bb:cc:00:00:77" })]);
        assert.equal(summary.unknown[0].reason, "mac");
        assert.match(summary.unknown[0].note, /AA:BB:CC:00:00:01 → aa:bb:cc:00:00:77/);
        const [device] = await store.listDevices();
        assert.equal(device.acknowledged, false);
        assert.equal(device.mac, "aa:bb:cc:00:00:77");
    });

    test("the same MAC in another letter case, or no MAC at all, is no change", async () => {
        await scan([scanned("10.0.0.1")]);
        assert.equal((await scan([scanned("10.0.0.1", { mac: "aa:bb:cc:00:00:01" })])).unknown, undefined);
        assert.equal((await scan([scanned("10.0.0.1", { mac: null })])).unknown, undefined);
    });

    test("acknowledging clears the mark; label, category and monitor do it too", async () => {
        await scan([scanned("10.0.0.1")]);
        await scan([
            scanned("10.0.0.1"),
            scanned("10.0.0.2", { mac: "AA:BB:CC:00:00:02" }),
            scanned("10.0.0.3", { mac: "AA:BB:CC:00:00:03" }),
            scanned("10.0.0.4", { mac: "AA:BB:CC:00:00:04" }),
            scanned("10.0.0.5", { mac: "AA:BB:CC:00:00:05" }),
        ]);
        const byIp = async () => Object.fromEntries((await store.listDevices()).map((d) => [d.ip, d]));
        let devices = await byIp();
        assert.equal(Object.values(devices).filter((d) => !d.acknowledged).length, 4);

        await store.updateLabel(devices["10.0.0.2"].id, "Kamera");
        await knex("monitor").insert({ id: 1 });
        await store.setMonitorId(devices["10.0.0.3"].id, 1);
        assert.equal(await store.acknowledgeDevices([devices["10.0.0.4"].id, devices["10.0.0.1"].id]), 1);

        devices = await byIp();
        assert.deepEqual(
            Object.values(devices).map((d) => d.acknowledged),
            [true, true, true, true, false]
        );
        assert.equal(devices["10.0.0.2"].alertNote, null);

        assert.equal(await store.acknowledgeDevices("all"), 1);
        assert.ok((await store.listDevices()).every((d) => d.acknowledged));
        assert.equal(await store.acknowledgeDevices("all"), 0);
    });

    test("acknowledgeDevices refuses bad ids", async () => {
        for (const bad of [undefined, [], [1, 1], ["1"], new Array(2001).fill(0).map((_, i) => i)]) {
            await assert.rejects(() => store.acknowledgeDevices(bad), /Pilih 1 sampai 2000 perangkat/);
        }
    });

    test("devices that exist before the migration count as known", async () => {
        await knex("network_device").insert({
            ip: "10.1.1.1",
            detected_via: "ping",
            first_seen: "2026-10-07 10:00:00",
            last_seen: "2026-10-07 10:00:00",
        });
        assert.equal((await store.listDevices())[0].acknowledged, true);
    });

    describe("alert", () => {
        test("message lists the devices and cuts a long list", () => {
            const one = buildMessage([
                { ip: "10.0.0.9", mac: "AA:BB", vendor: "Hik", hostname: null, note: "Perangkat baru" },
            ]);
            assert.match(one, /1 perangkat asing/);
            assert.match(one, /• 10\.0\.0\.9 · AA:BB · Hik — Perangkat baru/);
            const many = buildMessage(Array.from({ length: 13 }, (_, i) => ({ ip: `10.0.0.${i}` })));
            assert.match(many, /13 perangkat asing/);
            assert.match(many, /… dan 3 lainnya/);
        });

        test("goes to the chosen active notifications, a failing one does not block the others", async () => {
            await knex("notification").insert([
                { id: 1, name: "A", active: 1, config: JSON.stringify({ type: "a" }) },
                { id: 2, name: "B", active: 1, config: JSON.stringify({ type: "b" }) },
                { id: 3, name: "Off", active: 0, config: JSON.stringify({ type: "c" }) },
                { id: 4, name: "Other", active: 1, config: JSON.stringify({ type: "d" }) },
            ]);
            const sent = [];
            const send = async (config, msg) => {
                if (config.type === "a") {
                    throw new Error("down");
                }
                sent.push([config.type, msg]);
            };
            const result = await alertUnknownDevices([{ ip: "10.0.0.9" }], [1, 2, 3], { send });
            assert.deepEqual(result, { sent: 1, failed: 1 });
            assert.equal(sent[0][0], "b");
            assert.match(sent[0][1], /10\.0\.0\.9/);
        });

        test("nothing to send, or nobody chosen, sends nothing", async () => {
            const send = async () => assert.fail("must not send");
            assert.deepEqual(await alertUnknownDevices([], [1], { send }), { sent: 0, failed: 0 });
            assert.deepEqual(await alertUnknownDevices([{ ip: "1.1.1.1" }], [], { send }), { sent: 0, failed: 0 });
        });
    });
});

describe("scan schedule", () => {
    const scanner = {
        expandRanges: (ranges) => {
            if (ranges.includes("bad")) {
                throw new Error("Rentang tidak valid");
            }
            return ranges.flatMap((r) => (r === "10.0.0.0/30" ? ["10.0.0.1", "10.0.0.2"] : [r]));
        },
    };

    test("normalizes a valid schedule", () => {
        assert.deepEqual(
            schedule.normalizeSchedule(
                { enabled: true, intervalMinutes: 30, ranges: [" 10.0.0.0/30 ", ""], notificationIDList: [2, 2, 3] },
                scanner
            ),
            { enabled: true, intervalMinutes: 30, ranges: ["10.0.0.0/30"], notificationIDList: [2, 3] }
        );
    });

    test("refuses wrong values", () => {
        const base = { enabled: true, intervalMinutes: 60, ranges: ["10.0.0.0/30"], notificationIDList: [] };
        assert.throws(() => schedule.normalizeSchedule(null, scanner), /tidak valid/);
        assert.throws(() => schedule.normalizeSchedule({ ...base, intervalMinutes: 4 }, scanner), /Jeda scan/);
        assert.throws(() => schedule.normalizeSchedule({ ...base, intervalMinutes: 1441 }, scanner), /Jeda scan/);
        assert.throws(() => schedule.normalizeSchedule({ ...base, intervalMinutes: 1.5 }, scanner), /Jeda scan/);
        assert.throws(() => schedule.normalizeSchedule({ ...base, ranges: [] }, scanner), /minimal satu rentang/);
        assert.throws(() => schedule.normalizeSchedule({ ...base, ranges: ["bad"] }, scanner), /Rentang tidak valid/);
        assert.throws(
            () => schedule.normalizeSchedule({ ...base, ranges: new Array(21).fill("10.0.0.1") }, scanner),
            /Maksimal 20/
        );
        assert.throws(
            () => schedule.normalizeSchedule({ ...base, notificationIDList: ["1"] }, scanner),
            /notifikasi tidak valid/
        );
        // A switched off schedule may have no ranges yet
        assert.equal(schedule.normalizeSchedule({ ...base, enabled: false, ranges: [] }, scanner).enabled, false);
    });
});

describe("scan runner", () => {
    test("reports the unknown devices after the scan finished, and not when nothing is unknown", async () => {
        const events = [];
        const alerts = [];
        const fakeScanner = {
            scan: async () => ({ devices: [scanned("10.0.0.1")], completed: true, arpAvailable: true }),
        };
        const fakeStore = {
            mergeScan: async () => ({ found: 1, new: 1, missing: 0, unknown: [{ ip: "10.0.0.1", reason: "new" }] }),
            listDevices: async () => [],
        };
        runner.startScan({
            ips: ["10.0.0.1"],
            scanner: fakeScanner,
            store: fakeStore,
            scheduled: true,
            emit: (event, data) => events.push([event, data]),
            onUnknown: async (unknown) => alerts.push(unknown),
        });
        for (let i = 0; i < 50 && alerts.length === 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(alerts.length, 1);
        const names = events.map((e) => e[0]);
        assert.deepEqual(
            names.filter((n) => n !== "networkScanProgress"),
            ["networkScanDone", "networkDeviceList"]
        );
        assert.equal(events.find((e) => e[0] === "networkScanDone")[1].scheduled, true);
        assert.equal(runner.isRunning(), false);
    });

    test("a failing alert does not break the scan", async () => {
        const events = [];
        runner.startScan({
            ips: ["10.0.0.1"],
            scanner: { scan: async () => ({ devices: [], completed: true, arpAvailable: true }) },
            store: {
                mergeScan: async () => ({ found: 0, new: 0, missing: 0, unknown: [{ ip: "x" }] }),
                listDevices: async () => [],
            },
            emit: (event) => events.push(event),
            onUnknown: async () => {
                throw new Error("boom");
            },
        });
        for (let i = 0; i < 50 && !events.includes("networkDeviceList"); i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(runner.isRunning(), false);
        assert.equal(runner.cancel(1), false, "nothing runs anymore");
    });
});

describe("scheduler tick", () => {
    const { Settings } = require("../../server/settings");
    let knex;
    const emitted = [];
    const server = {
        io: {
            to: (room) => ({ emit: (event, data) => emitted.push({ room, event, data }) }),
        },
    };
    const scanner = {
        expandRanges: (ranges) => ranges.map((r) => r),
        scan: async () => ({ devices: [], completed: true, arpAvailable: true }),
    };
    let scans = 0;
    const store = {
        mergeScan: async () => {
            scans++;
            return { found: 0, new: 0, missing: 0 };
        },
        listDevices: async () => [],
    };
    const alert = async () => {};

    /**
     * @returns {Promise<void>} Resolves when no scan runs anymore
     */
    async function idle() {
        for (let i = 0; i < 100 && runner.isRunning(); i++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    before(async () => {
        knex = knexFactory({
            client: "better-sqlite3",
            connection: { filename: ":memory:" },
            useNullAsDefault: true,
            pool: { min: 1, max: 1 },
        });
        await knex.schema.createTable("setting", (table) => {
            table.increments("id");
            table.string("key", 200).notNullable().unique();
            table.text("value");
            table.string("type", 20);
        });
        await knex.schema.createTable("better_auth_user", (table) => table.string("id").primary());
        await knex("better_auth_user").insert([{ id: "u1" }, { id: "u2" }]);
        R.setup(knex);
    });

    after(async () => {
        schedule.stopScheduler();
        Settings.stopCacheCleaner();
        await knex.destroy();
    });

    test("does nothing while the schedule is off", async () => {
        schedule.stopScheduler();
        assert.equal(await schedule.tick({ server, scanner, store, alert }), false);
        assert.equal(scans, 0);
    });

    test("scans when due, then waits for the interval, and tells every user", async () => {
        await schedule.saveSchedule(
            { enabled: true, intervalMinutes: 10, ranges: ["10.0.0.1"], notificationIDList: [] },
            scanner
        );
        let clock = 1_000_000;
        const now = () => clock;
        assert.equal(await schedule.tick({ server, scanner, store, alert, now }), true);
        await idle();
        assert.equal(scans, 1);
        const done = emitted.filter((e) => e.event === "networkScanDone");
        assert.deepEqual(done.map((e) => e.room).sort(), ["u1", "u2"]);
        assert.equal(done[0].data.scheduled, true);

        clock += 9 * 60 * 1000;
        assert.equal(await schedule.tick({ server, scanner, store, alert, now }), false, "not due yet");
        clock += 61 * 1000;
        assert.equal(await schedule.tick({ server, scanner, store, alert, now }), true);
        await idle();
        assert.equal(scans, 2);
    });

    test("saving the schedule makes the next check scan right away", async () => {
        let clock = 5_000_000;
        const now = () => clock;
        await schedule.saveSchedule(
            { enabled: true, intervalMinutes: 60, ranges: ["10.0.0.1"], notificationIDList: [] },
            scanner
        );
        assert.equal(await schedule.tick({ server, scanner, store, alert, now }), true);
        await idle();
        await schedule.saveSchedule(
            { enabled: true, intervalMinutes: 60, ranges: ["10.0.0.2"], notificationIDList: [] },
            scanner
        );
        assert.equal(await schedule.tick({ server, scanner, store, alert, now }), true);
        await idle();
    });

    test("does not start while another scan runs", async () => {
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        runner.startScan({
            ips: ["10.9.9.9"],
            scanner: { scan: async () => (await gate, { devices: [], completed: true, arpAvailable: true }) },
            store,
            emit: () => {},
        });
        await schedule.saveSchedule(
            { enabled: true, intervalMinutes: 5, ranges: ["10.0.0.1"], notificationIDList: [] },
            scanner
        );
        const before = scans;
        assert.equal(await schedule.tick({ server, scanner, store, alert }), false);
        release();
        await idle();
        assert.equal(scans, before + 1, "only the other scan ran");
    });
});
