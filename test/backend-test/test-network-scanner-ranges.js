const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { expandRanges, getLocalSubnets, ScanInputError, MAX_HOSTS } = require("../../server/network-scanner");

describe("expandRanges", () => {
    test("expands a /30 to its two host addresses", () => {
        assert.deepEqual(expandRanges(["192.168.1.0/30"]), ["192.168.1.1", "192.168.1.2"]);
    });

    test("accepts a single IP", () => {
        assert.deepEqual(expandRanges(["10.0.0.5"]), ["10.0.0.5"]);
    });

    test("accepts both range forms", () => {
        const expected = ["10.0.0.10", "10.0.0.11", "10.0.0.12"];
        assert.deepEqual(expandRanges(["10.0.0.10-12"]), expected);
        assert.deepEqual(expandRanges(["10.0.0.10-10.0.0.12"]), expected);
    });

    test("removes duplicates across inputs", () => {
        assert.deepEqual(expandRanges(["10.0.0.1", "10.0.0.0/30"]), ["10.0.0.1", "10.0.0.2"]);
    });

    test("handles /32 and /31", () => {
        assert.deepEqual(expandRanges(["10.0.0.7/32"]), ["10.0.0.7"]);
        assert.deepEqual(expandRanges(["10.0.0.6/31"]), ["10.0.0.6", "10.0.0.7"]);
    });

    test("rejects huge ranges without allocating", () => {
        const started = Date.now();
        for (const input of ["10.0.0.0/8", "0.0.0.0/0"]) {
            assert.throws(
                () => expandRanges([input]),
                (e) => e instanceof ScanInputError && e.code === "TOO_MANY_HOSTS"
            );
        }
        assert.throws(
            () => expandRanges(["10.0.0.0/24"], { maxHosts: 100 }),
            (e) => e instanceof ScanInputError && e.code === "TOO_MANY_HOSTS"
        );
        assert.ok(Date.now() - started < 100, "must reject before enumerating addresses");
        assert.equal(MAX_HOSTS, 4096);
    });

    test("skips non-scannable addresses", () => {
        assert.deepEqual(expandRanges(["127.0.0.0/30"]), []);
        assert.deepEqual(expandRanges(["224.0.0.1"]), []);
        assert.deepEqual(expandRanges(["169.254.1.1"]), []);
    });

    test("cleans messy input", () => {
        assert.deepEqual(expandRanges(["  10.0.0.1 \r", "", "10.0.0.2,10.0.0.3"]), [
            "10.0.0.1",
            "10.0.0.2",
            "10.0.0.3",
        ]);
    });

    test("rejects invalid tokens", () => {
        for (const token of ["10.0.0.256", "10.0.0", "abc", "10.0.0.0/33", "10.0.0.5-10.0.0.1", "192.168.01.5"]) {
            assert.throws(
                () => expandRanges([token]),
                (e) => e instanceof ScanInputError && e.code === "INVALID_RANGE" && e.message.includes(token),
                token
            );
        }
    });

    test("rejects empty input", () => {
        for (const input of [[], ["", "  "]]) {
            assert.throws(
                () => expandRanges(input),
                (e) => e instanceof ScanInputError && e.code === "EMPTY_INPUT"
            );
        }
    });
});

describe("getLocalSubnets", () => {
    test("returns the IPv4 subnets of non-internal interfaces", () => {
        const interfaces = {
            eth0: [
                { family: "IPv4", address: "192.168.1.20", netmask: "255.255.255.0", internal: false },
                { family: "IPv6", address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", internal: false },
            ],
            lo: [{ family: "IPv4", address: "127.0.0.1", netmask: "255.0.0.0", internal: true }],
            eth1: [{ family: 4, address: "10.1.2.3", netmask: "255.255.0.0", internal: false }],
            tun0: [{ family: "IPv4", address: "10.9.9.9", netmask: "255.255.255.255", internal: false }],
        };
        assert.deepEqual(getLocalSubnets(interfaces), ["192.168.1.0/24", "10.1.0.0/16"]);
    });
});
