const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
const { R } = require("redbean-node");
const { UP } = require("../../src/util");
// better-auth must load before database (as in server.js): the two modules import each other.
require("../../server/better-auth");
const Database = require("../../server/database");
const { Settings } = require("../../server/settings");
const store = require("../../server/network-device-store");
const {
    RESOLUTIONS,
    pickResolution,
    summarizePoints,
    getPingSummary,
    getPingSeries,
} = require("../../server/network-device-ping");

const NOW = Date.parse("2026-10-07T11:00:00Z");
const DAY = 86400000;
const USER_ID = "test-user-1";
const sec = (iso) => Date.parse(iso) / 1000;

describe("pickResolution", () => {
    test("pickResolution switches at 24 hours and 30 days, with a few minutes of slack", () => {
        const slack = 5 * 60 * 1000;
        assert.equal(pickResolution(NOW - DAY, NOW), "minute");
        // The page counts back from its own clock, so a "24 hours" request arrives a little late
        assert.equal(pickResolution(NOW - DAY - 1000, NOW), "minute");
        assert.equal(pickResolution(NOW - DAY - slack, NOW), "minute");
        assert.equal(pickResolution(NOW - DAY - slack - 1, NOW), "hour");
        assert.equal(pickResolution(NOW - 30 * DAY - 1000, NOW), "hour");
        assert.equal(pickResolution(NOW - 30 * DAY - slack, NOW), "hour");
        assert.equal(pickResolution(NOW - 30 * DAY - slack - 1, NOW), "day");
        assert.deepEqual(RESOLUTIONS.hour, { table: "stat_hourly", stepSeconds: 3600 });
    });
});

describe("summarizePoints", () => {
    test("summarizePoints weights by up and skips buckets without up", () => {
        const points = [
            [0, 10, 5, 20, 10, 0],
            [1, 20, 8, 50, 30, 0],
            [2, null, null, null, 0, 5],
        ];
        assert.deepEqual(summarizePoints(points), { samples: 40, avg: 17.5, min: 5, max: 50 });
        assert.deepEqual(summarizePoints([[2, null, null, null, 0, 5]]), {
            samples: 0,
            avg: null,
            min: null,
            max: null,
        });
        assert.deepEqual(summarizePoints([]), { samples: 0, avg: null, min: null, max: null });
    });
});

describe("network device ping (database)", () => {
    let dataDir;

    before(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-ping-test-"));
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
     * Insert one statistics row.
     * @param {string} table `stat_minutely`, `stat_hourly` or `stat_daily`
     * @param {number} monitorId Monitor id
     * @param {string} iso Start of the bucket, ISO 8601
     * @param {{ping: number, min: number, max: number, up: number, down: number}} v Values
     * @returns {Promise<void>}
     */
    async function insertStat(table, monitorId, iso, v) {
        await R.exec(
            `INSERT INTO ${table} (monitor_id, timestamp, ping, ping_min, ping_max, up, down) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [monitorId, sec(iso), v.ping, v.min, v.max, v.up, v.down]
        );
    }

    // Older than 24 hours but within 30 days of NOW: the hourly table is read.
    const HFROM = "2026-10-05T08:00:00.000Z";
    const FROM = "2026-10-07T08:00:00.000Z";
    const TO = "2026-10-07T11:00:00.000Z";

    test("getPingSummary groups per monitor from the hourly table", async () => {
        const a = await seedDevice("10.0.0.1");
        const b = await seedDevice("10.0.0.2");
        await seedDevice("10.0.0.3", false);
        await insertStat("stat_hourly", a.monitorId, "2026-10-05T08:00:00Z", {
            ping: 10,
            min: 5,
            max: 20,
            up: 10,
            down: 0,
        });
        await insertStat("stat_hourly", a.monitorId, "2026-10-05T09:00:00Z", {
            ping: 20,
            min: 8,
            max: 50,
            up: 30,
            down: 0,
        });
        await insertStat("stat_hourly", a.monitorId, "2026-10-05T10:00:00Z", {
            ping: 0,
            min: 0,
            max: 0,
            up: 0,
            down: 5,
        });
        await insertStat("stat_hourly", b.monitorId, "2026-10-05T09:00:00Z", {
            ping: 0,
            min: 0,
            max: 0,
            up: 0,
            down: 60,
        });

        const s = await getPingSummary({ from: HFROM, to: TO, now: NOW });

        assert.equal(s.resolution, "hour");
        assert.equal(s.effectiveTo, NOW);
        assert.equal(s.items.length, 2);
        const ia = s.items.find((i) => i.deviceId === a.deviceId);
        const ib = s.items.find((i) => i.deviceId === b.deviceId);
        assert.deepEqual(ia, { deviceId: a.deviceId, monitorId: a.monitorId, samples: 40, avg: 17.5, min: 5, max: 50 });
        assert.deepEqual(ib, {
            deviceId: b.deviceId,
            monitorId: b.monitorId,
            samples: 0,
            avg: null,
            min: null,
            max: null,
        });
    });

    test("getPingSummary reads stat_daily for a range older than 30 days", async () => {
        const a = await seedDevice("10.0.0.1");
        await insertStat("stat_daily", a.monitorId, "2026-08-01T00:00:00Z", {
            ping: 12,
            min: 4,
            max: 40,
            up: 100,
            down: 0,
        });
        await insertStat("stat_daily", a.monitorId, "2026-08-02T00:00:00Z", {
            ping: 24,
            min: 6,
            max: 90,
            up: 100,
            down: 0,
        });

        const s = await getPingSummary({ from: "2026-08-01T00:00:00Z", to: "2026-08-03T00:00:00Z", now: NOW });

        assert.equal(s.resolution, "day");
        assert.deepEqual(s.items[0], {
            deviceId: a.deviceId,
            monitorId: a.monitorId,
            samples: 200,
            avg: 18,
            min: 4,
            max: 90,
        });
    });

    test("getPingSummary reads stat_minutely for the last day", async () => {
        const a = await seedDevice("10.0.0.1");
        await insertStat("stat_minutely", a.monitorId, "2026-10-07T10:30:00Z", {
            ping: 7,
            min: 7,
            max: 7,
            up: 1,
            down: 0,
        });

        const s = await getPingSummary({ from: "2026-10-07T10:00:00Z", to: TO, now: NOW });

        assert.equal(s.resolution, "minute");
        assert.equal(s.items[0].avg, 7);
        assert.equal(s.items[0].samples, 1);
    });

    test("getPingSummary ignores buckets after now", async () => {
        const a = await seedDevice("10.0.0.1");
        await insertStat("stat_hourly", a.monitorId, "2026-10-07T10:00:00Z", {
            ping: 10,
            min: 10,
            max: 10,
            up: 1,
            down: 0,
        });
        await insertStat("stat_hourly", a.monitorId, "2026-10-07T12:00:00Z", {
            ping: 999,
            min: 999,
            max: 999,
            up: 1,
            down: 0,
        });

        const s = await getPingSummary({ from: HFROM, to: "2026-10-07T13:00:00.000Z", now: NOW });

        assert.equal(s.effectiveTo, NOW);
        assert.equal(s.items[0].max, 10);
        assert.equal(s.items[0].samples, 1);
    });

    test("getPingSeries returns null points for buckets without up and omits missing buckets", async () => {
        const a = await seedDevice("10.0.0.1");
        await insertStat("stat_hourly", a.monitorId, "2026-10-05T09:00:00Z", {
            ping: 10,
            min: 5,
            max: 20,
            up: 10,
            down: 0,
        });
        await insertStat("stat_hourly", a.monitorId, "2026-10-05T10:00:00Z", {
            ping: 0,
            min: 0,
            max: 0,
            up: 0,
            down: 5,
        });

        const r = await getPingSeries({ ids: [a.deviceId], from: HFROM, to: TO, now: NOW });

        assert.equal(r.resolution, "hour");
        assert.equal(r.stepSeconds, 3600);
        assert.equal(r.series.length, 1);
        assert.deepEqual(r.series[0].points, [
            [Date.parse("2026-10-05T09:00:00Z"), 10, 5, 20, 10, 0],
            [Date.parse("2026-10-05T10:00:00Z"), null, null, null, 0, 5],
        ]);
    });

    test("getPingSeries summary equals getPingSummary for the same data", async () => {
        const a = await seedDevice("10.0.0.1");
        await insertStat("stat_hourly", a.monitorId, "2026-10-05T08:00:00Z", {
            ping: 10,
            min: 5,
            max: 20,
            up: 10,
            down: 0,
        });
        await insertStat("stat_hourly", a.monitorId, "2026-10-05T09:00:00Z", {
            ping: 20,
            min: 8,
            max: 50,
            up: 30,
            down: 0,
        });

        const series = await getPingSeries({ ids: [a.deviceId], from: HFROM, to: TO, now: NOW });
        const summary = await getPingSummary({ from: HFROM, to: TO, now: NOW });

        const { samples, avg, min, max } = series.series[0].summary;
        assert.deepEqual({ samples, avg, min, max }, { samples: 40, avg: 17.5, min: 5, max: 50 });
        assert.deepEqual(summary.items[0], { deviceId: a.deviceId, monitorId: a.monitorId, samples, avg, min, max });
    });

    test("getPingSeries last ping comes from the newest heartbeat with a ping", async () => {
        const a = await seedDevice("10.0.0.1");
        const none = await seedDevice("10.0.0.2");
        const beat = (iso, ping) =>
            R.exec(
                "INSERT INTO heartbeat (monitor_id, status, time, msg, ping, important, duration) VALUES (?, ?, ?, NULL, ?, 0, 0)",
                [a.monitorId, UP, dayjs.utc(iso).format("YYYY-MM-DD HH:mm:ss.SSS"), ping]
            );
        await beat("2026-10-07T10:00:00Z", 12);
        await beat("2026-10-07T10:05:00Z", null);

        const r = await getPingSeries({ ids: [a.deviceId, none.deviceId], from: FROM, to: TO, now: NOW });

        assert.deepEqual(r.series[0].summary.last, { time: Date.parse("2026-10-07T10:00:00Z"), ping: 12 });
        assert.equal(r.series[1].summary.last, null);
    });

    test("getPingSeries validates ids", async () => {
        const a = await seedDevice("10.0.0.1");
        const loose = await seedDevice("10.0.0.2", false);
        const call = (ids, from = FROM, to = TO) => getPingSeries({ ids, from, to, now: NOW });
        for (const bad of [[], [1, 2, 3, 4, 5, 6], "1", ["a"], [1.5], null]) {
            await assert.rejects(() => call(bad), /Pilih 1 sampai 5 perangkat/);
        }
        const dup = await call([a.deviceId, a.deviceId]);
        assert.equal(dup.series.length, 1);
        await assert.rejects(() => call([99999]), /Perangkat tidak ditemukan/);
        await assert.rejects(() => call([loose.deviceId]), /Perangkat belum dimonitor/);
        await assert.rejects(() => call([a.deviceId], "x", TO), /Rentang waktu tidak valid/);
        await assert.rejects(() => call([a.deviceId], TO, FROM), /Awal harus sebelum akhir/);
    });

    test("getPingSummary limits the answer to deviceIds and an empty list means no devices", async () => {
        const a = await seedDevice("10.0.0.1");
        const b = await seedDevice("10.0.0.2");
        const c = await seedDevice("10.0.0.3", false);
        await insertStat("stat_hourly", a.monitorId, "2026-10-05T09:00:00Z", {
            ping: 20,
            min: 8,
            max: 50,
            up: 30,
            down: 0,
        });
        await insertStat("stat_hourly", b.monitorId, "2026-10-05T09:00:00Z", {
            ping: 10,
            min: 5,
            max: 15,
            up: 30,
            down: 0,
        });
        const base = { from: HFROM, to: TO, now: NOW };

        assert.equal((await getPingSummary(base)).items.length, 2);
        assert.deepEqual(
            (await getPingSummary({ ...base, deviceIds: [b.deviceId] })).items.map((i) => i.deviceId),
            [b.deviceId]
        );
        assert.deepEqual(
            (await getPingSummary({ ...base, deviceIds: [b.deviceId, c.deviceId, 99999] })).items.map(
                (i) => i.deviceId
            ),
            [b.deviceId]
        );
        assert.deepEqual((await getPingSummary({ ...base, deviceIds: [] })).items, []);
        for (const bad of [null, "1", [1, 1], [1.5]]) {
            await assert.rejects(() => getPingSummary({ ...base, deviceIds: bad }), /Daftar perangkat tidak valid/);
        }
    });
});
