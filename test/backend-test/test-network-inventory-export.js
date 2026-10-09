const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
const { R } = require("redbean-node");
// better-auth must load before database (as in server.js): the two modules import each other.
require("../../server/better-auth");
const Database = require("../../server/database");
const { Settings } = require("../../server/settings");
const exporter = require("../../server/network-inventory-export");

const USER_ID = "test-user-1";
const SECRET = "rahasia-community-t2";

describe("inventory export helpers", () => {
    test("describeMonitor turns a monitor into Tipe, Port and Path", () => {
        const d = exporter.describeMonitor;
        assert.deepEqual(d({ type: "ping", port: null, url: null }), { type: "ping", port: "", path: "" });
        assert.deepEqual(d({ type: "http", port: null, url: "http://10.0.0.2:8080/status?x=1" }), {
            type: "http",
            port: 8080,
            path: "/status?x=1",
        });
        assert.deepEqual(d({ type: "http", port: null, url: "http://10.0.0.2/" }), {
            type: "http",
            port: 80,
            path: "",
        });
        assert.deepEqual(d({ type: "http", port: null, url: "https://10.0.0.2/a" }), {
            type: "http",
            port: 443,
            path: "/a",
        });
        assert.deepEqual(d({ type: "http", port: null, url: "not a url" }), { type: "http", port: "", path: "" });
        assert.deepEqual(d({ type: "rtsp", port: 554, url: null }), { type: "rtsp", port: 554, path: "" });
        assert.deepEqual(d({ type: "snmp", port: 161, url: null }), { type: "snmp", port: 161, path: "" });
        assert.deepEqual(d({ type: "dns", port: 53, url: null }), { type: "", port: "", path: "" });
        assert.deepEqual(d(undefined), { type: "", port: "", path: "" });
    });

    test("formatStamp shows the stored UTC time as local time", () => {
        assert.equal(exporter.formatStamp(null), "");
        assert.equal(exporter.formatStamp(""), "");
        assert.equal(
            exporter.formatStamp("2026-09-01 00:00:00"),
            dayjs.utc("2026-09-01 00:00:00").local().format("YYYY-MM-DD HH:mm:ss")
        );
        assert.equal(exporter.formatStamp("rusak"), "rusak");
    });
});

describe("inventory export", () => {
    let dataDir;

    before(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-export-test-"));
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

        const [t2] = await R.knex("network_category").insert({ name: "Terminal 2", parent_id: null });
        const [lobi] = await R.knex("network_category").insert({ name: "Lobi", parent_id: t2 });
        const monitor = (id, type, extra) =>
            R.knex("monitor").insert({
                id,
                name: `m${id}`,
                type,
                hostname: `10.0.0.${id}`,
                interval: 60,
                retry_interval: 60,
                user_id: USER_ID,
                active: 1,
                ...extra,
            });
        await monitor(1, "ping", {});
        await monitor(2, "http", { url: "http://10.0.0.2:8080/status?x=1" });
        await monitor(3, "snmp", { port: 161, radius_password: SECRET });
        await monitor(4, "rtsp", { port: 554 });
        await monitor(6, "dns", { port: 53 });
        const base = { detected_via: "ping", first_seen: "2026-09-01 00:00:00", last_seen: "2026-09-02 10:30:00" };
        const [d3] = await R.knex("network_device").insert({
            ip: "10.0.0.3",
            label: "Switch Core",
            ...base,
            is_online: 1,
            category_id: t2,
            monitor_id: 3,
        });
        for (const device of [
            {
                ip: "10.0.0.1",
                label: "Kamera Lobi",
                mac: "AA:BB:CC:00:00:01",
                vendor: "Hikvision",
                hostname: "cam1",
                ...base,
                is_online: 1,
                category_id: t2,
                subcategory_id: lobi,
                monitor_id: 1,
                depends_on_id: d3,
            },
            { ip: "10.0.0.2", label: "Web", ...base, is_online: 0, monitor_id: 2 },
            { ip: "10.0.0.4", label: null, ...base, is_online: 1, monitor_id: 4, acknowledged: 0 },
            { ip: "10.0.0.5", label: "Belum dimonitor", ...base, is_online: 0 },
            { ip: "10.0.0.6", label: "Monitor lain", ...base, is_online: 1, monitor_id: 6 },
        ]) {
            await R.knex("network_device").insert(device);
        }
    });

    const readAll = async (buffer, sheet) => {
        const { readSheet } = await import("read-excel-file/node");
        return await readSheet(buffer, sheet);
    };

    test("has one row per device, sorted by IP, under a header row with the import columns first", async () => {
        const file = await exporter.buildInventoryExport({ now: new Date(2026, 9, 9, 8, 5).getTime() });
        assert.equal(file.devices, 6);
        assert.equal(file.filename, "inventaris-jaringan-20261009-0805.xlsx");
        const grid = await readAll(file.buffer, "Perangkat");
        assert.deepEqual(grid[0], exporter.HEADERS);
        assert.deepEqual(
            grid.slice(1).map((r) => r[0]),
            ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5", "10.0.0.6"]
        );
        assert.deepEqual(exporter.HEADERS.slice(0, 8), [
            "IP",
            "Nama",
            "Kategori",
            "Sub kategori",
            "Tipe",
            "Port",
            "Path",
            "Community",
        ]);
    });

    test("writes the details of every device", async () => {
        const grid = await readAll((await exporter.buildInventoryExport({})).buffer, "Perangkat");
        const row = (ip) => grid.find((r) => r[0] === ip);
        const cam = row("10.0.0.1");
        assert.deepEqual(cam.slice(1, 8), ["Kamera Lobi", "Terminal 2", "Lobi", "ping", null, null, null]);
        assert.deepEqual(cam.slice(8, 12), ["AA:BB:CC:00:00:01", "Hikvision", "cam1", "online"]);
        assert.equal(cam[13], dayjs.utc("2026-09-02 10:30:00").local().format("YYYY-MM-DD HH:mm:ss"));
        assert.deepEqual(cam.slice(14), ["Ya", "Switch Core", null]);

        const web = row("10.0.0.2");
        assert.deepEqual(web.slice(4, 7), ["http", 8080, "/status?x=1"]);
        assert.equal(web[11], "offline");

        assert.deepEqual(row("10.0.0.3").slice(4, 6), ["snmp", 161]);
        const rtsp = row("10.0.0.4");
        assert.deepEqual(rtsp.slice(4, 6), ["rtsp", 554]);
        assert.equal(rtsp[16], "Ya", "an unacknowledged device is marked as unknown");
        assert.equal(rtsp[1], null, "no label stays empty, the IP is not copied into the name");

        const none = row("10.0.0.5");
        assert.deepEqual([none[4], none[5], none[14]], [null, null, "Tidak"]);
        assert.deepEqual([row("10.0.0.6")[4], row("10.0.0.6")[14]], [null, "Ya"], "a monitor of another kind");
    });

    test("never writes the SNMP community, in any cell of any sheet", async () => {
        const file = await exporter.buildInventoryExport({});
        for (const sheet of ["Perangkat", "Info"]) {
            const grid = await readAll(file.buffer, sheet);
            assert.ok(!JSON.stringify(grid).includes(SECRET), sheet);
            assert.ok(!JSON.stringify(grid).includes("radius"), sheet);
        }
        const grid = await readAll(file.buffer, "Perangkat");
        assert.ok(
            grid.slice(1).every((r) => !r[7]),
            "the Community column is empty"
        );
    });

    test("an exported file can be imported again by the import parser", async () => {
        const { parseImportRows } = await import("../../src/network-import-parse.js");
        const grid = await readAll((await exporter.buildInventoryExport({})).buffer, "Perangkat");
        const { items, error } = parseImportRows(grid);
        assert.equal(error, null);
        assert.equal(items.length, 6);
        const byIp = new Map(items.map((i) => [i.ip, i]));
        assert.deepEqual(
            { ...byIp.get("10.0.0.2"), row: undefined },
            {
                row: undefined,
                ip: "10.0.0.2",
                name: "Web",
                category: "",
                subcategory: "",
                type: "http",
                port: "8080",
                path: "/status?x=1",
                community: "",
            }
        );
        assert.equal(byIp.get("10.0.0.1").category, "Terminal 2");
        assert.equal(byIp.get("10.0.0.1").subcategory, "Lobi");
        assert.equal(byIp.get("10.0.0.5").type, "");
    });

    test("an empty inventory still gives a file with only the header row", async () => {
        await R.exec("DELETE FROM network_device");
        const file = await exporter.buildInventoryExport({});
        assert.equal(file.devices, 0);
        const grid = await readAll(file.buffer, "Perangkat");
        assert.equal(grid.length, 1);
    });
});
