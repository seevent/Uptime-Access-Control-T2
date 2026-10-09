const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { ScanToolError, scan, cleanHostname, resolveHostname } = require("../../server/network-scanner");

/**
 * Build the injectable parts of scan() so tests never touch the real network, ARP table or DNS.
 * @param {object} overrides Options that replace the defaults
 * @returns {object} Options for scan()
 */
function options(overrides = {}) {
    return {
        probe: async () => false,
        readArp: async () => new Map(),
        resolveHostname: async () => null,
        lookupVendor: () => null,
        ...overrides,
    };
}

describe("scan", () => {
    test("returns only responding IPs sorted numerically", async () => {
        const alive = new Set(["10.0.0.2", "10.0.0.10", "10.0.0.9"]);
        const result = await scan(
            options({
                ips: ["10.0.0.10", "10.0.0.2", "10.0.0.9", "10.0.0.3"],
                probe: async (ip) => alive.has(ip),
            })
        );
        assert.deepEqual(
            result.devices.map((d) => d.ip),
            ["10.0.0.2", "10.0.0.9", "10.0.0.10"]
        );
        assert.ok(result.devices.every((d) => d.detectedVia === "ping"));
        assert.equal(result.completed, true);
        assert.equal(result.total, 4);
    });

    test("never exceeds the concurrency limit", async () => {
        let inFlight = 0;
        let max = 0;
        const ips = Array.from({ length: 200 }, (_, i) => `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`);
        await scan(
            options({
                ips,
                concurrency: 8,
                probe: async () => {
                    inFlight++;
                    max = Math.max(max, inFlight);
                    await new Promise((resolve) => setTimeout(resolve, 1));
                    inFlight--;
                    return false;
                },
            })
        );
        assert.ok(max > 1, "should run probes in parallel");
        assert.ok(max <= 8, `max in flight was ${max}`);
    });

    test("throttles progress and always reports the final state", async () => {
        const calls = [];
        const ips = Array.from({ length: 50 }, (_, i) => `10.0.0.${i + 1}`);
        await scan(
            options({
                ips,
                progressIntervalMs: 1000,
                onProgress: (p) => calls.push(p),
                probe: async (ip) => ip === "10.0.0.5",
            })
        );
        assert.ok(calls.length <= 2, `got ${calls.length} progress calls`);
        assert.deepEqual(calls[calls.length - 1], { done: 50, total: 50, found: 1 });
    });

    test("stops queueing after abort and skips ARP and DNS", async () => {
        const controller = new AbortController();
        const ips = Array.from({ length: 200 }, (_, i) => `10.0.0.${i + 1}`);
        let probes = 0;
        let arpCalls = 0;
        let dnsCalls = 0;
        const result = await scan(
            options({
                ips,
                concurrency: 4,
                signal: controller.signal,
                probe: async () => {
                    probes++;
                    if (probes === 20) {
                        controller.abort();
                    }
                    await new Promise((resolve) => setTimeout(resolve, 1));
                    return true;
                },
                readArp: async () => {
                    arpCalls++;
                    return new Map();
                },
                resolveHostname: async () => {
                    dnsCalls++;
                    return null;
                },
            })
        );
        assert.equal(result.completed, false);
        assert.ok(probes <= 24, `probed ${probes} addresses after abort`);
        assert.ok(result.devices.length > 0 && result.devices.length <= probes);
        assert.equal(arpCalls, 0);
        assert.equal(dnsCalls, 0);
    });

    test("adds ARP-only devices inside the scanned IPs", async () => {
        const result = await scan(
            options({
                ips: ["10.0.0.1", "10.0.0.2"],
                probe: async (ip) => ip === "10.0.0.1",
                readArp: async () =>
                    new Map([
                        ["10.0.0.1", "AA:BB:CC:00:00:01"],
                        ["10.0.0.2", "AA:BB:CC:00:00:02"],
                        ["10.9.9.9", "AA:BB:CC:00:00:03"],
                    ]),
                lookupVendor: (mac) => (mac ? "Vendor" : null),
            })
        );
        assert.deepEqual(result.devices, [
            { ip: "10.0.0.1", mac: "AA:BB:CC:00:00:01", hostname: null, vendor: "Vendor", detectedVia: "ping" },
            { ip: "10.0.0.2", mac: "AA:BB:CC:00:00:02", hostname: null, vendor: "Vendor", detectedVia: "arp" },
        ]);
        assert.equal(result.arpAvailable, true);
    });

    test("works without ARP", async () => {
        const result = await scan(
            options({
                ips: ["10.0.0.1"],
                probe: async () => true,
                readArp: async () => null,
                lookupVendor: (mac) => (mac ? "Vendor" : null),
            })
        );
        assert.equal(result.arpAvailable, false);
        assert.deepEqual(result.devices, [
            { ip: "10.0.0.1", mac: null, hostname: null, vendor: null, detectedVia: "ping" },
        ]);
    });

    test("survives hostname failures and fills hostnames", async () => {
        const result = await scan(
            options({
                ips: ["10.0.0.1", "10.0.0.2"],
                probe: async () => true,
                resolveHostname: async (ip) => {
                    if (ip === "10.0.0.1") {
                        throw new Error("dns down");
                    }
                    return "printer.lan";
                },
            })
        );
        assert.deepEqual(
            result.devices.map((d) => d.hostname),
            [null, "printer.lan"]
        );
    });

    test("propagates tool errors without a partial result", async () => {
        const failure = new ScanToolError("PING_UNAVAILABLE", "ping missing");
        await assert.rejects(
            () =>
                scan(
                    options({
                        ips: ["10.0.0.1", "10.0.0.2"],
                        probe: async () => {
                            throw failure;
                        },
                    })
                ),
            (e) => e === failure
        );
    });
});

describe("cleanHostname", () => {
    test("removes the trailing dot, empties and over-long names", () => {
        assert.equal(cleanHostname("host.lan."), "host.lan");
        assert.equal(cleanHostname(""), null);
        assert.equal(cleanHostname(undefined), null);
        assert.equal(cleanHostname("a".repeat(300)).length, 255);
    });
});

describe("resolveHostname", () => {
    test("returns the first reverse DNS name, cleaned", async () => {
        const reverse = async () => ["printer.lan.", "other"];
        assert.equal(await resolveHostname("10.0.0.1", { reverse }), "printer.lan");
    });

    test("returns null when reverse DNS fails", async () => {
        const reverse = async () => {
            throw new Error("ENOTFOUND");
        };
        assert.equal(await resolveHostname("10.0.0.1", { reverse }), null);
    });

    test("returns null when reverse DNS never answers", async () => {
        const reverse = () => new Promise(() => {});
        assert.equal(await resolveHostname("10.0.0.1", { reverse, timeoutMs: 20 }), null);
    });
});
