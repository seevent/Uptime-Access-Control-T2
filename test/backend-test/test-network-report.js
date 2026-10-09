const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
const { R } = require("redbean-node");
const { DOWN, UP } = require("../../src/util");
// better-auth must load before database (as in server.js): the two modules import each other.
require("../../server/better-auth");
const Database = require("../../server/database");
const { Settings } = require("../../server/settings");
const report = require("../../server/network-report");
const reportSchedule = require("../../server/network-report-schedule");

const USER_ID = "test-user-1";
const local = (month, day, hour = 0, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime();
const NOW = local(10, 5, 12);

describe("report helpers", () => {
    test("monthRange gives the local start of the month and of the next one", () => {
        const r = report.monthRange("2026-09");
        assert.equal(r.fromMs, local(9, 1));
        assert.equal(r.toMs, local(10, 1));
        assert.equal(report.monthRange("2026-12").toMs, local(13, 1));
        for (const bad of [
            "2026-13",
            "2026-00",
            "2026-9",
            "26-09",
            "1999-12",
            "2101-01",
            "",
            null,
            undefined,
            202609,
        ]) {
            assert.throws(() => report.monthRange(bad), /Bulan tidak valid/);
        }
    });

    test("previousMonth crosses the year", () => {
        assert.equal(report.previousMonth(local(10, 5)), "2026-09");
        assert.equal(report.previousMonth(local(1, 1, 0, 1)), "2025-12");
        assert.equal(report.previousMonth(local(3, 31, 23)), "2026-02");
    });

    test("formatDuration shows at most three units and 0 dtk for nothing", () => {
        assert.equal(report.formatDuration(0), "0 dtk");
        assert.equal(report.formatDuration(59), "59 dtk");
        assert.equal(report.formatDuration(3600), "1 jam");
        assert.equal(report.formatDuration(86400 + 7200 + 300), "1 hari 2 jam 5 mnt");
        assert.equal(report.formatDuration(86400 + 3600 + 60 + 1), "1 hari 1 jam 1 mnt");
        assert.equal(report.formatDuration(-5), "0 dtk");
    });

    test("aggregate adds seconds and weights the ping by the number of samples", () => {
        const a = report.aggregate([
            { upSeconds: 90, downSeconds: 10, downCount: 1, ping: { samples: 100, avg: 20, min: 10, max: 50 } },
            { upSeconds: 100, downSeconds: 0, downCount: 0, ping: { samples: 300, avg: 40, min: 30, max: 80 } },
            { upSeconds: 0, downSeconds: 0, downCount: 0, ping: { samples: 0, avg: null, min: null, max: null } },
        ]);
        assert.deepEqual(a, {
            devices: 3,
            uptimePercent: (190 / 200) * 100,
            downCount: 1,
            downSeconds: 10,
            pingAvg: 35,
            pingMin: 10,
            pingMax: 80,
        });
        assert.equal(report.aggregate([]).uptimePercent, null);
        assert.equal(report.aggregate([]).pingAvg, null);
    });

    test("normalizeSchedule checks the hour and the folder", () => {
        const ok = reportSchedule.normalizeSchedule({ enabled: true, folder: path.resolve("x"), hour: "6" });
        assert.equal(ok.hour, 6);
        assert.equal(ok.enabled, true);
        assert.deepEqual(reportSchedule.normalizeSchedule({ hour: 0 }), { enabled: false, folder: "", hour: 0 });
        assert.throws(() => reportSchedule.normalizeSchedule({ hour: 24 }), /Jam harus/);
        assert.throws(() => reportSchedule.normalizeSchedule({ hour: 1.5 }), /Jam harus/);
        assert.throws(() => reportSchedule.normalizeSchedule({ hour: 7, folder: "laporan" }), /folder lengkap/);
        assert.throws(() => reportSchedule.normalizeSchedule(null), /tidak valid/);
        assert.equal(reportSchedule.reportFolder({ folder: "" }, "/data"), path.join("/data", "reports"));
        assert.equal(reportSchedule.reportFolder({ folder: "/x" }, "/data"), "/x");
    });
});

describe("monthly report (database)", () => {
    let dataDir;
    let tmp;

    before(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-report-test-"));
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-report-out-"));
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
        reportSchedule.stopScheduler();
        Settings.stopCacheCleaner();
        await Database.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    /**
     * @param {number} monitorId Monitor id
     * @param {number} status Status
     * @param {number} ms Time of the beat (ms)
     * @param {string} msg Message
     * @returns {Promise<void>}
     */
    async function beat(monitorId, status, ms, msg = "ok") {
        await R.exec(
            "INSERT INTO heartbeat (monitor_id, status, time, msg, important, duration) VALUES (?, ?, ?, ?, 0, 1)",
            [monitorId, status, R.isoDateTimeMillis(dayjs.utc(ms)), msg]
        );
    }

    /**
     * @param {number} monitorId Monitor id
     * @param {number} timestamp Unix seconds
     * @param {number} ping Average ping
     * @param {number} low Lowest ping
     * @param {number} high Highest ping
     * @param {number} up Successful checks
     * @returns {Promise<void>}
     */
    async function stat(monitorId, timestamp, ping, low, high, up) {
        await R.exec(
            "INSERT INTO stat_daily (monitor_id, timestamp, ping, ping_min, ping_max, up, down) VALUES (?, ?, ?, ?, ?, ?, 0)",
            [monitorId, timestamp, ping, low, high, up]
        );
    }

    beforeEach(async () => {
        await R.exec("DELETE FROM heartbeat");
        await R.exec("DELETE FROM stat_daily");
        await R.exec("DELETE FROM network_device");
        await R.exec("DELETE FROM network_category");
        await R.exec("DELETE FROM monitor");

        const [t2] = await R.knex("network_category").insert({ name: "Terminal 2", parent_id: null });
        const [lobi] = await R.knex("network_category").insert({ name: "Lobi", parent_id: t2 });
        const [gate] = await R.knex("network_category").insert({ name: "Gate", parent_id: t2 });
        // A long interval, so that the time between two beats is counted whole
        const devices = [
            { id: 1, ip: "10.0.0.1", label: "Kamera A", cat: t2, sub: lobi },
            { id: 2, ip: "10.0.0.2", label: "Kamera B", cat: t2, sub: lobi },
            { id: 3, ip: "10.0.0.3", label: "Switch", cat: t2, sub: gate },
            { id: 4, ip: "10.0.0.4", label: null, cat: null, sub: null },
            { id: 5, ip: "10.0.0.5", label: "Belum dimonitor", cat: t2, sub: null, monitored: false },
        ];
        for (const d of devices) {
            if (d.monitored !== false) {
                await R.exec(
                    "INSERT INTO monitor (id, name, type, hostname, interval, retry_interval, user_id, active) VALUES (?, ?, 'ping', ?, 5000000, 5000000, ?, 1)",
                    [d.id, d.ip, d.ip, USER_ID]
                );
            }
            await R.knex("network_device").insert({
                ip: d.ip,
                label: d.label,
                detected_via: "ping",
                first_seen: "2026-09-01 00:00:00",
                last_seen: "2026-09-01 00:00:00",
                is_online: 1,
                category_id: d.cat,
                subcategory_id: d.sub,
                monitor_id: d.monitored === false ? null : d.id,
            });
        }
        // Kamera A: down for half a day on the 10th; Kamera B: always up; Switch: down from the 20th on
        await beat(1, UP, local(9, 1));
        await beat(1, DOWN, local(9, 10), "Ping gagal");
        await beat(1, UP, local(9, 10, 12));
        await beat(2, UP, local(9, 1));
        await beat(3, UP, local(9, 1));
        await beat(3, DOWN, local(9, 20), "Tidak ada jawaban");
        await stat(1, Date.parse("2026-09-15T12:00:00Z") / 1000, 20, 10, 50, 100);
        await stat(2, Date.parse("2026-09-15T12:00:00Z") / 1000, 40, 30, 80, 300);
    });

    test("adds up the month per category and sub category", async () => {
        const r = await report.getMonthlyReport({ month: "2026-09", now: NOW });
        assert.equal(r.label, "September 2026");
        assert.equal(r.partial, false);
        assert.equal(r.devices.length, 4, "the device without a monitor is not in the report");

        assert.deepEqual(
            r.groups.map((g) => [g.name, g.total.devices, g.subs.map((s) => s.name)]),
            [
                ["Terminal 2", 3, ["Gate", "Lobi"]],
                ["", 1, []],
            ]
        );
        const t2 = r.groups[0];
        assert.equal(t2.total.downCount, 2);
        assert.equal(t2.total.downSeconds, 12 * 3600 + 11 * 86400);
        assert.ok(Math.abs(t2.total.uptimePercent - (78.5 / 90) * 100) < 1e-9);

        const lobi = t2.subs[1];
        assert.equal(lobi.devices, 2);
        assert.equal(lobi.downCount, 1);
        assert.ok(Math.abs(lobi.uptimePercent - (59.5 / 60) * 100) < 1e-9);
        assert.equal(lobi.pingAvg, 35);
        assert.equal(lobi.pingMin, 10);
        assert.equal(lobi.pingMax, 80);

        const gate = t2.subs[0];
        assert.equal(gate.downSeconds, 11 * 86400);
        assert.equal(gate.pingAvg, null);

        const none = r.groups[1].total;
        assert.equal(none.uptimePercent, null, "no beats: no uptime to show");
        assert.equal(none.downCount, 0);
    });

    test("lists the down events with the device and its message, oldest first", async () => {
        const r = await report.getMonthlyReport({ month: "2026-09", now: NOW });
        assert.deepEqual(
            r.events.map((e) => [e.name, e.subcategory, e.start, e.end, e.seconds, e.msg]),
            [
                ["Kamera A", "Lobi", local(9, 10), local(9, 10, 12), 43200, "Ping gagal"],
                ["Switch", "Gate", local(9, 20), local(10, 1), 11 * 86400, "Tidak ada jawaban"],
            ]
        );
    });

    test("the month in progress stops at the current time and is marked as partial", async () => {
        const now = local(9, 12, 12);
        const r = await report.getMonthlyReport({ month: "2026-09", now });
        assert.equal(r.partial, true);
        assert.equal(r.effectiveTo, now);
        const a = r.devices.find((d) => d.name === "Kamera A");
        assert.equal(a.downCount, 1);
        assert.equal(a.upSeconds, 9 * 86400 + 2 * 86400);
    });

    test("refuses a month that has not started and a month that is not valid", async () => {
        await assert.rejects(() => report.getMonthlyReport({ month: "2026-11", now: NOW }), /belum dimulai/);
        await assert.rejects(() => report.getMonthlyReport({ month: "x", now: NOW }), /Bulan tidak valid/);
    });

    test("the sheets of the Excel file hold the figures and read back", async () => {
        const file = await report.buildMonthlyReport({ month: "2026-09", now: NOW });
        assert.equal(file.filename, "laporan-jaringan-2026-09.xlsx");
        assert.equal(file.devices, 4);
        const { readSheet } = await import("read-excel-file/node");

        const summary = await readSheet(file.buffer, "Ringkasan");
        assert.deepEqual(summary[0].slice(0, 5), [
            "Kategori",
            "Sub kategori",
            "Jumlah perangkat",
            "Uptime (%)",
            "Jumlah down",
        ]);
        const t2 = summary.find((r) => r[0] === "Terminal 2" && r[1] === "(semua)");
        assert.deepEqual([t2[2], t2[3], t2[4], t2[5]], [3, 87.22, 2, "11 hari 12 jam"]);
        const lobi = summary.find((r) => r[1] === "Lobi");
        assert.deepEqual([lobi[0], lobi[2], lobi[3], lobi[7]], ["Terminal 2", 2, 99.17, 35]);
        assert.ok(summary.some((r) => r[0] === "(tanpa kategori)"));
        assert.equal(summary[summary.length - 1][0], "SEMUA PERANGKAT");

        const perDevice = await readSheet(file.buffer, "Per perangkat");
        assert.equal(perDevice.length, 5);
        const camera = perDevice.find((r) => r[3] === "Kamera A");
        assert.deepEqual(
            [camera[0], camera[1], camera[2], camera[4], camera[5], camera[7]],
            ["Terminal 2", "Lobi", "10.0.0.1", 98.33, 1, 720]
        );

        const events = await readSheet(file.buffer, "Kejadian down");
        assert.equal(events.length, 3);
        assert.equal(events[1][3], "Kamera A");
        assert.equal(events[1][8], "Ping gagal");
        assert.equal(events[1][4], dayjs(local(9, 10)).format("YYYY-MM-DD HH:mm:ss"));

        const info = await readSheet(file.buffer, "Info");
        assert.equal(info[0][0], "Laporan jaringan September 2026");
    });

    test("saveReport writes the file in the folder, replaces it, and leaves no temporary file", async () => {
        const folder = path.join(tmp, "a", "b");
        const first = await reportSchedule.saveReport({ month: "2026-09", folder, now: NOW });
        assert.equal(first.file, path.join(folder, "laporan-jaringan-2026-09.xlsx"));
        assert.equal(first.devices, 4);
        await reportSchedule.saveReport({ month: "2026-09", folder, now: NOW });
        assert.deepEqual(fs.readdirSync(folder), ["laporan-jaringan-2026-09.xlsx"]);
        assert.equal(fs.readFileSync(first.file).subarray(0, 2).toString(), "PK");
    });

    test("saveSchedule stores the settings and refuses a folder that cannot be written", async () => {
        const folder = path.join(tmp, "saved");
        const saved = await reportSchedule.saveSchedule({ enabled: true, folder, hour: 6 }, dataDir);
        assert.deepEqual(saved, { enabled: true, folder, hour: 6 });
        assert.deepEqual(await reportSchedule.getSchedule(), saved);
        assert.ok(fs.existsSync(folder));

        const blocker = path.join(tmp, "blocker");
        fs.writeFileSync(blocker, "x");
        await assert.rejects(
            () => reportSchedule.saveSchedule({ enabled: true, folder: path.join(blocker, "sub"), hour: 6 }, dataDir),
            /Folder tidak bisa ditulis/
        );
        // Switched off, the folder is not checked
        const off = await reportSchedule.saveSchedule(
            { enabled: false, folder: path.join(blocker, "sub"), hour: 6 },
            dataDir
        );
        assert.equal(off.enabled, false);
    });

    describe("the automatic report", () => {
        let folder;
        beforeEach(async () => {
            reportSchedule.stopScheduler();
            folder = fs.mkdtempSync(path.join(tmp, "auto-"));
            await reportSchedule.saveSchedule({ enabled: true, folder, hour: 7 }, dataDir);
        });

        test("makes last month's report once, from the chosen hour of the first day", async () => {
            assert.equal(await reportSchedule.tick({ dataDir, now: () => local(10, 1, 6, 59) }), null);
            assert.deepEqual(fs.readdirSync(folder), []);

            const made = await reportSchedule.tick({ dataDir, now: () => local(10, 1, 7, 0) });
            assert.equal(made, path.join(folder, "laporan-jaringan-2026-09.xlsx"));
            assert.equal(await reportSchedule.tick({ dataDir, now: () => local(10, 1, 7, 5) }), null);
            assert.equal(await reportSchedule.tick({ dataDir, now: () => local(10, 20, 9, 0) }), null);
            assert.deepEqual(fs.readdirSync(folder), ["laporan-jaringan-2026-09.xlsx"]);
        });

        test("makes it later when the server was off on the first, and does nothing when it is switched off", async () => {
            const made = await reportSchedule.tick({ dataDir, now: () => local(10, 3, 15) });
            assert.equal(path.basename(made), "laporan-jaringan-2026-09.xlsx");

            fs.rmSync(made);
            await reportSchedule.saveSchedule({ enabled: false, folder, hour: 7 }, dataDir);
            assert.equal(await reportSchedule.tick({ dataDir, now: () => local(10, 3, 15) }), null);
            assert.deepEqual(fs.readdirSync(folder), []);
        });

        test("after a failure it waits half an hour before it tries again", async () => {
            const blocker = path.join(tmp, "blocker2");
            fs.writeFileSync(blocker, "x");
            const broken = path.join(blocker, "sub");
            await Settings.set("networkReportSchedule", { enabled: true, folder: broken, hour: 7 }, "general");
            assert.equal(await reportSchedule.tick({ dataDir, now: () => local(10, 2, 8, 0) }), null);

            // The problem is solved, but the next try is not due yet
            fs.rmSync(blocker);
            assert.equal(await reportSchedule.tick({ dataDir, now: () => local(10, 2, 8, 10) }), null);
            assert.ok(!fs.existsSync(broken));
            const made = await reportSchedule.tick({ dataDir, now: () => local(10, 2, 8, 31) });
            assert.equal(made, path.join(broken, "laporan-jaringan-2026-09.xlsx"));
        });
    });
});
