const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
    ScanToolError,
    buildPingCommand,
    isPingSuccess,
    pingHost,
    normalizeMac,
    parseArpTable,
    readArpTable,
    lookupVendor,
} = require("../../server/network-scanner");
const { parseOuiCsv } = require("../../extra/update-oui");

const WINDOWS_ARP = `
Interface: 192.168.1.20 --- 0x7
  Internet Address      Physical Address      Type
  192.168.1.1           aa-bb-cc-dd-ee-01     dynamic
  192.168.1.255         ff-ff-ff-ff-ff-ff     static
  224.0.0.22            01-00-5e-00-00-16     static
`;

const LINUX_NEIGH = `
192.168.1.1 dev eth0 lladdr aa:bb:cc:dd:ee:01 REACHABLE
192.168.1.50 dev eth0  FAILED
192.168.1.51 dev eth0  INCOMPLETE
fe80::1 dev eth0 lladdr aa:bb:cc:dd:ee:02 router STALE
`;

const LINUX_ARP_AN = `
? (192.168.1.1) at aa:bb:cc:dd:ee:01 [ether] on eth0
? (192.168.1.60) at <incomplete> on eth0
`;

const ONE_ENTRY = new Map([["192.168.1.1", "AA:BB:CC:DD:EE:01"]]);

describe("buildPingCommand", () => {
    test("builds the Windows command (timeout in milliseconds)", () => {
        assert.deepEqual(buildPingCommand("10.0.0.5", 1000, "win32"), {
            file: "ping",
            args: ["-n", "1", "-w", "1000", "10.0.0.5"],
        });
    });

    test("builds the Linux command (timeout in whole seconds, rounded up)", () => {
        assert.deepEqual(buildPingCommand("10.0.0.5", 1000, "linux").args, ["-c", "1", "-W", "1", "10.0.0.5"]);
        assert.deepEqual(buildPingCommand("10.0.0.5", 1500, "linux").args, ["-c", "1", "-W", "2", "10.0.0.5"]);
    });

    test("builds the macOS command (timeout in milliseconds)", () => {
        assert.deepEqual(buildPingCommand("10.0.0.5", 1000, "darwin").args, ["-c", "1", "-W", "1000", "10.0.0.5"]);
    });
});

describe("isPingSuccess", () => {
    test("accepts a localized Windows reply", () => {
        const stdout = "Balasan dari 192.168.1.10: byte=32 waktu<1ms TTL=128";
        assert.equal(isPingSuccess({ platform: "win32", exitCode: 0, stdout }), true);
    });

    test("rejects a Windows unreachable reply even with exit code 0", () => {
        const stdout = "Reply from 192.168.1.1: Destination host unreachable.";
        assert.equal(isPingSuccess({ platform: "win32", exitCode: 0, stdout }), false);
    });

    test("rejects a Windows timeout", () => {
        assert.equal(isPingSuccess({ platform: "win32", exitCode: 1, stdout: "Request timed out." }), false);
    });

    test("uses the exit code on Linux", () => {
        assert.equal(isPingSuccess({ platform: "linux", exitCode: 0, stdout: "" }), true);
        assert.equal(isPingSuccess({ platform: "linux", exitCode: 1, stdout: "" }), false);
        assert.equal(isPingSuccess({ platform: "linux", exitCode: 2, stdout: "" }), false);
    });
});

describe("normalizeMac", () => {
    test("normalizes dash and colon separated MACs", () => {
        assert.equal(normalizeMac("aa-bb-cc-dd-ee-01"), "AA:BB:CC:DD:EE:01");
        assert.equal(normalizeMac("aa:bb:cc:dd:ee:01"), "AA:BB:CC:DD:EE:01");
        assert.equal(normalizeMac("0:1c:b3:9:85:15"), "00:1C:B3:09:85:15");
    });

    test("rejects null, broadcast, multicast and malformed values", () => {
        for (const raw of ["00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff", "01-00-5e-00-00-16", "zz", ""]) {
            assert.equal(normalizeMac(raw), null, raw);
        }
    });
});

describe("parseArpTable", () => {
    test("parses Windows arp -a and ignores broadcast and multicast rows", () => {
        assert.deepEqual(parseArpTable(WINDOWS_ARP, "win32"), ONE_ENTRY);
    });

    test("parses Linux ip neigh and ignores failed, incomplete and IPv6 rows", () => {
        assert.deepEqual(parseArpTable(LINUX_NEIGH, "linux"), ONE_ENTRY);
    });

    test("parses arp -an and ignores incomplete rows", () => {
        assert.deepEqual(parseArpTable(LINUX_ARP_AN, "linux"), ONE_ENTRY);
    });
});

describe("lookupVendor", () => {
    const table = { AABBCC: "Contoh Vendor" };

    test("finds a vendor by OUI prefix", () => {
        assert.equal(lookupVendor("AA:BB:CC:DD:EE:01", table), "Contoh Vendor");
    });

    test("returns null for unknown prefixes and missing MACs", () => {
        assert.equal(lookupVendor("11:22:33:44:55:66", table), null);
        assert.equal(lookupVendor(null, table), null);
    });
});

describe("parseOuiCsv", () => {
    test("parses IEEE CSV rows including quoted names", () => {
        const csv = [
            "Registry,Assignment,Organization Name,Organization Address",
            'MA-L,AABBCC,"Example, Inc.",Somewhere',
            "MA-L,001122,Plain Name,Elsewhere",
            "",
        ].join("\r\n");
        assert.deepEqual(parseOuiCsv(csv), { AABBCC: "Example, Inc.", "001122": "Plain Name" });
    });
});

describe("pingHost", () => {
    test("returns true when the reply is accepted", async () => {
        const run = async () => ({ exitCode: 0, stdout: "Reply from 10.0.0.5: bytes=32 time<1ms TTL=64" });
        assert.equal(await pingHost("10.0.0.5", { platform: "win32", run }), true);
    });

    test("returns false when the host does not answer", async () => {
        const run = async () => ({ exitCode: 1, stdout: "Request timed out." });
        assert.equal(await pingHost("10.0.0.5", { platform: "win32", run }), false);
    });

    test("throws ScanToolError when the ping binary is missing", async () => {
        const run = async () => {
            throw Object.assign(new Error("spawn ping ENOENT"), { code: "ENOENT" });
        };
        await assert.rejects(
            () => pingHost("10.0.0.5", { platform: "linux", run }),
            (e) => e instanceof ScanToolError && e.code === "PING_UNAVAILABLE"
        );
    });
});

describe("readArpTable", () => {
    test("returns null when no ARP command works", async () => {
        const run = async () => {
            throw Object.assign(new Error("not found"), { code: "ENOENT" });
        };
        assert.equal(await readArpTable({ platform: "linux", run }), null);
    });

    test("falls back to arp -an on Linux when ip neigh fails", async () => {
        const run = async (file) => {
            if (file === "ip") {
                throw Object.assign(new Error("not found"), { code: "ENOENT" });
            }
            return { exitCode: 0, stdout: LINUX_ARP_AN };
        };
        assert.deepEqual(await readArpTable({ platform: "linux", run }), ONE_ENTRY);
    });

    test("uses arp -a on Windows", async () => {
        const calls = [];
        const run = async (file, args) => {
            calls.push([file, ...args]);
            return { exitCode: 0, stdout: WINDOWS_ARP };
        };
        assert.deepEqual(await readArpTable({ platform: "win32", run }), ONE_ENTRY);
        assert.deepEqual(calls, [["arp", "-a"]]);
    });
});
