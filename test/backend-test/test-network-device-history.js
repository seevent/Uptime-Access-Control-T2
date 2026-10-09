const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
const { R } = require("redbean-node");
const { UP, DOWN } = require("../../src/util");
// better-auth must load before database (as in server.js): the two modules import each other.
require("../../server/better-auth");
const Database = require("../../server/database");
const { Settings } = require("../../server/settings");
const store = require("../../server/network-device-store");
const { getDeviceHistory, getDownHistory, getDownEvents } = require("../../server/network-device-history");

const at = (hhmmss) => Date.parse(`2026-10-07T${hhmmss}Z`);
const NOW = at("11:00:00");
const FROM_ISO = "2026-10-07T10:00:00.000Z";
const TO_ISO = "2026-10-07T11:00:00.000Z";
const USER_ID = "test-user-1";

/**
 * Beats of one status at a fixed step.
 * @param {string} start First beat, "HH:mm:ss"
 * @param {string} last Last beat, "HH:mm:ss" (inclusive)
 * @param {number} status Status of every beat
 * @param {number} stepSec Seconds between beats
 * @returns {{time: number, status: number, msg: string|null}[]} Beats
 */
function series(start, last, status, stepSec = 60) {
    const list = [];
    for (let t = at(start); t <= at(last); t += stepSec * 1000) {
        list.push({ time: t, status, msg: status === DOWN ? "timeout" : null });
    }
    return list;
}

describe("network device history (database)", () => {
    let dataDir;

    before(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-history-test-"));
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
        await R.exec("DELETE FROM monitor");
    });

    /**
     * Create a ping monitor and a device linked to it.
     * @param {string} ip Device address
     * @param {boolean} monitored False to leave the device without a monitor
     * @returns {Promise<{deviceId: number, monitorId: number|null}>} Their ids
     */
    async function seedDevice(ip, monitored = true) {
        await store.mergeScan({
            devices: [{ ip, mac: null, hostname: null, vendor: null, detectedVia: "ping" }],
            scannedIPs: [ip],
            complete: true,
            now: new Date("2026-10-07T09:00:00Z"),
        });
        const device = (await store.listDevices()).find((d) => d.ip === ip);
        if (!monitored) {
            return { deviceId: device.id, monitorId: null };
        }
        const bean = R.dispense("monitor");
        bean.import({
            type: "ping",
            name: ip,
            hostname: ip,
            interval: 60,
            retryInterval: 60,
            resendInterval: 0,
            maxretries: 0,
            timeout: 10,
            accepted_statuscodes_json: JSON.stringify(["200-299"]),
            conditions: "[]",
            user_id: USER_ID,
        });
        await R.store(bean);
        await store.setMonitorId(device.id, bean.id);
        return { deviceId: device.id, monitorId: bean.id };
    }

    /**
     * Insert beats straight into the heartbeat table.
     * @param {number} monitorId Monitor id
     * @param {object[]} beats Beats `{ time (ms), status, msg }`
     * @returns {Promise<void>}
     */
    async function insertBeats(monitorId, beats) {
        for (const b of beats) {
            await R.exec(
                "INSERT INTO heartbeat (monitor_id, status, time, msg, important, duration) VALUES (?, ?, ?, ?, 0, 0)",
                [monitorId, b.status, dayjs.utc(b.time).format("YYYY-MM-DD HH:mm:ss.SSS"), b.msg]
            );
        }
    }

    const twoOutages = () => [
        ...series("09:59:00", "10:09:00", UP),
        ...series("10:10:00", "10:14:00", DOWN),
        ...series("10:15:00", "10:39:00", UP),
        ...series("10:40:00", "10:44:00", DOWN),
        ...series("10:45:00", "10:59:00", UP),
    ];

    test("getDeviceHistory refuses a device id that is not a whole number", async () => {
        for (const bad of [undefined, null, "1", 1.5, {}]) {
            await assert.rejects(
                () => getDeviceHistory({ deviceId: bad, from: FROM_ISO, to: TO_ISO, now: NOW }),
                /Perangkat tidak valid/
            );
        }
    });

    test("getDeviceHistory returns merged segments for a monitored device", async () => {
        const { deviceId, monitorId } = await seedDevice("10.0.0.1");
        await insertBeats(monitorId, [
            ...series("09:59:00", "10:19:00", UP),
            ...series("10:20:00", "10:29:00", DOWN),
            ...series("10:30:00", "10:59:00", UP),
        ]);

        const h = await getDeviceHistory({ deviceId, from: FROM_ISO, to: TO_ISO, now: NOW });

        assert.equal(h.monitorId, monitorId);
        assert.equal(h.effectiveTo, NOW);
        assert.equal(h.spanSeconds, 3600);
        assert.deepEqual(h.segments, [
            { start: at("10:00:00"), end: at("10:20:00"), state: "up" },
            { start: at("10:20:00"), end: at("10:30:00"), state: "down" },
            { start: at("10:30:00"), end: at("11:00:00"), state: "up" },
        ]);
        assert.equal(h.segmentsTruncated, false);
    });

    test("getDeviceHistory rejects a bad range, an unknown device and an unmonitored device", async () => {
        const { deviceId } = await seedDevice("10.0.0.1");
        const loose = await seedDevice("10.0.0.2", false);
        await assert.rejects(
            () => getDeviceHistory({ deviceId, from: "x", to: TO_ISO, now: NOW }),
            /Rentang waktu tidak valid/
        );
        await assert.rejects(
            () => getDeviceHistory({ deviceId, from: TO_ISO, to: FROM_ISO, now: NOW }),
            /Awal harus sebelum akhir/
        );
        await assert.rejects(
            () => getDeviceHistory({ deviceId: 99999, from: FROM_ISO, to: TO_ISO, now: NOW }),
            /Perangkat tidak ditemukan/
        );
        await assert.rejects(
            () => getDeviceHistory({ deviceId: loose.deviceId, from: FROM_ISO, to: TO_ISO, now: NOW }),
            /Perangkat belum dimonitor/
        );
    });

    test("getDownHistory lists monitored devices only, with exact counts", async () => {
        const quiet = await seedDevice("10.0.0.1");
        const flaky = await seedDevice("10.0.0.2");
        await seedDevice("10.0.0.3", false);
        await insertBeats(quiet.monitorId, series("09:59:00", "10:59:00", UP));
        await insertBeats(flaky.monitorId, twoOutages());

        const h = await getDownHistory({ from: FROM_ISO, to: TO_ISO, now: NOW });

        assert.equal(h.effectiveTo, NOW);
        assert.equal(h.devices.length, 2);
        const q = h.devices.find((d) => d.deviceId === quiet.deviceId);
        const f = h.devices.find((d) => d.deviceId === flaky.deviceId);
        assert.deepEqual(q, {
            deviceId: quiet.deviceId,
            monitorId: quiet.monitorId,
            downCount: 0,
            downSeconds: 0,
            periods: [],
            periodsTruncated: false,
        });
        assert.equal(f.downCount, 2);
        assert.equal(f.downSeconds, 600);
        assert.deepEqual(f.periods, [
            [at("10:10:00"), at("10:15:00")],
            [at("10:40:00"), at("10:45:00")],
        ]);
        assert.equal(f.periodsTruncated, false);
    });

    test("getDownHistory keeps the 500 newest periods but counts all", async () => {
        const { monitorId } = await seedDevice("10.0.0.1");
        const beats = [];
        const start = Date.parse("2026-10-06T14:00:00Z");
        for (let i = 0; i < 1200; i++) {
            beats.push({ time: start + i * 60000, status: i % 2 === 0 ? DOWN : UP, msg: null });
        }
        await insertBeats(monitorId, beats);

        const h = await getDownHistory({ from: "2026-10-06T14:00:00.000Z", to: TO_ISO, now: NOW });

        const d = h.devices[0];
        assert.equal(d.downCount, 600);
        assert.equal(d.downSeconds, 600 * 60);
        assert.equal(d.periods.length, 500);
        assert.equal(d.periodsTruncated, true);
        assert.equal(d.periods[499][0], start + 1198 * 60000);
    });

    test("getDownHistory ignores time after now", async () => {
        const { monitorId } = await seedDevice("10.0.0.1");
        await insertBeats(monitorId, series("10:30:00", "10:59:00", DOWN));

        const h = await getDownHistory({ from: FROM_ISO, to: "2026-10-07T12:00:00.000Z", now: NOW });

        assert.equal(h.effectiveTo, NOW);
        assert.equal(h.spanSeconds, 3600);
        assert.equal(h.devices[0].downSeconds, 1800);
    });

    test("getDownHistory limits the answer to deviceIds and an empty list means no devices", async () => {
        const a = await seedDevice("10.0.0.1");
        const b = await seedDevice("10.0.0.2");
        const c = await seedDevice("10.0.0.3", false);
        await insertBeats(a.monitorId, twoOutages());
        await insertBeats(b.monitorId, twoOutages());
        const base = { from: FROM_ISO, to: TO_ISO, now: NOW };

        assert.equal((await getDownHistory(base)).devices.length, 2);
        assert.deepEqual(
            (await getDownHistory({ ...base, deviceIds: [a.deviceId] })).devices.map((d) => d.deviceId),
            [a.deviceId]
        );
        assert.deepEqual(
            (await getDownHistory({ ...base, deviceIds: [a.deviceId, c.deviceId, 99999] })).devices.map(
                (d) => d.deviceId
            ),
            [a.deviceId]
        );
        assert.deepEqual((await getDownHistory({ ...base, deviceIds: [] })).devices, []);
        for (const bad of [null, "1", [1, 1], [1.5]]) {
            await assert.rejects(() => getDownHistory({ ...base, deviceIds: bad }), /Daftar perangkat tidak valid/);
        }
    });

    describe("getDownEvents", () => {
        const base = { from: FROM_ISO, to: TO_ISO, now: NOW };

        /**
         * Two monitored devices: A has two outages, B has one that is still going on at the end of the range.
         * @returns {Promise<{a: object, b: object, c: object}>} The seeded devices (c has no monitor)
         */
        async function seedOutages() {
            const a = await seedDevice("10.0.0.1");
            const b = await seedDevice("10.0.0.2");
            const c = await seedDevice("10.0.0.3", false);
            await insertBeats(a.monitorId, twoOutages());
            await insertBeats(b.monitorId, [
                ...series("09:59:00", "10:49:00", UP),
                ...series("10:50:00", "10:59:00", DOWN),
            ]);
            return { a, b, c };
        }

        test("lists the down periods of the monitored devices, oldest first", async () => {
            const { a, b } = await seedOutages();

            const r = await getDownEvents(base);

            assert.equal(r.effectiveTo, NOW);
            assert.equal(r.truncated, false);
            assert.deepEqual(
                r.events.map((e) => [e.deviceId, e.start, e.msg]),
                [
                    [a.deviceId, at("10:10:00"), "timeout"],
                    [a.deviceId, at("10:40:00"), "timeout"],
                    [b.deviceId, at("10:50:00"), "timeout"],
                ]
            );
            assert.ok(r.events[0].end > r.events[0].start && r.events[0].end <= at("10:16:00"));
        });

        test("a period that is still going on ends at effectiveTo", async () => {
            const { b } = await seedOutages();
            const r = await getDownEvents({ ...base, deviceIds: [b.deviceId] });
            assert.equal(r.events.length, 1);
            assert.equal(r.events[0].end, r.effectiveTo);
        });

        test("keeps the newest periods per device and says it cut the rest", async () => {
            const { a } = await seedOutages();
            const r = await getDownEvents({ ...base, deviceIds: [a.deviceId], maxPerDevice: 1 });
            assert.deepEqual(
                r.events.map((e) => e.start),
                [at("10:40:00")]
            );
            assert.equal(r.truncated, true);
        });

        test("deviceIds limits the devices, an empty list means none, a bad one is refused", async () => {
            const { a, c } = await seedOutages();
            assert.deepEqual(
                (await getDownEvents({ ...base, deviceIds: [a.deviceId, c.deviceId] })).events.map((e) => e.deviceId),
                [a.deviceId, a.deviceId]
            );
            assert.deepEqual((await getDownEvents({ ...base, deviceIds: [] })).events, []);
            await assert.rejects(() => getDownEvents({ ...base, deviceIds: "x" }), /Daftar perangkat tidak valid/);
        });

        test("refuses an invalid range", async () => {
            await assert.rejects(() => getDownEvents({ from: "x", to: "y", now: NOW }), /./);
        });
    });
});
