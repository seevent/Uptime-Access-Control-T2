const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name));

describe("network import: csv", () => {
    let csv;

    before(async () => {
        csv = await import("../../src/network-csv-parse.js");
    });

    test("detects , ; and tab as delimiter", () => {
        assert.equal(csv.detectDelimiter("IP,Nama,Port"), ",");
        assert.equal(csv.detectDelimiter("IP;Nama;Port"), ";");
        assert.equal(csv.detectDelimiter("IP\tNama\tPort"), "\t");
        assert.equal(csv.detectDelimiter("IP"), ",");
    });

    test("does not count a delimiter inside quotes", () => {
        assert.equal(csv.detectDelimiter('"a,b,c";d;e'), ";");
    });

    test("quoted fields keep delimiters, quotes and line breaks", () => {
        const rows = csv.parseCsv('a,"b,1","say ""hi""","line1\nline2"\r\nx,y,z\r\n');
        assert.deepEqual(rows, [
            ["a", "b,1", 'say "hi"', "line1\nline2"],
            ["x", "y", "z"],
        ]);
    });

    test("keeps empty lines as empty rows so numbers match Excel, but no row for the last newline", () => {
        assert.deepEqual(csv.parseCsv("a,b\n\nc,d\n"), [["a", "b"], [], ["c", "d"]]);
        assert.deepEqual(csv.parseCsv("a,b"), [["a", "b"]]);
        assert.deepEqual(csv.parseCsv(""), []);
    });

    test("a sep= line sets the delimiter and is dropped", () => {
        assert.deepEqual(csv.parseCsv("sep=|\na|b\nc|d"), [
            ["a", "b"],
            ["c", "d"],
        ]);
    });

    test("semicolon files (Excel in Indonesia) are read without help", () => {
        assert.deepEqual(csv.parseCsv("IP;Nama\n10.0.0.1;Kamera, utara\n"), [
            ["IP", "Nama"],
            ["10.0.0.1", "Kamera, utara"],
        ]);
    });

    test("decodes UTF-8 (with and without BOM) and falls back to windows-1252", () => {
        const utf8 = Buffer.from("Café – Lobi", "utf8");
        assert.equal(csv.decodeText(utf8), "Café – Lobi");
        assert.equal(csv.decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8])), "Café – Lobi");
        assert.equal(csv.decodeText(Buffer.from([0x43, 0x61, 0x66, 0xe9])), "Café");
    });

    test("decodes UTF-16 with a BOM (Excel 'Unicode text')", () => {
        const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("IP\tNama\n", "utf16le")]);
        assert.equal(csv.decodeText(le), "IP\tNama\n");
    });

    test("reads the large LibreOffice csv fixture", () => {
        const rows = csv.parseCsv(csv.decodeText(fixture("import-besar.csv")));
        assert.equal(rows.length, 400);
        assert.equal(rows[2][1], "Café Ünïcode – Lobi");
        assert.equal(rows[3][1], 'Web "quoted", koma');
    });
});

describe("network import: xls", () => {
    let xls;
    let csv;

    before(async () => {
        xls = await import("../../src/network-xls-parse.js");
        csv = await import("../../src/network-csv-parse.js");
    });

    test("isXls recognises the OLE2 signature only", () => {
        assert.equal(xls.isXls(fixture("import-kecil.xls")), true);
        assert.equal(xls.isXls(Buffer.from("PK\x03\x04 zip")), false);
        assert.equal(xls.isXls(Buffer.from("IP,Nama")), false);
        assert.equal(xls.isXls(new Uint8Array(0)), false);
    });

    test("reads text, numbers and empty cells of a small file", () => {
        const grid = xls.parseXls(fixture("import-kecil.xls"));
        assert.deepEqual(grid[0], ["IP", "Nama", "Kategori", "Sub kategori", "Tipe", "Port", "Path", "Community"]);
        assert.equal(grid[2][1], "Café Ünïcode – Lobi");
        assert.equal(grid[2][5], 554);
        assert.equal(grid[3][1], 'Web "quoted", koma');
        assert.equal(grid[3][6], "/status");
        assert.equal(grid[1][7] ?? "", "");
        assert.equal(grid[4][7], "public");
    });

    test("an ArrayBuffer works as well as a Buffer", () => {
        const buffer = fixture("import-kecil.xls");
        const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        assert.deepEqual(xls.parseXls(ab), xls.parseXls(buffer));
    });

    test("reads integers, decimals and negative numbers", () => {
        const grid = xls.parseXls(fixture("angka.xls"));
        assert.deepEqual(
            grid.slice(1).map((r) => r[0]),
            [1, 2.5, -3, 100000, 1234567.891, 0.001]
        );
        assert.deepEqual(
            grid.slice(1).map((r) => r[1]),
            ["a", "b", "c", "d", "e", "f"]
        );
    });

    test("a big file (shared strings over several CONTINUE records) equals the csv it came from", () => {
        const grid = xls.parseXls(fixture("import-besar.xls"));
        const rows = csv.parseCsv(csv.decodeText(fixture("import-besar.csv"))).filter((r) => r.length > 0);
        assert.equal(grid.length, rows.length);
        for (let i = 0; i < rows.length; i++) {
            for (let j = 0; j < rows[i].length; j++) {
                assert.equal(String(grid[i][j] ?? ""), rows[i][j], `row ${i} col ${j}`);
            }
        }
    });

    test("rejects files that are not xls or are damaged, with code xls", () => {
        const bad = [Buffer.from("not an xls"), fixture("import-kecil.xls").subarray(0, 1000), Buffer.alloc(600)];
        for (const input of bad) {
            assert.throws(
                () => xls.parseXls(input),
                (e) => e.code === "xls"
            );
        }
    });

    test("stops at the row limit instead of reading the whole file", () => {
        const grid = xls.parseXls(fixture("import-besar.xls"), 50);
        assert.ok(grid.length <= 50);
    });
});
