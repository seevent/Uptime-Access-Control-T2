const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
const { R } = require("redbean-node");
const { UP, DOWN, PENDING, MAINTENANCE } = require("../../src/util");
// better-auth must load before database (as in server.js): the two modules import each other.
require("../../server/better-auth");
const Database = require("../../server/database");
const { Settings } = require("../../server/settings");
const store = require("../../server/network-device-store");
const { summarizeBeats, parseRange, getDeviceUptime, getUptimeSummary } = require("../../server/network-device-uptime");

const at = (hhmmss) => Date.parse(`2026-10-07T${hhmmss}Z`);
const FROM = at("10:00:00");
const NOW = at("11:00:00");

/**
 * Beats of one status at a fixed step.
 * @param {string} start First beat, "HH:mm:ss"
 * @param {string} last Last beat, "HH:mm:ss" (inclusive)
 * @param {number} status Status of every beat
 * @param {number} stepSec Seconds between beats
 * @param {string} msg Message of the first beat
 * @returns {{time: number, status: number, msg: string|null}[]} Beats
 */
function series(start, last, status, stepSec = 60, msg = null) {
    const list = [];
    for (let t = at(start); t <= at(last); t += stepSec * 1000) {
        list.push({ time: t, status, msg: list.length === 0 ? msg : null });
    }
    return list;
}

/**
 * Summarize with the default fixture range (10:00 to 11:00, now = 11:00, interval 60).
 * @param {object[]} beats Beats
 * @param {object} extra Overrides
 * @returns {object} Summary
 */
function run(beats, extra = {}) {
    return summarizeBeats({
        beats,
        from: FROM,
        to: NOW,
        now: NOW,
        intervalSec: 60,
        retryIntervalSec: 60,
        ...extra,
    });
}

describe("summarizeBeats", () => {
    test("all up", () => {
        const r = run(series("09:59:30", "10:59:30", UP));
        assert.equal(r.spanSeconds, 3600);
        assert.equal(r.upSeconds, 3600);
        assert.equal(r.downSeconds, 0);
        assert.equal(r.noDataSeconds, 0);
        assert.equal(r.uptimePercent, 100);
        assert.equal(r.downCount, 0);
        assert.equal(r.effectiveTo, NOW);
    });

    test("one down period with its message", () => {
        const beats = [
            ...series("09:59:00", "10:19:00", UP),
            ...series("10:20:00", "10:29:00", DOWN, 60, "timeout"),
            ...series("10:30:00", "10:59:00", UP),
        ];
        const r = run(beats);
        assert.equal(r.downSeconds, 600);
        assert.equal(r.upSeconds, 3000);
        assert.equal(r.noDataSeconds, 0);
        assert.equal(r.downCount, 1);
        assert.deepEqual(r.downPeriods, [{ start: at("10:20:00"), end: at("10:30:00"), seconds: 600, msg: "timeout" }]);
        assert.ok(Math.abs(r.uptimePercent - (3000 / 3600) * 100) < 1e-9);
    });

    test("two separate down periods", () => {
        const beats = [
            ...series("09:59:00", "10:09:00", UP),
            ...series("10:10:00", "10:14:00", DOWN, 60, "a"),
            ...series("10:15:00", "10:39:00", UP),
            ...series("10:40:00", "10:44:00", DOWN, 60, "b"),
            ...series("10:45:00", "10:59:00", UP),
        ];
        const r = run(beats);
        assert.equal(r.downCount, 2);
        assert.equal(r.downSeconds, 600);
        assert.deepEqual(
            r.downPeriods.map((p) => [p.seconds, p.msg]),
            [
                [300, "a"],
                [300, "b"],
            ]
        );
    });

    test("a gap exactly at the limit (125 s) counts in full", () => {
        const beats = [
            ...series("09:59:00", "10:10:00", UP),
            ...series("10:12:05", "10:59:05", UP), // 125 s after 10:10:00
        ];
        const r = run(beats);
        assert.equal(r.upSeconds, 3600);
        assert.equal(r.noDataSeconds, 0);
    });

    test("a gap of 126 s counts one interval; the rest is no data", () => {
        const beats = [
            ...series("09:59:00", "10:10:00", UP),
            ...series("10:12:06", "10:59:06", UP), // 126 s after 10:10:00
        ];
        const r = run(beats);
        assert.equal(r.noDataSeconds, 66);
        assert.equal(r.upSeconds, 3534);
    });

    test("the beat before `from` cuts the first segment", () => {
        const beats = [...series("09:59:30", "10:01:30", DOWN, 60, "x"), ...series("10:02:30", "10:59:30", UP)];
        const r = run(beats);
        assert.equal(r.downCount, 1);
        assert.deepEqual(r.downPeriods, [{ start: FROM, end: at("10:02:30"), seconds: 150, msg: "x" }]);
        assert.equal(r.noDataSeconds, 0);
    });

    test("no beats at all is all no data", () => {
        const r = run([]);
        assert.equal(r.spanSeconds, 3600);
        assert.equal(r.noDataSeconds, 3600);
        assert.equal(r.upSeconds, 0);
        assert.equal(r.uptimePercent, null);
        assert.equal(r.downCount, 0);
        assert.deepEqual(r.downPeriods, []);
    });

    test("a `to` in the future is cut to now", () => {
        const r = run(series("09:59:00", "10:59:00", UP), { to: at("12:00:00") });
        assert.equal(r.effectiveTo, NOW);
        assert.equal(r.spanSeconds, 3600);
        assert.equal(r.upSeconds, 3600);
    });

    test("time before the first beat is no data", () => {
        const r = run(series("10:30:00", "10:59:00", UP));
        assert.equal(r.noDataSeconds, 1800);
        assert.equal(r.upSeconds, 1800);
    });

    test("maintenance and pending are counted apart and stay out of the percentage", () => {
        const beats = [
            ...series("10:00:00", "10:29:00", UP),
            ...series("10:30:00", "10:39:00", MAINTENANCE),
            ...series("10:40:00", "10:44:00", PENDING),
            ...series("10:45:00", "10:49:00", DOWN),
            ...series("10:50:00", "10:59:00", UP),
        ];
        const r = run(beats);
        assert.equal(r.upSeconds, 2400);
        assert.equal(r.maintenanceSeconds, 600);
        assert.equal(r.pendingSeconds, 300);
        assert.equal(r.downSeconds, 300);
        assert.ok(Math.abs(r.uptimePercent - (2400 / 2700) * 100) < 1e-9);
    });

    test("the percentage is null when up + down is 0", () => {
        const r = run(series("09:59:00", "10:59:00", MAINTENANCE));
        assert.equal(r.maintenanceSeconds, 3600);
        assert.equal(r.uptimePercent, null);
    });

    test("more than 500 down periods keeps the newest 500 and flags it", () => {
        const start = at("00:00:00");
        const beats = [];
        for (let i = 0; i < 600; i++) {
            beats.push({ time: start + i * 120000, status: DOWN, msg: `d${i}` });
            beats.push({ time: start + i * 120000 + 60000, status: UP, msg: null });
        }
        const r = summarizeBeats({
            beats,
            from: start,
            to: start + 1200 * 60000,
            now: start + 1200 * 60000,
            intervalSec: 60,
            retryIntervalSec: 60,
        });
        assert.equal(r.downCount, 600);
        assert.equal(r.downPeriods.length, 500);
        assert.equal(r.downPeriodsTruncated, true);
        assert.equal(r.downPeriods[0].msg, "d100");
        assert.equal(r.downPeriods[499].msg, "d599");
    });

    test("a down period is not truncated when there are 500 or fewer", () => {
        const r = run(series("09:59:00", "10:59:00", DOWN, 60, "m"));
        assert.equal(r.downPeriodsTruncated, false);
        assert.equal(r.downCount, 1);
    });

    describe("segments", () => {
        test("segments merge consecutive beats of the same state", () => {
            const beats = [
                ...series("10:00:00", "10:09:00", UP),
                ...series("10:10:00", "10:19:00", DOWN),
                ...series("10:20:00", "10:30:00", UP),
            ];
            const r = run(beats, { withSegments: true });
            assert.deepEqual(r.segments, [
                { start: at("10:00:00"), end: at("10:10:00"), state: "up" },
                { start: at("10:10:00"), end: at("10:20:00"), state: "down" },
                { start: at("10:20:00"), end: at("10:31:00"), state: "up" },
            ]);
            assert.equal(r.segmentsTruncated, false);
        });

        test("a gap between beats leaves no segment", () => {
            const beats = [...series("10:00:00", "10:09:00", UP), ...series("10:30:00", "10:39:00", UP)];
            const r = run(beats, { withSegments: true });
            assert.deepEqual(r.segments, [
                { start: at("10:00:00"), end: at("10:10:00"), state: "up" },
                { start: at("10:30:00"), end: at("10:40:00"), state: "up" },
            ]);
        });

        test("segment seconds equal the state seconds", () => {
            const beats = [
                ...series("10:00:00", "10:09:00", UP),
                ...series("10:10:00", "10:14:00", DOWN),
                ...series("10:15:00", "10:19:00", MAINTENANCE),
                ...series("10:20:00", "10:24:00", PENDING),
                ...series("10:25:00", "10:59:00", UP),
            ];
            const r = run(beats, { withSegments: true });
            const sum = (state) =>
                r.segments.filter((x) => x.state === state).reduce((total, x) => total + (x.end - x.start), 0) / 1000;
            assert.equal(sum("up"), r.upSeconds);
            assert.equal(sum("down"), r.downSeconds);
            assert.equal(sum("maintenance"), r.maintenanceSeconds);
            assert.equal(sum("pending"), r.pendingSeconds);
            assert.equal(r.downSeconds, 300);
        });

        test("segments are cut at the range start", () => {
            const beats = [
                { time: at("09:59:30"), status: UP, msg: null },
                { time: at("10:00:30"), status: DOWN, msg: null },
                { time: at("10:01:30"), status: UP, msg: null },
            ];
            const r = run(beats, { withSegments: true });
            assert.equal(r.segments[0].start, FROM);
            assert.equal(r.segments[0].state, "up");
            assert.equal(r.segments[0].end, at("10:00:30"));
        });

        test("only the newest segments are kept", () => {
            const beats = [];
            for (let i = 0; i < 10; i++) {
                beats.push({ time: at("10:00:00") + i * 60000, status: i % 2 === 0 ? UP : DOWN, msg: null });
            }
            const r = run(beats, { withSegments: true, maxSegments: 4 });
            assert.equal(r.segments.length, 4);
            assert.equal(r.segments[0].start, at("10:06:00"));
            assert.equal(r.segmentsTruncated, true);
        });

        test("no segments unless asked", () => {
            const r = run(series("10:00:00", "10:10:00", UP));
            assert.equal(r.segments, undefined);
            assert.equal(r.segmentsTruncated, undefined);
        });
    });
});

describe("parseRange", () => {
    test("accepts two valid ISO times", () => {
        const r = parseRange("2026-10-07T10:00:00Z", "2026-10-07T11:00:00.000Z");
        assert.deepEqual(r, { fromMs: at("10:00:00"), toMs: at("11:00:00") });
    });

    test("rejects values that are not strings or not dates", () => {
        for (const bad of [undefined, null, 123, "", "abc", {}]) {
            assert.throws(() => parseRange(bad, "2026-10-07T11:00:00Z"), /Rentang waktu tidak valid/);
            assert.throws(() => parseRange("2026-10-07T10:00:00Z", bad), /Rentang waktu tidak valid/);
        }
    });

    test("rejects a start that is not before the end", () => {
        assert.throws(() => parseRange("2026-10-07T11:00:00Z", "2026-10-07T10:00:00Z"), /Awal harus sebelum akhir/);
        assert.throws(() => parseRange("2026-10-07T10:00:00Z", "2026-10-07T10:00:00Z"), /Awal harus sebelum akhir/);
    });

    test("allows 366 days and rejects 367", () => {
        assert.doesNotThrow(() => parseRange("2025-10-06T00:00:00Z", "2026-10-07T00:00:00Z"));
        assert.throws(() => parseRange("2025-10-05T00:00:00Z", "2026-10-07T00:00:00Z"), /Rentang maksimal 366 hari/);
    });
});

describe("with the database", () => {
    const USER_ID = "test-user-1";
    let dataDir;

    before(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-uptime-test-"));
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

    const FROM_ISO = "2026-10-07T10:00:00.000Z";
    const TO_ISO = "2026-10-07T11:00:00.000Z";

    test("getDeviceUptime counts up and down from the heartbeat table", async () => {
        const { deviceId, monitorId } = await seedDevice("10.0.0.1");
        const up = (a, b) => series(a, b, UP).map((x) => ({ ...x, msg: "OK" }));
        await insertBeats(monitorId, [
            ...up("09:59:00", "10:19:00"),
            ...series("10:20:00", "10:29:00", DOWN, 60, "timeout"),
            ...up("10:30:00", "10:59:00"),
        ]);

        const r = await getDeviceUptime({ deviceId, from: FROM_ISO, to: TO_ISO, now: NOW });

        assert.equal(r.monitorId, monitorId);
        assert.equal(r.upSeconds, 3000);
        assert.equal(r.downSeconds, 600);
        assert.equal(r.noDataSeconds, 0);
        assert.equal(r.downCount, 1);
        assert.deepEqual(r.downPeriods, [
            { start: "2026-10-07T10:20:00.000Z", end: "2026-10-07T10:30:00.000Z", seconds: 600, msg: "timeout" },
        ]);
        assert.equal(r.effectiveTo, TO_ISO);
        assert.equal(r.dataSince, "2026-10-07T09:59:00.000Z");
    });

    test("getDeviceUptime reads the beat before the range", async () => {
        const { deviceId, monitorId } = await seedDevice("10.0.0.1");
        await insertBeats(monitorId, [
            ...series("09:59:30", "10:01:30", DOWN, 60, "x"),
            ...series("10:02:30", "10:59:30", UP),
        ]);

        const r = await getDeviceUptime({ deviceId, from: FROM_ISO, to: TO_ISO, now: NOW });

        assert.equal(r.downPeriods[0].start, FROM_ISO);
        assert.equal(r.downPeriods[0].end, "2026-10-07T10:02:30.000Z");
        assert.equal(r.downPeriods[0].msg, "x");
    });

    test("a monitor without any beat is all no data", async () => {
        const { deviceId } = await seedDevice("10.0.0.1");

        const r = await getDeviceUptime({ deviceId, from: FROM_ISO, to: TO_ISO, now: NOW });

        assert.equal(r.noDataSeconds, 3600);
        assert.equal(r.uptimePercent, null);
        assert.equal(r.dataSince, null);
        assert.deepEqual(r.downPeriods, []);
    });

    test("a `to` in the future is cut to now", async () => {
        const { deviceId, monitorId } = await seedDevice("10.0.0.1");
        await insertBeats(monitorId, series("09:59:00", "10:59:00", UP));

        const r = await getDeviceUptime({ deviceId, from: FROM_ISO, to: "2026-10-07T12:00:00.000Z", now: NOW });

        assert.equal(r.effectiveTo, TO_ISO);
        assert.equal(r.spanSeconds, 3600);
        assert.equal(r.upSeconds, 3600);
    });

    test("an unknown device and a device without a monitor are refused", async () => {
        const { deviceId } = await seedDevice("10.0.0.2", false);
        await assert.rejects(getDeviceUptime({ deviceId: 99999, from: FROM_ISO, to: TO_ISO, now: NOW }), {
            message: "Perangkat tidak ditemukan",
        });
        await assert.rejects(getDeviceUptime({ deviceId, from: FROM_ISO, to: TO_ISO, now: NOW }), {
            message: "Perangkat belum dimonitor",
        });
    });

    test("an invalid range is refused", async () => {
        const { deviceId } = await seedDevice("10.0.0.1");
        await assert.rejects(getDeviceUptime({ deviceId, from: TO_ISO, to: FROM_ISO, now: NOW }), {
            message: "Awal harus sebelum akhir",
        });
    });

    test("getUptimeSummary covers monitored devices only and has no down periods", async () => {
        const a = await seedDevice("10.0.0.1");
        await seedDevice("10.0.0.2", false);
        await insertBeats(a.monitorId, series("09:59:00", "10:59:00", UP));

        const { items } = await getUptimeSummary({ from: FROM_ISO, to: TO_ISO, now: NOW });

        assert.equal(items.length, 1);
        assert.equal(items[0].deviceId, a.deviceId);
        assert.equal(items[0].monitorId, a.monitorId);
        assert.equal(items[0].upSeconds, 3600);
        assert.equal(items[0].uptimePercent, 100);
        assert.equal("downPeriods" in items[0], false);
    });

    test("getUptimeSummary limits the answer to deviceIds and an empty list means no devices", async () => {
        const a = await seedDevice("10.0.0.1");
        const b = await seedDevice("10.0.0.2");
        const c = await seedDevice("10.0.0.3", false);
        await insertBeats(a.monitorId, series("09:59:00", "10:59:00", UP));
        await insertBeats(b.monitorId, series("09:59:00", "10:59:00", UP));
        const base = { from: FROM_ISO, to: TO_ISO, now: NOW };

        assert.equal((await getUptimeSummary(base)).items.length, 2);
        assert.deepEqual(
            (await getUptimeSummary({ ...base, deviceIds: [b.deviceId] })).items.map((i) => i.deviceId),
            [b.deviceId]
        );
        assert.deepEqual(
            (await getUptimeSummary({ ...base, deviceIds: [b.deviceId, c.deviceId, 99999] })).items.map(
                (i) => i.deviceId
            ),
            [b.deviceId]
        );
        assert.deepEqual((await getUptimeSummary({ ...base, deviceIds: [] })).items, []);
        for (const bad of [null, "1", [1, 1], [1.5]]) {
            await assert.rejects(() => getUptimeSummary({ ...base, deviceIds: bad }), /Daftar perangkat tidak valid/);
        }
    });
});
