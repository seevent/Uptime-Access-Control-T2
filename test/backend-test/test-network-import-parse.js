const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const HEADER = ["IP", "Nama", "Kategori", "Sub kategori", "Tipe", "Port"];

describe("network import parse", () => {
    let m;

    before(async () => {
        m = await import("../../src/network-import-parse.js");
    });

    test("maps synonym headers and numbers rows like Excel does", () => {
        const { items, error } = m.parseImportRows([
            ["Alamat IP", "Nama Device", "Lokasi", "SubKategori", "Jenis", "Port"],
            ["10.0.0.1", "CCTV Lobi", "Terminal 2", "Lobi", "ping", ""],
            ["10.0.0.2", "X-Ray", "Terminal 2", "Gate", "port", 443],
        ]);
        assert.equal(error, null);
        assert.deepEqual(items, [
            {
                row: 2,
                ip: "10.0.0.1",
                name: "CCTV Lobi",
                category: "Terminal 2",
                subcategory: "Lobi",
                type: "ping",
                port: "",
                path: "",
                community: "",
            },
            {
                row: 3,
                ip: "10.0.0.2",
                name: "X-Ray",
                category: "Terminal 2",
                subcategory: "Gate",
                type: "port",
                port: "443",
                path: "",
                community: "",
            },
        ]);
    });

    test("reads the Path and Community columns", () => {
        const { items, error } = m.parseImportRows([
            ["IP", "Tipe", "Port", "Jalur", "SNMP Community"],
            ["10.0.0.1", "http", "8080", "/login", ""],
            ["10.0.0.2", "snmp", "", "", "t2-ro"],
        ]);
        assert.equal(error, null);
        assert.deepEqual(
            items.map((i) => [i.type, i.port, i.path, i.community]),
            [
                ["http", "8080", "/login", ""],
                ["snmp", "", "", "t2-ro"],
            ]
        );
    });

    test("finds a header that is not in the first row and keeps Excel row numbers", () => {
        const { items, error } = m.parseImportRows([
            ["Daftar device T2"],
            [],
            HEADER,
            ["10.0.0.1", "A", null, null, null, null],
        ]);
        assert.equal(error, null);
        assert.equal(items.length, 1);
        assert.equal(items[0].row, 4);
    });

    test("reports a sheet without an IP column", () => {
        const { items, error } = m.parseImportRows([
            ["Nama", "Kategori"],
            ["A", "B"],
        ]);
        assert.deepEqual(items, []);
        assert.equal(error.code, "no-ip-column");
    });

    test("reports an empty sheet", () => {
        assert.equal(m.parseImportRows([]).error.code, "empty");
        assert.equal(m.parseImportRows([HEADER]).error.code, "empty");
    });

    test("turns cells into trimmed text", () => {
        const { items } = m.parseImportRows([
            HEADER,
            [" 10.0.0.1 ", undefined, null, "  Rak 1 ", 80, new Date("2026-10-07T00:00:00Z")],
        ]);
        assert.equal(items[0].ip, "10.0.0.1");
        assert.equal(items[0].name, "");
        assert.equal(items[0].category, "");
        assert.equal(items[0].subcategory, "Rak 1");
        assert.equal(items[0].type, "80");
        assert.equal(items[0].port, "2026-10-07T00:00:00.000Z");
    });

    test("skips rows that are completely empty but still counts their numbers", () => {
        const { items } = m.parseImportRows([HEADER, [], ["", " ", null], ["10.0.0.9", "Z"]]);
        assert.equal(items.length, 1);
        assert.equal(items[0].row, 4);
    });

    test("refuses more than 1000 data rows", () => {
        const grid = [HEADER];
        for (let i = 0; i < 1001; i++) {
            grid.push([`10.0.${Math.floor(i / 250)}.${i % 250}`]);
        }
        const { items, error } = m.parseImportRows(grid);
        assert.deepEqual(items, []);
        assert.equal(error.code, "too-many-rows");
        assert.equal(error.count, 1001);
        assert.equal(m.MAX_IMPORT_ROWS, 1000);
    });

    test("matches headers whatever the case and punctuation", () => {
        const { items, error } = m.parseImportRows([
            ["ip.", "NAMA", "KATEGORI", "SUB-KATEGORI"],
            ["10.0.0.1", "A", "B", "C"],
        ]);
        assert.equal(error, null);
        assert.equal(items[0].subcategory, "C");
    });

    test("the template CSV starts with a BOM and lists the columns", () => {
        const csv = m.buildImportTemplateCsv();
        assert.equal(csv.charCodeAt(0), 0xfeff);
        assert.equal(csv.split("\r\n")[0], "﻿IP,Nama,Kategori,Sub kategori,Tipe,Port,Path,Community");
        assert.ok(csv.split("\r\n").length >= 3);
        assert.ok(!csv.endsWith("\r\n"));
    });
});
