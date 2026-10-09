const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { buildXlsx, columnLetters, sheetName, xmlEscape } = require("../../server/xlsx-writer");

/**
 * @param {Buffer} buffer An .xlsx file
 * @param {number|string} sheet Sheet number or name
 * @returns {Promise<unknown[][]>} Rows of the sheet as an Excel reader sees them
 */
async function read(buffer, sheet = 1) {
    const { readSheet } = await import("read-excel-file/node");
    return await readSheet(buffer, sheet);
}

describe("xlsx writer", () => {
    test("columnLetters counts like Excel", () => {
        assert.deepEqual([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetters), [
            "A",
            "B",
            "Z",
            "AA",
            "AB",
            "AZ",
            "BA",
            "ZZ",
            "AAA",
        ]);
    });

    test("xmlEscape escapes markup and removes control characters", () => {
        assert.equal(xmlEscape('a & <b> "c"\u0001\u0008x'), "a &amp; &lt;b&gt; &quot;c&quot;x");
    });

    test("sheetName cleans the name, cuts it to 31 characters and makes it different from the others", () => {
        const used = new Set();
        assert.equal(sheetName("Ringkasan: 2026/09?", used), "Ringkasan  2026 09");
        assert.equal(sheetName("ringkasan  2026 09", used), "ringkasan  2026 09 (2)");
        assert.equal(sheetName("", used), "Sheet");
        assert.equal(sheetName("x".repeat(40), used).length, 31);
        assert.equal(sheetName("x".repeat(40), used).length, 31);
        assert.equal(used.size, 5);
    });

    test("a file written is read back with the same text and numbers", async () => {
        const buffer = buildXlsx([
            {
                name: "Data",
                columns: [{ width: 20 }, { format: "decimal" }, { format: "integer" }],
                rows: [
                    [{ v: "Nama", style: "header" }, { v: "Nilai", style: "header" }, "Jumlah"],
                    ["A & B <c>", 99.5, 3],
                    ["Tanpa nilai", null, 0],
                    ["=SUM(A1:A2)", -1.25, 1000000],
                ],
            },
            { name: "Kedua", rows: [["Lobi", "Terminal 2"]], freezeHeader: false },
        ]);
        assert.equal(buffer.subarray(0, 2).toString(), "PK");
        assert.deepEqual(await read(buffer, 1), [
            ["Nama", "Nilai", "Jumlah"],
            ["A & B <c>", 99.5, 3],
            ["Tanpa nilai", null, 0],
            ["=SUM(A1:A2)", -1.25, 1000000],
        ]);
        assert.deepEqual(await read(buffer, "Kedua"), [["Lobi", "Terminal 2"]]);
    });

    test("an empty row in the middle keeps the rows below in their place", async () => {
        const rows = await read(buildXlsx([{ name: "A", rows: [["a"], [], ["c"]] }]));
        assert.deepEqual(rows, [["a"], [null], ["c"]]);
    });

    test("text with accents and emoji survives", async () => {
        const rows = await read(buildXlsx([{ name: "A", rows: [["Kamera lobi — Pintu Barat ✓ 😀"]] }]));
        assert.equal(rows[0][0], "Kamera lobi — Pintu Barat ✓ 😀");
    });

    test("refuses a workbook without sheets", () => {
        assert.throws(() => buildXlsx([]), /Minimal satu lembar/);
    });
});
