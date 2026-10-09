const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

describe("network wallboard", () => {
    let m;

    before(async () => {
        m = await import("../../src/network-wallboard.js");
    });

    const UP = 1;
    const DOWN = 0;
    const PENDING = 2;
    const MAINTENANCE = 3;

    const categories = [
        {
            id: 1,
            name: "Terminal 2",
            subcategories: [
                { id: 10, name: "Gate" },
                { id: 11, name: "Lobi" },
            ],
        },
        { id: 2, name: "Terminal 5", subcategories: [] },
    ];
    const devices = [
        { id: 1, ip: "10.0.0.1", label: "Kamera A", categoryId: 1, subcategoryId: 11, monitorId: 1 },
        { id: 2, ip: "10.0.0.2", label: "Kamera B", categoryId: 1, subcategoryId: 11, monitorId: 2 },
        { id: 3, ip: "10.0.0.3", label: null, categoryId: 1, subcategoryId: 10, monitorId: 3 },
        { id: 4, ip: "10.0.0.4", label: "Server", categoryId: 2, subcategoryId: null, monitorId: 4 },
        { id: 5, ip: "10.0.0.5", label: "Lepas", categoryId: null, subcategoryId: null, monitorId: 5 },
        { id: 6, ip: "10.0.0.6", label: "Belum dimonitor", categoryId: 1, subcategoryId: null, monitorId: null },
        { id: 7, ip: "10.0.0.7", label: "Dijeda", categoryId: 2, subcategoryId: null, monitorId: 7 },
    ];
    const beats = {
        1: [
            { status: UP, time: "2026-10-09 10:00:00.000" },
            { status: DOWN, time: "2026-10-09 10:01:00.000" },
            { status: DOWN, time: "2026-10-09 10:02:00.000" },
        ],
        2: [{ status: UP, time: "2026-10-09 10:02:00.000" }],
        3: [
            { status: DOWN, time: "2026-10-09 09:00:00.000" },
            { status: DOWN, time: "2026-10-09 09:01:00.000" },
        ],
        4: [{ status: PENDING, time: "2026-10-09 10:02:00.000" }],
        5: [{ status: MAINTENANCE, time: "2026-10-09 10:02:00.000" }],
        7: [{ status: DOWN, time: "2026-10-09 10:02:00.000" }],
    };
    const build = (extra = {}) =>
        m.buildWallboard({
            devices,
            categories,
            lastBeat: (id) => beats[id]?.[beats[id].length - 1],
            isActive: (id) => id !== 7,
            beatsOf: (id) => beats[id],
            ...extra,
        });

    test("deviceState reads the last beat, a paused monitor and a monitor without beats", () => {
        assert.equal(m.deviceState({ status: UP }, true), "up");
        assert.equal(m.deviceState({ status: DOWN }, true), "down");
        assert.equal(m.deviceState({ status: PENDING }, true), "pending");
        assert.equal(m.deviceState({ status: MAINTENANCE }, true), "maintenance");
        assert.equal(m.deviceState({ status: DOWN }, false), "paused");
        assert.equal(m.deviceState(undefined, true), "unknown");
        assert.equal(m.deviceState({ status: 9 }, true), "unknown");
    });

    test("groupState lets the worst state win, and a paused or unseen group is none", () => {
        const c = (o) => ({ up: 0, down: 0, pending: 0, maintenance: 0, total: 0, ...o });
        assert.equal(m.groupState(c({ up: 5, down: 1, pending: 1 })), "down");
        assert.equal(m.groupState(c({ up: 5, pending: 1 })), "pending");
        assert.equal(m.groupState(c({ up: 5, maintenance: 1 })), "maintenance");
        assert.equal(m.groupState(c({ up: 5 })), "up");
        assert.equal(m.groupState(c({ total: 3 })), "none");
    });

    test("beatTime reads UTC text, ISO text, numbers and dates, and refuses the rest", () => {
        const ms = Date.parse("2026-10-09T10:00:00.000Z");
        assert.equal(m.beatTime("2026-10-09 10:00:00.000"), ms);
        assert.equal(m.beatTime("2026-10-09T10:00:00.000Z"), ms);
        assert.equal(m.beatTime("2026-10-09T17:00:00.000+07:00"), ms);
        assert.equal(m.beatTime(ms), ms);
        assert.equal(m.beatTime(new Date(ms)), ms);
        for (const bad of ["", "x", null, undefined, NaN]) {
            assert.equal(m.beatTime(bad), null);
        }
    });

    test("downSince finds the start of the run of down beats at the end", () => {
        assert.deepEqual(m.downSince(beats[1]), { since: Date.parse("2026-10-09T10:01:00Z"), atLeast: false });
        assert.deepEqual(m.downSince(beats[3]), { since: Date.parse("2026-10-09T09:00:00Z"), atLeast: true });
        assert.deepEqual(m.downSince(beats[2]), { since: null, atLeast: false });
        assert.deepEqual(m.downSince([]), { since: null, atLeast: false });
        assert.deepEqual(m.downSince(undefined), { since: null, atLeast: false });
    });

    test("counts devices per category and sub category and skips devices without a monitor", () => {
        const w = build();
        assert.deepEqual(
            w.groups.map((g) => [g.name, g.state, g.counts.total, g.counts.up, g.counts.down]),
            [
                ["Terminal 2", "down", 3, 1, 2],
                ["Terminal 5", "pending", 2, 0, 0],
                ["", "maintenance", 1, 0, 0],
            ]
        );
        assert.deepEqual(
            w.groups[0].subs.map((s) => [s.name, s.state, s.counts.total, s.counts.down]),
            [
                ["Gate", "down", 1, 1],
                ["Lobi", "down", 2, 1],
            ]
        );
        assert.deepEqual(
            { ...w.total },
            { up: 1, down: 2, pending: 1, maintenance: 1, paused: 1, unknown: 0, total: 6 }
        );
        assert.equal(w.state, "down");
    });

    test("a paused monitor is counted apart and does not turn a group red", () => {
        const w = build();
        const t5 = w.groups[1];
        assert.equal(t5.counts.paused, 1);
        assert.equal(t5.counts.down, 0);
        assert.equal(t5.state, "pending");
    });

    test("the list of down devices has the longest down first, with the name or the address", () => {
        const w = build();
        assert.deepEqual(
            w.downList.map((d) => [d.name, d.category, d.subcategory, d.atLeast]),
            [
                ["10.0.0.3", "Terminal 2", "Gate", true],
                ["Kamera A", "Terminal 2", "Lobi", false],
            ]
        );
    });

    test("only shows the chosen categories, whatever the case, and none for devices without a category", () => {
        assert.deepEqual(
            build({ only: ["terminal 5"] }).groups.map((g) => g.name),
            ["Terminal 5"]
        );
        assert.deepEqual(
            build({ only: [" TERMINAL 2 ", "none"] }).groups.map((g) => g.key),
            ["c1", "none"]
        );
        assert.equal(build({ only: ["tidak ada"] }).total.total, 0);
        assert.equal(build({ only: ["tidak ada"] }).state, "none");
        assert.equal(build({ only: ["", " "] }).total.total, 6);
    });

    test("formatSince writes short text and takes the words of the language", () => {
        assert.equal(m.formatSince(5000), "5 dtk");
        assert.equal(m.formatSince(12 * 60000), "12 mnt");
        assert.equal(m.formatSince((3 * 60 + 5) * 60000), "3 jam 05 mnt");
        assert.equal(m.formatSince((50 * 60 + 5) * 60000), "2 hari 2 jam");
        assert.equal(m.formatSince(-1), "");
        assert.equal(m.formatSince(90 * 60000, { second: "s", minute: "min", hour: "h", day: "d" }), "1 h 30 min");
    });
});
