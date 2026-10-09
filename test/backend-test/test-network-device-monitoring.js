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
const { addDevicesToMonitoring } = require("../../server/network-device-monitoring");

const NOW = new Date("2026-10-07T10:00:00Z");
const USER_ID = "test-user-1";

describe("addDevicesToMonitoring", () => {
    let dataDir;
    let calls;
    let deps;

    before(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-network-test-"));
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
        calls = { start: [], notify: [], list: [] };
        deps = {
            startMonitor: async (userID, monitorID) => calls.start.push([userID, monitorID]),
            updateMonitorNotification: async (monitorID, list) => calls.notify.push([monitorID, list]),
            sendUpdateMonitorIntoList: async (monitorID) => calls.list.push(monitorID),
        };
    });

    /**
     * Put devices into the inventory and return them in IP order.
     * @param {object[]} found Scanned devices
     * @returns {Promise<object[]>} Stored devices
     */
    async function seed(found) {
        await store.mergeScan({
            devices: found.map((d) => ({
                mac: null,
                hostname: null,
                vendor: null,
                detectedVia: "ping",
                ...d,
            })),
            scannedIPs: found.map((d) => d.ip),
            complete: true,
            now: NOW,
        });
        return store.listDevices();
    }

    /**
     * @param {object[]} devices Devices to add
     * @param {object} extra Parameter overrides
     * @returns {Promise<object>} Result
     */
    function add(devices, extra = {}) {
        return addDevicesToMonitoring(
            { userID: USER_ID, devices, interval: 30, parent: null, notificationIDList: { 5: true }, ...extra },
            deps
        );
    }

    test("adds a ping monitor", async () => {
        const [device] = await seed([{ ip: "10.0.0.5" }]);
        await store.updateLabel(device.id, "Kamera lobi");

        const result = await add([{ id: device.id, type: "ping" }]);
        assert.deepEqual(result, { added: 1, skipped: 0, failed: [] });

        const monitors = await R.getAll("SELECT * FROM monitor");
        assert.equal(monitors.length, 1);
        const m = monitors[0];
        assert.equal(m.type, "ping");
        assert.equal(m.hostname, "10.0.0.5");
        assert.equal(m.name, "Kamera lobi");
        assert.equal(m.interval, 30);
        assert.equal(m.ping_count, 3);
        assert.equal(Boolean(m.ping_numeric), true);
        assert.equal(m.packet_size, 56);
        assert.equal(m.ping_per_request_timeout, 2);
        assert.equal(m.retry_interval, 60);
        assert.equal(m.resend_interval, 0);
        assert.equal(m.maxretries, 0);
        assert.equal(m.timeout, 10);
        assert.equal(m.user_id, USER_ID);
        assert.equal(m.parent, null);
        assert.equal(m.accepted_statuscodes_json, '["200-299"]');
        assert.equal(m.conditions, "[]");

        assert.equal((await store.listDevices())[0].monitorId, m.id);
        assert.deepEqual(calls.start, [[USER_ID, m.id]]);
        assert.deepEqual(calls.notify, [[m.id, { 5: true }]]);
        assert.deepEqual(calls.list, [m.id]);
    });

    test("name falls back to the hostname and then the IP", async () => {
        const devices = await seed([{ ip: "10.0.0.5", hostname: "printer.lan" }, { ip: "10.0.0.6" }]);
        await add(devices.map((d) => ({ id: d.id, type: "ping" })));
        const names = (await R.getAll("SELECT hostname, name FROM monitor ORDER BY hostname")).map((m) => m.name);
        assert.deepEqual(names, ["printer.lan", "10.0.0.6"]);
    });

    test("adds a port monitor", async () => {
        const [device] = await seed([{ ip: "10.0.0.5" }]);
        const result = await add([{ id: device.id, type: "port", port: "8080" }]);
        assert.deepEqual(result, { added: 1, skipped: 0, failed: [] });

        const m = await R.getRow("SELECT * FROM monitor");
        assert.equal(m.type, "port");
        assert.equal(m.hostname, "10.0.0.5");
        assert.equal(m.port, 8080);
        assert.equal(m.timeout, 48);
    });

    test("skips devices that are already monitored", async () => {
        const [a, b, c] = await seed([{ ip: "10.0.0.1" }, { ip: "10.0.0.2" }, { ip: "10.0.0.3" }]);
        await add([{ id: a.id, type: "ping" }]);
        assert.equal((await R.getAll("SELECT id FROM monitor")).length, 1);

        // Same device again: it already has a monitor.
        const again = await add([{ id: a.id, type: "ping" }]);
        assert.deepEqual(again, { added: 0, skipped: 1, failed: [] });

        // A monitor with the same type and target that was created by hand.
        await R.exec(
            "INSERT INTO monitor (name, type, hostname, interval, retry_interval, user_id) VALUES ('manual', 'ping', '10.0.0.2', 60, 60, ?)",
            [USER_ID]
        );
        const manual = await add([{ id: b.id, type: "ping" }]);
        assert.deepEqual(manual, { added: 0, skipped: 1, failed: [] });
        assert.equal((await R.getAll("SELECT id FROM monitor")).length, 2);

        // A different target (port on an IP that only has a ping monitor) is not a duplicate.
        const other = await add([{ id: c.id, type: "port", port: 22 }]);
        assert.equal(other.added, 1);
    });

    test("reports bad devices per device and keeps going", async () => {
        const [a, b, c, d, e, f] = await seed([
            { ip: "10.0.0.1" },
            { ip: "10.0.0.2" },
            { ip: "10.0.0.3" },
            { ip: "10.0.0.4" },
            { ip: "10.0.0.5" },
            { ip: "10.0.0.6" },
        ]);
        const result = await add([
            { id: 9999, type: "ping" },
            { id: a.id, type: "port", port: 0 },
            { id: b.id, type: "port", port: 70000 },
            { id: c.id, type: "port", port: "80abc" },
            { id: d.id, type: "port" },
            { id: e.id, type: "port", port: "" },
            { id: f.id, type: "banana" },
            { id: f.id, type: "ping" },
        ]);
        assert.equal(result.added, 1);
        assert.equal(result.skipped, 0);
        assert.deepEqual(result.failed, [
            { id: 9999, msg: "Perangkat tidak ditemukan" },
            { id: a.id, msg: "Port tidak valid" },
            { id: b.id, msg: "Port tidak valid" },
            { id: c.id, msg: "Port tidak valid" },
            { id: d.id, msg: "Port tidak valid" },
            { id: e.id, msg: "Port tidak valid" },
            { id: f.id, msg: "Tipe monitor tidak valid" },
        ]);
        assert.equal((await R.getAll("SELECT id FROM monitor")).length, 1);
    });

    test("the same device twice in one call is skipped the second time", async () => {
        const [device] = await seed([{ ip: "10.0.0.5" }]);
        const result = await add([
            { id: device.id, type: "ping" },
            { id: device.id, type: "ping" },
        ]);
        assert.deepEqual(result, { added: 1, skipped: 1, failed: [] });
        assert.equal((await R.getAll("SELECT id FROM monitor")).length, 1);
    });

    test("a failing device leaves no half-made monitor and does not stop the others", async () => {
        const [a, b] = await seed([{ ip: "10.0.0.1" }, { ip: "10.0.0.2" }]);
        deps.updateMonitorNotification = async (monitorID) => {
            if (calls.notify.length === 0) {
                calls.notify.push([monitorID]);
                throw new Error("notification list is broken");
            }
        };
        const result = await add([
            { id: a.id, type: "ping" },
            { id: b.id, type: "ping" },
        ]);
        assert.equal(result.added, 1);
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0].id, a.id);
        assert.match(result.failed[0].msg, /notification list is broken/);

        const monitors = await R.getAll("SELECT hostname FROM monitor");
        assert.deepEqual(
            monitors.map((m) => m.hostname),
            ["10.0.0.2"]
        );
        const devices = await store.listDevices();
        assert.equal(devices[0].monitorId, null);
        assert.notEqual(devices[1].monitorId, null);
    });

    test("an interval below the minimum throws before anything is created", async () => {
        const [device] = await seed([{ ip: "10.0.0.5" }]);
        for (const interval of [0, -5, "abc", NaN, undefined]) {
            await assert.rejects(() => add([{ id: device.id, type: "ping" }], { interval }), /[Ii]nterval/);
        }
        assert.equal((await R.getAll("SELECT id FROM monitor")).length, 0);
        assert.deepEqual(calls.start, []);
    });

    test("deleting the monitor clears the link", async () => {
        const [device] = await seed([{ ip: "10.0.0.5" }]);
        await add([{ id: device.id, type: "ping" }]);
        assert.notEqual((await store.listDevices())[0].monitorId, null);

        await R.exec("DELETE FROM monitor");
        assert.equal((await store.listDevices())[0].monitorId, null);
    });
});

describe("addDevicesToMonitoring socket event", () => {
    test("replies with the summary and refreshes the list", async () => {
        const { networkScanSocketHandler } = require("../../server/socket-handlers/network-scan-socket-handler");
        const handlers = new Map();
        const emitted = [];
        const socket = { userID: 1, session: {}, on: (event, fn) => handlers.set(event, fn) };
        const server = { io: { to: (room) => ({ emit: (event, data) => emitted.push({ room, event, data }) }) } };
        const received = [];
        const monitoring = {
            addDevicesToMonitoring: async (params, deps) => {
                received.push({ params, deps });
                return { added: 2, skipped: 1, failed: [{ id: 3, msg: "x" }] };
            },
        };
        const store = { listDevices: async () => [{ id: 1 }] };
        networkScanSocketHandler(socket, server, {
            startMonitor: async () => {},
            updateMonitorNotification: async () => {},
            monitoring,
            store,
        });

        const payload = { devices: [{ id: 1, type: "ping" }], interval: 60, parent: null, notificationIDList: {} };
        const reply = await new Promise((resolve) => handlers.get("addDevicesToMonitoring")(payload, resolve));
        assert.deepEqual(reply, { ok: true, added: 2, skipped: 1, failed: [{ id: 3, msg: "x" }] });
        assert.equal(received[0].params.userID, 1);
        assert.equal(received[0].params.interval, 60);
        assert.equal(typeof received[0].deps.startMonitor, "function");
        assert.equal(typeof received[0].deps.sendUpdateMonitorIntoList, "function");
        assert.deepEqual(
            emitted.map((e) => e.event),
            ["networkDeviceList"]
        );

        const failing = {
            addDevicesToMonitoring: async () => {
                throw new Error("Interval cannot be less than 1 seconds");
            },
        };
        const handlers2 = new Map();
        networkScanSocketHandler({ ...socket, on: (event, fn) => handlers2.set(event, fn) }, server, {
            startMonitor: async () => {},
            updateMonitorNotification: async () => {},
            monitoring: failing,
            store,
        });
        const bad = await new Promise((resolve) => handlers2.get("addDevicesToMonitoring")(payload, resolve));
        assert.deepEqual(bad, { ok: false, msg: "Interval cannot be less than 1 seconds" });

        const handlers3 = new Map();
        networkScanSocketHandler({ ...socket, session: undefined, on: (e, fn) => handlers3.set(e, fn) }, server, {
            monitoring,
            store,
        });
        const denied = await new Promise((resolve) => handlers3.get("addDevicesToMonitoring")(payload, resolve));
        assert.deepEqual(denied, { ok: false, msg: "You are not logged in." });
    });
});
