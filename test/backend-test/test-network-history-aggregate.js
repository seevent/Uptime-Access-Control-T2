const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const iso = (s) => Date.parse(s);
const HOUR = 3600000;

describe("network history aggregate", () => {
    let m;

    before(async () => {
        m = await import("../../src/network-history-aggregate.js");
    });

    describe("bucketDown", () => {
        test("bucketDown counts a period on the day it starts and splits seconds", () => {
            const periods = [[iso("2026-10-06T16:30:00Z"), iso("2026-10-06T18:30:00Z")]]; // 23:30 to 01:30 WIB
            const r = m.bucketDown(periods, iso("2026-10-05T17:00:00Z"), iso("2026-10-08T17:00:00Z"), "Asia/Jakarta");
            assert.equal(r.unit, "day");
            assert.deepEqual(
                r.buckets.map((b) => [b.label, b.count, b.seconds]),
                [
                    ["2026-10-06", 1, 1800],
                    ["2026-10-07", 0, 5400],
                    ["2026-10-08", 0, 0],
                ]
            );
            assert.equal(r.buckets[0].start, iso("2026-10-05T17:00:00Z"));
        });

        test("bucketDown uses hours when the range is 48 hours or less and days above", () => {
            const from = iso("2026-10-06T17:00:00Z");
            const hourly = m.bucketDown([], from, from + 48 * HOUR, "Asia/Jakarta");
            assert.equal(hourly.unit, "hour");
            assert.equal(hourly.buckets.length, 48);
            assert.equal(hourly.buckets[0].label, "2026-10-07 00:00");
            const daily = m.bucketDown([], from, from + 48 * HOUR + 1, "Asia/Jakarta");
            assert.equal(daily.unit, "day");
        });

        test("bucketDown handles a half-hour zone", () => {
            const periods = [[iso("2026-10-06T18:40:00Z"), iso("2026-10-06T19:10:00Z")]]; // 00:10 to 00:40 IST
            const r = m.bucketDown(periods, iso("2026-10-06T18:30:00Z"), iso("2026-10-06T21:30:00Z"), "Asia/Kolkata");
            assert.equal(r.unit, "hour");
            assert.equal(r.buckets.length, 3);
            assert.equal(r.buckets[0].label, "2026-10-07 00:00");
            assert.equal(r.buckets[0].start, iso("2026-10-06T18:30:00Z"));
            assert.equal(r.buckets[0].count, 1);
            assert.equal(r.buckets[0].seconds, 1800);
        });

        test("bucketDown handles a 25-hour day", () => {
            const periods = [[iso("2026-11-01T04:00:00Z"), iso("2026-11-02T05:00:00Z")]];
            const r = m.bucketDown(
                periods,
                iso("2026-10-31T04:00:00Z"),
                iso("2026-11-02T05:00:00Z"),
                "America/New_York"
            );
            assert.equal(r.unit, "day");
            assert.deepEqual(
                r.buckets.map((b) => [b.label, b.count, b.seconds]),
                [
                    ["2026-10-31", 0, 0],
                    ["2026-11-01", 1, 90000],
                ]
            );
        });

        test("bucketDown clips periods to the range", () => {
            const from = iso("2026-10-07T10:00:00Z");
            const to = iso("2026-10-07T12:00:00Z");
            const periods = [
                [from - HOUR, from + 1800000],
                [to - 600000, to + HOUR],
                [to + 2 * HOUR, to + 3 * HOUR],
            ];
            const r = m.bucketDown(periods, from, to, "UTC");
            assert.equal(r.unit, "hour");
            assert.equal(r.buckets[0].count, 1);
            assert.equal(r.buckets[0].seconds, 1800);
            assert.equal(r.buckets[1].count, 1);
            assert.equal(r.buckets[1].seconds, 600);
            assert.equal(
                r.buckets.reduce((n, b) => n + b.count, 0),
                2
            );
        });

        test("bucketDown of nothing still lists the buckets", () => {
            const r = m.bucketDown([], iso("2026-10-01T00:00:00Z"), iso("2026-10-04T00:00:00Z"), "UTC");
            assert.deepEqual(
                r.buckets.map((b) => [b.label, b.count, b.seconds]),
                [
                    ["2026-10-01", 0, 0],
                    ["2026-10-02", 0, 0],
                    ["2026-10-03", 0, 0],
                ]
            );
        });
    });

    describe("heatmapGrid", () => {
        test("heatmapGrid splits at hour edges", () => {
            const periods = [[iso("2026-10-07T19:00:00Z"), iso("2026-10-07T20:30:00Z")]]; // Thursday 02:00 to 03:30 WIB
            const r = m.heatmapGrid(periods, iso("2026-10-05T17:00:00Z"), iso("2026-10-12T17:00:00Z"), "Asia/Jakarta");
            assert.equal(r.cells.length, 7);
            assert.equal(r.cells[0].length, 24);
            assert.equal(r.cells[3][2], 3600);
            assert.equal(r.cells[3][3], 1800);
            assert.equal(r.max, 3600);
            assert.equal(
                r.cells.flat().reduce((a, b) => a + b, 0),
                5400
            );
        });
    });

    describe("rankDevices", () => {
        const devices = [
            { deviceId: 1, downCount: 2, downSeconds: 100 },
            { deviceId: 2, downCount: 5, downSeconds: 50 },
            { deviceId: 3, downCount: 5, downSeconds: 200 },
            { deviceId: 4, downCount: 0, downSeconds: 0 },
            { deviceId: 5, downCount: 2, downSeconds: 100 },
        ];

        test("rankDevices orders, breaks ties and drops zeros", () => {
            assert.deepEqual(
                m.rankDevices(devices, "count").map((d) => d.deviceId),
                [3, 2, 1, 5]
            );
            assert.deepEqual(
                m.rankDevices(devices, "seconds").map((d) => d.deviceId),
                [3, 1, 5, 2]
            );
            assert.deepEqual(
                m.rankDevices(devices, "count", 2).map((d) => d.deviceId),
                [3, 2]
            );
        });
    });

    describe("timelineRows and segmentBars", () => {
        test("timelineRows takes the longest-down devices and widens thin bars", () => {
            const devices = [
                { deviceId: 1, downSeconds: 100, periods: [[100, 200]] },
                { deviceId: 2, downSeconds: 500, periods: [[500, 501]] },
                { deviceId: 3, downSeconds: 0, periods: [] },
            ];
            const all = m.timelineRows(devices, 0, 1000);
            assert.deepEqual(
                all.map((r) => r.deviceId),
                [2, 1]
            );
            assert.deepEqual(all[1].bars, [{ leftPercent: 10, widthPercent: 10, start: 100, end: 200 }]);
            assert.equal(all[0].bars[0].widthPercent, m.MIN_BAR_PERCENT);
            assert.deepEqual(
                m.timelineRows(devices, 0, 1000, 1).map((r) => r.deviceId),
                [2]
            );
        });

        test("timelineRows keeps a widened bar inside the track", () => {
            const rows = m.timelineRows([{ deviceId: 1, downSeconds: 1, periods: [[999, 1000]] }], 0, 1000);
            const bar = rows[0].bars[0];
            assert.equal(bar.widthPercent, m.MIN_BAR_PERCENT);
            assert.ok(Math.abs(bar.leftPercent + bar.widthPercent - 100) < 1e-9);
        });

        test("segmentBars positions by percent, clips, and widens thin bars", () => {
            const bars = m.segmentBars(
                [
                    { start: -100, end: 250, state: "up" },
                    { start: 250, end: 500, state: "down" },
                    { start: 700, end: 701, state: "pending" },
                ],
                0,
                1000
            );
            assert.deepEqual(bars[0], { leftPercent: 0, widthPercent: 25, state: "up", start: 0, end: 250 });
            assert.deepEqual(bars[1], { leftPercent: 25, widthPercent: 25, state: "down", start: 250, end: 500 });
            assert.equal(bars[2].widthPercent, m.MIN_BAR_PERCENT);
        });
    });
});
