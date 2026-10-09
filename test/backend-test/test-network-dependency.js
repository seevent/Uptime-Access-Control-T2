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
const { DOWN, UP, PENDING } = require("../../src/util");
const store = require("../../server/network-device-store");
const dependency = require("../../server/network-dependency");

const USER_ID = "test-user-1";
let beatCounter = 0;

/**
 * @param {number} monitorId Monitor id
 * @param {number} status Status of the beat
 * @returns {Promise<void>}
 */
async function beat(monitorId, status) {
    beatCounter++;
    const time = `2026-10-09 10:${String(Math.floor(beatCounter / 60)).padStart(2, "0")}:${String(beatCounter % 60).padStart(2, "0")}.000`;
    await R.exec(
        "INSERT INTO heartbeat (monitor_id, status, time, msg, important, duration) VALUES (?, ?, ?, 'x', 0, 1)",
        [monitorId, status, time]
    );
}

/**
 * @param {number} ms Milliseconds
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("device dependencies", () => {
    let dataDir;
    // Monitors: 1 switch, 2 camera on the switch, 3 other camera on the camera (chain), 4 router above the switch
    const MON = { router: 4, sw: 1, cam: 2, lens: 3 };
    let ids;
    let sent;
    let held;
    const actions = () => ({
        send: async () => sent.push("self"),
        sendHeldAlert: async (id) => held.push(id),
    });

    before(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuma-dependency-test-"));
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
        dependency.reset();
        Settings.stopCacheCleaner();
        await Database.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        dependency.reset();
        sent = [];
        held = [];
        await Settings.set("networkDependencyGraceSeconds", 0, "general");
        await R.exec("DELETE FROM heartbeat");
        await R.exec("DELETE FROM network_device");
        await R.exec("DELETE FROM monitor");
        for (const [name, id] of Object.entries(MON)) {
            await R.exec(
                "INSERT INTO monitor (id, name, type, hostname, interval, retry_interval, user_id, active) VALUES (?, ?, 'ping', ?, 60, 60, ?, 1)",
                [id, name, `10.0.0.${id}`, USER_ID]
            );
        }
        ids = {};
        for (const [name, id] of Object.entries(MON)) {
            await R.exec(
                `INSERT INTO network_device (ip, detected_via, first_seen, last_seen, is_online, monitor_id)
                 VALUES (?, 'ping', '2026-10-09 10:00:00', '2026-10-09 10:00:00', 1, ?)`,
                [`10.0.0.${id}`, id]
            );
            ids[name] = (await R.getRow("SELECT id FROM network_device WHERE monitor_id = ?", [id])).id;
        }
    });

    describe("store", () => {
        test("sets, changes and clears the dependency of many devices", async () => {
            assert.equal(await store.setDevicesDependency([ids.cam, ids.lens], ids.sw), 2);
            let devices = Object.fromEntries((await store.listDevices()).map((d) => [d.id, d.dependsOnId]));
            assert.equal(devices[ids.cam], ids.sw);
            assert.equal(devices[ids.lens], ids.sw);
            assert.equal(devices[ids.sw], null);

            assert.equal(await store.setDevicesDependency([ids.cam], null), 1);
            devices = Object.fromEntries((await store.listDevices()).map((d) => [d.id, d.dependsOnId]));
            assert.equal(devices[ids.cam], null);
            assert.equal(devices[ids.lens], ids.sw);
        });

        test("refuses a device that depends on itself, a missing parent, and a circle", async () => {
            await assert.rejects(() => store.setDevicesDependency([ids.sw], ids.sw), /dirinya sendiri/);
            await assert.rejects(() => store.setDevicesDependency([ids.sw], 99999), /induk tidak ditemukan/);
            await assert.rejects(() => store.setDevicesDependency([ids.sw], "x"), /induk tidak valid/);
            await store.setDevicesDependency([ids.cam], ids.sw);
            await store.setDevicesDependency([ids.lens], ids.cam);
            await assert.rejects(() => store.setDevicesDependency([ids.sw], ids.lens), /melingkar/);
            await assert.rejects(() => store.setDevicesDependency([ids.sw, ids.router], ids.cam), /melingkar/);
            // Nothing was changed by the refused calls
            const devices = Object.fromEntries((await store.listDevices()).map((d) => [d.id, d.dependsOnId]));
            assert.equal(devices[ids.sw], null);
            assert.equal(devices[ids.router], null);
        });

        test("refuses a wrong list of ids", async () => {
            for (const bad of [undefined, [], [1, 1], ["1"]]) {
                await assert.rejects(() => store.setDevicesDependency(bad, null), /Pilih 1 sampai 2000 perangkat/);
            }
        });

        test("deleting a device clears the dependency of the devices that depended on it", async () => {
            await store.setDevicesDependency([ids.cam], ids.sw);
            assert.equal(await store.deleteDevice(ids.sw), true);
            const cam = (await store.listDevices()).find((d) => d.id === ids.cam);
            assert.equal(cam.dependsOnId, null);
        });
    });

    describe("alerts", () => {
        test("a monitor without a dependency is not touched", async () => {
            await beat(MON.cam, DOWN);
            assert.equal(await dependency.intercept({ id: MON.cam }, { status: DOWN }, actions()), false);
            assert.equal(await dependency.intercept({ id: 999 }, { status: DOWN }, actions()), false);
            assert.equal(await dependency.intercept({ id: MON.cam }, { status: UP }, actions()), false);
            assert.deepEqual(sent, []);
        });

        test("down alert goes out when the device it depends on is up", async () => {
            await store.setDevicesDependency([ids.cam], ids.sw);
            await beat(MON.sw, UP);
            assert.equal(await dependency.intercept({ id: MON.cam }, { status: DOWN }, actions()), true);
            assert.deepEqual(sent, ["self"]);
            assert.equal(dependency.isHeldBack(MON.cam), false);
        });

        test("down alert is held back while the device it depends on is down, also further up the chain", async () => {
            await store.setDevicesDependency([ids.cam], ids.sw);
            await store.setDevicesDependency([ids.lens], ids.cam);
            await store.setDevicesDependency([ids.sw], ids.router);
            await beat(MON.router, DOWN);
            await beat(MON.sw, UP);
            await beat(MON.cam, UP);

            assert.equal(await dependency.intercept({ id: MON.lens }, { status: DOWN }, actions()), true);
            assert.deepEqual(sent, []);
            assert.equal(dependency.isHeldBack(MON.lens), true);

            // A repeated down alert (resend interval) stays held back too
            assert.equal(await dependency.intercept({ id: MON.lens }, { status: DOWN }, actions()), true);
            assert.deepEqual(sent, []);
        });

        test("a paused device it depends on does not hold alerts back", async () => {
            await store.setDevicesDependency([ids.cam], ids.sw);
            await beat(MON.sw, DOWN);
            await R.exec("UPDATE monitor SET active = 0 WHERE id = ?", [MON.sw]);
            assert.equal(await dependency.intercept({ id: MON.cam }, { status: DOWN }, actions()), true);
            assert.deepEqual(sent, ["self"]);
        });

        test("the up alert of a held back device is swallowed, the next down alert is normal", async () => {
            await store.setDevicesDependency([ids.cam], ids.sw);
            await beat(MON.sw, DOWN);
            await dependency.intercept({ id: MON.cam }, { status: DOWN }, actions());
            assert.equal(dependency.isHeldBack(MON.cam), true);

            assert.equal(await dependency.intercept({ id: MON.cam }, { status: UP }, actions()), true);
            assert.equal(dependency.isHeldBack(MON.cam), false);
            assert.equal(await dependency.intercept({ id: MON.cam }, { status: UP }, actions()), false);
        });

        test("when the device it depends on is up again and the device is still down, its alert goes out", async () => {
            await store.setDevicesDependency([ids.cam], ids.sw);
            await store.setDevicesDependency([ids.lens], ids.cam);
            await beat(MON.sw, DOWN);
            await beat(MON.cam, DOWN);
            await beat(MON.lens, DOWN);
            await dependency.intercept({ id: MON.cam }, { status: DOWN }, actions());
            await dependency.intercept({ id: MON.lens }, { status: DOWN }, actions());
            assert.deepEqual([dependency.isHeldBack(MON.cam), dependency.isHeldBack(MON.lens)], [true, true]);

            // The switch comes back: the camera is still down and gets its alert, the lens waits for the camera
            await beat(MON.sw, UP);
            assert.equal(await dependency.intercept({ id: MON.sw }, { status: UP }, actions()), false);
            assert.deepEqual(held, [MON.cam]);
            assert.equal(dependency.isHeldBack(MON.cam), false);
            assert.equal(dependency.isHeldBack(MON.lens), true);

            // The camera comes back: now the lens (still down) gets its alert
            await beat(MON.cam, UP);
            assert.equal(await dependency.intercept({ id: MON.cam }, { status: UP }, actions()), false);
            assert.deepEqual(held, [MON.cam, MON.lens]);
        });

        test("a held back device that recovered by itself gets no alert when the parent recovers", async () => {
            await store.setDevicesDependency([ids.cam], ids.sw);
            await beat(MON.sw, DOWN);
            await dependency.intercept({ id: MON.cam }, { status: DOWN }, actions());
            await beat(MON.cam, UP);
            // Its own up beat goes through the same check, and is swallowed because the down alert never went out
            assert.equal(await dependency.intercept({ id: MON.cam }, { status: UP }, actions()), true);
            await beat(MON.sw, UP);
            await dependency.intercept({ id: MON.sw }, { status: UP }, actions());
            assert.deepEqual(held, []);
        });

        test("waits for the grace period: the device it depends on may be found down a moment later", async () => {
            await Settings.set("networkDependencyGraceSeconds", 1, "general");
            await store.setDevicesDependency([ids.cam], ids.sw);
            await beat(MON.sw, UP);
            await beat(MON.cam, DOWN);
            assert.equal(await dependency.intercept({ id: MON.cam }, { status: DOWN }, actions()), true);
            assert.deepEqual(sent, [], "nothing is sent right away");

            await beat(MON.sw, DOWN);
            await sleep(1300);
            assert.deepEqual(sent, [], "the switch went down meanwhile");
            assert.equal(dependency.isHeldBack(MON.cam), true);
        });

        test("waits for the grace period and then sends when the device it depends on stays up", async () => {
            await Settings.set("networkDependencyGraceSeconds", 1, "general");
            await store.setDevicesDependency([ids.cam], ids.sw);
            await beat(MON.sw, UP);
            await beat(MON.cam, DOWN);
            await dependency.intercept({ id: MON.cam }, { status: DOWN }, actions());
            await sleep(1300);
            assert.deepEqual(sent, ["self"]);
        });

        test("a device that is up again within the grace period sends nothing, not even the up alert", async () => {
            await Settings.set("networkDependencyGraceSeconds", 1, "general");
            await store.setDevicesDependency([ids.cam], ids.sw);
            await beat(MON.sw, UP);
            await beat(MON.cam, DOWN);
            await dependency.intercept({ id: MON.cam }, { status: DOWN }, actions());
            await beat(MON.cam, UP);
            assert.equal(await dependency.intercept({ id: MON.cam }, { status: UP }, actions()), true);
            await sleep(1300);
            assert.deepEqual(sent, []);
        });

        test("a pending check (retries) of the device it depends on is not down", async () => {
            await store.setDevicesDependency([ids.cam], ids.sw);
            await beat(MON.sw, PENDING);
            assert.equal(await dependency.intercept({ id: MON.cam }, { status: DOWN }, actions()), true);
            assert.deepEqual(sent, ["self"]);
        });
    });
});
