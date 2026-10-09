const zlib = require("node:zlib");

/**
 * A small writer of .xlsx files (Excel workbooks) that needs nothing but Node.js: an .xlsx file is a zip file of
 * XML files. It writes text, numbers, bold header rows, column widths and a frozen header row, which is all the
 * reports need.
 */

const STYLES = { default: 0, header: 1, decimal: 2, integer: 3, title: 4 };
const MAX_SHEET_NAME = 31;
const MAX_ROWS = 1048576;
const MAX_COLUMNS = 16384;

/**
 * @param {string} text Text
 * @returns {string} Text that is safe inside XML (special characters escaped, control characters removed)
 */
function xmlEscape(text) {
    return String(text)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * @param {number} index Column number, starting at 0
 * @returns {string} Column letters as Excel writes them: A, B, ... Z, AA, AB, ...
 */
function columnLetters(index) {
    let n = index + 1;
    let letters = "";
    while (n > 0) {
        const rest = (n - 1) % 26;
        letters = String.fromCharCode(65 + rest) + letters;
        n = Math.floor((n - 1) / 26);
    }
    return letters;
}

/**
 * Excel refuses sheet names with some characters, more than 31 characters, or that are empty.
 * @param {string} name Wanted name
 * @param {Set<string>} used Names (lower case) that are already taken
 * @returns {string} A name Excel accepts, different from the others
 */
function sheetName(name, used) {
    let clean = String(name)
        .replace(/[\\/?*[\]:]/g, " ")
        .replace(/^'+|'+$/g, "")
        .trim()
        .slice(0, MAX_SHEET_NAME);
    if (clean === "") {
        clean = "Sheet";
    }
    let candidate = clean;
    for (let i = 2; used.has(candidate.toLowerCase()); i++) {
        const suffix = ` (${i})`;
        candidate = clean.slice(0, MAX_SHEET_NAME - suffix.length) + suffix;
    }
    used.add(candidate.toLowerCase());
    return candidate;
}

/**
 * @param {unknown} cell A cell: text, a number, null/undefined (empty) or `{ v, style }`
 * @param {string} column Default style of the column ("default", "decimal", "integer")
 * @param {string} ref Cell reference such as "B3"
 * @returns {string} The `<c>` element, or "" for an empty cell
 */
function cellXml(cell, column, ref) {
    const wrapped = cell !== null && typeof cell === "object" && !(cell instanceof Date);
    const value = wrapped ? cell.v : cell;
    if (value === null || value === undefined || value === "") {
        return "";
    }
    const isNumber = typeof value === "number" && Number.isFinite(value);
    const style = STYLES[(wrapped && cell.style) || (isNumber ? column : "default")] ?? 0;
    const s = style === 0 ? "" : ` s="${style}"`;
    if (isNumber) {
        return `<c r="${ref}"${s}><v>${value}</v></c>`;
    }
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

/**
 * @param {{rows: unknown[][], columns?: {width?: number, format?: string}[], freezeHeader?: boolean}} sheet Sheet
 * @returns {string} The XML of the worksheet
 * @throws {Error} When the sheet has more rows or columns than Excel allows
 */
function sheetXml(sheet) {
    const columns = sheet.columns || [];
    if (sheet.rows.length > MAX_ROWS) {
        throw new Error("Terlalu banyak baris untuk satu lembar Excel");
    }
    const rows = sheet.rows
        .map((row, r) => {
            if (row.length > MAX_COLUMNS) {
                throw new Error("Terlalu banyak kolom untuk satu lembar Excel");
            }
            const cells = row
                .map((cell, c) => cellXml(cell, columns[c]?.format || "default", `${columnLetters(c)}${r + 1}`))
                .join("");
            return cells === "" ? "" : `<row r="${r + 1}">${cells}</row>`;
        })
        .join("");
    const cols = columns
        .map((col, i) =>
            col.width ? `<col min="${i + 1}" max="${i + 1}" width="${Number(col.width)}" customWidth="1"/>` : ""
        )
        .join("");
    const view =
        sheet.freezeHeader === false
            ? '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
            : '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        view +
        (cols === "" ? "" : `<cols>${cols}</cols>`) +
        `<sheetData>${rows}</sheetData></worksheet>`
    );
}

const STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="14"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="5">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
    '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/**
 * Cut a time into the two 16 bit numbers a zip file keeps.
 * @param {Date} date Time
 * @returns {{time: number, date: number}} DOS time and date
 */
function dosTime(date) {
    const year = Math.max(date.getFullYear(), 1980);
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

/**
 * Pack files into a zip file.
 * @param {{name: string, data: Buffer}[]} files Files in the order they should be stored
 * @param {Date} when Modification time of every file
 * @returns {Buffer} The zip file
 */
function zip(files, when) {
    const stamp = dosTime(when);
    const parts = [];
    const central = [];
    let offset = 0;
    for (const file of files) {
        const name = Buffer.from(file.name, "utf8");
        const packed = zlib.deflateRawSync(file.data);
        const crc = zlib.crc32(file.data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt16LE(stamp.time, 10);
        local.writeUInt16LE(stamp.date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(file.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);

        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt16LE(0x0800, 8);
        entry.writeUInt16LE(8, 10);
        entry.writeUInt16LE(stamp.time, 12);
        entry.writeUInt16LE(stamp.date, 14);
        entry.writeUInt32LE(crc, 16);
        entry.writeUInt32LE(packed.length, 20);
        entry.writeUInt32LE(file.data.length, 24);
        entry.writeUInt16LE(name.length, 28);
        entry.writeUInt32LE(offset, 42);

        parts.push(local, name, packed);
        central.push(entry, name);
        offset += local.length + name.length + packed.length;
    }
    const centralBuffer = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, centralBuffer, end]);
}

/**
 * Build an .xlsx file.
 * @param {{name: string, rows: unknown[][], columns?: {width?: number, format?: string}[], freezeHeader?: boolean}[]} sheets
 *     Sheets in order. A cell is text, a number, null (empty) or `{ v, style }` with style "header", "title", "decimal" or "integer".
 *     `columns[i].format` ("decimal" or "integer") is the number format of the numbers in that column.
 * @param {Date} when Creation time (default: now)
 * @returns {Buffer} The file
 * @throws {Error} When there is no sheet
 */
function buildXlsx(sheets, when = new Date()) {
    if (!Array.isArray(sheets) || sheets.length === 0) {
        throw new Error("Minimal satu lembar diperlukan");
    }
    const used = new Set();
    const names = sheets.map((sheet) => sheetName(sheet.name, used));
    const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const files = [
        {
            name: "[Content_Types].xml",
            data:
                header +
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
                '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
                '<Default Extension="xml" ContentType="application/xml"/>' +
                '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
                '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
                sheets
                    .map(
                        (_, i) =>
                            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
                    )
                    .join("") +
                "</Types>",
        },
        {
            name: "_rels/.rels",
            data:
                header +
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
                "</Relationships>",
        },
        {
            name: "xl/workbook.xml",
            data:
                header +
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
                "<sheets>" +
                names
                    .map((name, i) => `<sheet name="${xmlEscape(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
                    .join("") +
                "</sheets></workbook>",
        },
        {
            name: "xl/_rels/workbook.xml.rels",
            data:
                header +
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                sheets
                    .map(
                        (_, i) =>
                            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
                    )
                    .join("") +
                `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
                "</Relationships>",
        },
        { name: "xl/styles.xml", data: STYLES_XML },
        ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sheet) })),
    ].map((file) => ({ name: file.name, data: Buffer.from(file.data, "utf8") }));
    return zip(files, when);
}

module.exports = { buildXlsx, columnLetters, sheetName, xmlEscape };
