const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const ID_UNITS = { day: "h", hour: "j", minute: "m", second: "d" };
const EN_UNITS = { day: "d", hour: "h", minute: "m", second: "s" };

describe("network uptime format", () => {
    let f;

    before(async () => {
        f = await import("../../src/network-uptime-format.js");
    });

    test("PRESETS lists the four presets in seconds", () => {
        assert.deepEqual(f.PRESETS, { "1h": 3600, "24h": 86400, "7d": 604800, "30d": 2592000 });
    });

    test("resolveRange counts a preset back from now", () => {
        const now = Date.parse("2026-10-07T11:00:00Z");
        assert.deepEqual(f.resolveRange({ preset: "24h" }, now), {
            from: "2026-10-06T11:00:00.000Z",
            to: "2026-10-07T11:00:00.000Z",
        });
        assert.deepEqual(f.resolveRange({ preset: "1h" }, now), {
            from: "2026-10-07T10:00:00.000Z",
            to: "2026-10-07T11:00:00.000Z",
        });
    });

    test("resolveRange returns a custom range as it is", () => {
        const period = { preset: "custom", from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z" };
        assert.deepEqual(f.resolveRange(period, Date.now()), { from: period.from, to: period.to });
    });

    test("formatDuration shows every non-zero unit from the largest", () => {
        assert.equal(f.formatDuration(183910, ID_UNITS), "2h 3j 5m 10d");
        assert.equal(f.formatDuration(183910, EN_UNITS), "2d 3h 5m 10s");
        assert.equal(f.formatDuration(3600, EN_UNITS), "1h");
        assert.equal(f.formatDuration(86400 + 5, EN_UNITS), "1d 5s");
    });

    test("formatDuration keeps at most maxParts units", () => {
        assert.equal(f.formatDuration(183910, ID_UNITS, 2), "2h 3j");
        assert.equal(f.formatDuration(86340 + 10, ID_UNITS, 2), "23j 59m");
    });

    test("formatDuration of zero or less is 0 seconds", () => {
        assert.equal(f.formatDuration(0, ID_UNITS), "0d");
        assert.equal(f.formatDuration(-5, ID_UNITS), "0d");
        assert.equal(f.formatDuration(0.4, ID_UNITS), "0d");
    });

    test("formatPercent follows the locale and keeps two decimals at most", () => {
        assert.equal(f.formatPercent(99.2, "id"), "99,2");
        assert.equal(f.formatPercent(99.2, "en"), "99.2");
        assert.equal(f.formatPercent(99.123456, "en"), "99.12");
        assert.equal(f.formatPercent(100, "en"), "100");
        assert.equal(f.formatPercent(null, "en"), "");
    });

    test("buildUptimeCsv starts with a BOM, quotes text and leaves numbers bare", () => {
        const csv = f.buildUptimeCsv(["Nama", "IP", "Up"], [["CCTV", "10.0.0.1", 3600]]);
        assert.equal(csv, '﻿"Nama","IP","Up"\r\n"CCTV","10.0.0.1",3600');
    });

    test("buildUptimeCsv keeps a name with a comma, quotes and a newline in one cell", () => {
        const csv = f.buildUptimeCsv(["Nama"], [['Kamera "A", Lantai 2\nSayap']]);
        assert.equal(csv, '﻿"Nama"\r\n"Kamera ""A"", Lantai 2\nSayap"');
    });

    test("buildUptimeCsv puts an apostrophe before text Excel would read as a formula", () => {
        const csv = f.buildUptimeCsv(["a"], [["=HYPERLINK(1)"], ["+62 21"], ["-cam"], ["@SUM(A1)"], ["\tx"], ["\rx"]]);
        assert.equal(csv, '﻿"a"\r\n"\'=HYPERLINK(1)"\r\n"\'+62 21"\r\n"\'-cam"\r\n"\'@SUM(A1)"\r\n"\'\tx"\r\n"\'\rx"');
    });

    test("buildUptimeCsv leaves negative numbers and ordinary text alone", () => {
        const csv = f.buildUptimeCsv(["a", "b", "c"], [[-5, "Kamera-1", "10.0.0.1"]]);
        assert.equal(csv, '﻿"a","b","c"\r\n-5,"Kamera-1","10.0.0.1"');
    });

    test("buildUptimeCsv writes empty cells for null and undefined", () => {
        const csv = f.buildUptimeCsv(["a", "b", "c"], [[null, undefined, 5]]);
        assert.equal(csv, '﻿"a","b","c"\r\n,,5');
    });

    test("csvFileName is built from the two ISO times", () => {
        assert.equal(
            f.csvFileName("2026-10-07T10:00:00.000Z", "2026-10-07T11:30:00.000Z"),
            "uptime-device-20261007-1000-20261007-1130.csv"
        );
    });

    test("csvFileName starts with the prefix it is given", () => {
        assert.equal(
            f.csvFileName("2026-10-07T10:00:00.000Z", "2026-10-07T11:30:00.000Z", "down"),
            "down-20261007-1000-20261007-1130.csv"
        );
    });
});
