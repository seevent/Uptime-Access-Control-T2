const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

describe("network ping format", () => {
    let m;

    before(async () => {
        m = await import("../../src/network-ping-format.js");
    });

    test("pingLevel splits at 50 and 150 ms", () => {
        assert.equal(m.PING_GOOD_MAX, 50);
        assert.equal(m.PING_FAIR_MAX, 150);
        assert.equal(m.pingLevel(0), "good");
        assert.equal(m.pingLevel(50), "good");
        assert.equal(m.pingLevel(50.1), "fair");
        assert.equal(m.pingLevel(150), "fair");
        assert.equal(m.pingLevel(150.1), "slow");
        assert.equal(m.pingLevel(null), null);
        assert.equal(m.pingLevel(undefined), null);
        assert.equal(m.pingLevel(Number.NaN), null);
    });

    test("formatPing keeps one decimal under 10 ms and follows the locale", () => {
        assert.equal(m.formatPing(0.8, "id"), "0,8 ms");
        assert.equal(m.formatPing(12.4, "en"), "12 ms");
        assert.equal(m.formatPing(1250, "en"), "1,250 ms");
        assert.equal(m.formatPing(null, "id"), "—");
    });

    const items = [
        { deviceId: 1, samples: 10, avg: 20, min: 10, max: 90 },
        { deviceId: 2, samples: 10, avg: 60, min: 55, max: 70 },
        { deviceId: 3, samples: 0, avg: null, min: null, max: null },
        { deviceId: 4, samples: 10, avg: 60, min: 40, max: 70 },
        { deviceId: 5, samples: 10, avg: 25, min: 10, max: 90 },
    ];

    test("rankPing orders by the metric, breaks ties by avg then id, and drops devices without samples", () => {
        assert.deepEqual(
            m.rankPing(items, "avg").map((i) => i.deviceId),
            [2, 4, 5, 1]
        );
        assert.deepEqual(
            m.rankPing(items, "max").map((i) => i.deviceId),
            [5, 1, 2, 4]
        );
        // spread = max - min: 1 → 80, 2 → 15, 4 → 30, 5 → 80 (tie with 1, higher avg first)
        assert.deepEqual(
            m.rankPing(items, "spread").map((i) => i.deviceId),
            [5, 1, 4, 2]
        );
        assert.deepEqual(
            m.rankPing(items, "avg", 2).map((i) => i.deviceId),
            [2, 4]
        );
    });

    test("pingChartPoints inserts a null point in a gap but not between consecutive buckets", () => {
        const points = [
            [0, 10, 5, 20, 3, 0],
            [60000, 12, 6, 22, 3, 0],
            [300000, 14, 7, 24, 3, 0],
        ];
        const out = m.pingChartPoints(points, 60);
        assert.equal(out.length, 4);
        assert.deepEqual(out[0], { x: 0, y: 10, min: 5, max: 20, up: 3, down: 0 });
        assert.deepEqual(out[2], { x: 120000, y: null, min: null, max: null, up: 0, down: 0 });
        assert.equal(out[3].x, 300000);
        const dense = m.pingChartPoints(points.slice(0, 2), 60);
        assert.equal(dense.length, 2);
    });

    test("pingChartPoints keeps a bucket without successful checks as a null value", () => {
        const out = m.pingChartPoints([[0, null, null, null, 0, 5]], 60);
        assert.deepEqual(out, [{ x: 0, y: null, min: null, max: null, up: 0, down: 5 }]);
    });

    test("defaultSeriesIds takes the devices with the highest average", () => {
        assert.deepEqual(m.defaultSeriesIds(items, 3), [2, 4, 5]);
        assert.deepEqual(m.defaultSeriesIds(items), [2, 4, 5]);
        assert.deepEqual(m.defaultSeriesIds([], 3), []);
    });
});
