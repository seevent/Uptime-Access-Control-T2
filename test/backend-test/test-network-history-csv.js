const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const BOM = "﻿";
const at = (hhmmss) => Date.parse(`2026-10-07T${hhmmss}Z`);
const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

describe("network history csv", () => {
    let m;

    before(async () => {
        m = await import("../../src/network-history-csv.js");
    });

    describe("buildDownEventsCsv", () => {
        const INFO = {
            1: { name: "Kamera B", ip: "10.0.0.2", category: "Terminal 2", subcategory: "CCTV" },
            2: { name: "Kamera A", ip: "10.0.0.1", category: "", subcategory: "" },
        };
        const HEADERS = ["Perangkat", "IP", "Kategori", "Sub kategori", "Mulai", "Akhir", "Lama", "Berlanjut", "Pesan"];
        const build = (events, effectiveTo = at("11:00:00")) =>
            m.buildDownEventsCsv({
                headers: HEADERS,
                events,
                effectiveTo,
                info: (id) => INFO[id],
                formatTime: stamp,
                yes: "ya",
                no: "tidak",
            });

        test("writes one row per event, sorted by start and then by name", () => {
            const csv = build([
                { deviceId: 1, start: at("10:30:00"), end: at("10:40:00"), msg: "timeout" },
                { deviceId: 1, start: at("10:10:00"), end: at("10:11:30"), msg: null },
                { deviceId: 2, start: at("10:10:00"), end: at("10:12:00"), msg: "timeout" },
            ]);
            const lines = csv.slice(BOM.length).split("\r\n");
            assert.equal(csv.startsWith(BOM), true);
            assert.equal(lines[0], HEADERS.map((h) => `"${h}"`).join(","));
            assert.equal(
                lines[1],
                '"Kamera A","10.0.0.1","","","2026-10-07 10:10:00","2026-10-07 10:12:00",120,"tidak","timeout"'
            );
            assert.equal(
                lines[2],
                '"Kamera B","10.0.0.2","Terminal 2","CCTV","2026-10-07 10:10:00","2026-10-07 10:11:30",90,"tidak",'
            );
            assert.equal(lines[3].startsWith('"Kamera B"'), true);
            assert.equal(lines.length, 4);
        });

        test("marks a period that lasts to the end of the range as going on", () => {
            const csv = build([{ deviceId: 1, start: at("10:50:00"), end: at("11:00:00"), msg: "timeout" }]);
            assert.match(csv, /,600,"ya","timeout"$/);
        });

        test("keeps a message with a comma, quotes and new lines in one cell", () => {
            const csv = build([
                {
                    deviceId: 1,
                    start: at("10:10:00"),
                    end: at("10:11:00"),
                    msg: 'ping "10.0.0.2"\nrequest timeout, retry',
                },
            ]);
            assert.ok(csv.endsWith('"ping ""10.0.0.2""\nrequest timeout, retry"'));
        });

        test("writes only the header when there are no events", () => {
            assert.equal(build([]).slice(BOM.length).split("\r\n").length, 1);
        });
    });

    describe("buildPingCsv", () => {
        const INFO = {
            1: { name: "Kamera A", ip: "10.0.0.1", category: "Terminal 2", subcategory: "CCTV" },
            2: { name: "Kamera B", ip: "10.0.0.2", category: "", subcategory: "" },
        };
        const HEADERS = ["Perangkat", "IP", "Kategori", "Sub kategori", "Avg", "Min", "Max", "Spread", "Sampel"];
        const build = (devices, items) => m.buildPingCsv({ headers: HEADERS, devices, items, info: (id) => INFO[id] });

        test("writes the numbers with one decimal, spread as max minus min", () => {
            const csv = build([{ id: 1 }], [{ deviceId: 1, samples: 40, avg: 12.345, min: 5, max: 50.26 }]);
            assert.equal(
                csv.slice(BOM.length).split("\r\n")[1],
                '"Kamera A","10.0.0.1","Terminal 2","CCTV",12.3,5,50.3,45.3,40'
            );
        });

        test("lists a device without samples with empty numbers and 0 samples, in the order of the devices", () => {
            const csv = build([{ id: 2 }, { id: 1 }], [{ deviceId: 1, samples: 0, avg: null, min: null, max: null }]);
            const lines = csv.slice(BOM.length).split("\r\n");
            assert.equal(lines[1], '"Kamera B","10.0.0.2","","",,,,,0');
            assert.equal(lines[2], '"Kamera A","10.0.0.1","Terminal 2","CCTV",,,,,0');
        });
    });
});
