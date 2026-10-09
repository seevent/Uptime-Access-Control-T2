/** Most data rows one import file may have. */
export const MAX_IMPORT_ROWS = 1000;

/** How many rows from the top are searched for the header row. */
const HEADER_SEARCH_ROWS = 10;

/** Accepted header names, written the way `normalizeHeader` returns them. */
const HEADER_NAMES = {
    ip: ["ip", "alamatip", "ipaddress"],
    name: ["nama", "namadevice", "name", "device", "label"],
    category: ["kategori", "category", "lokasi"],
    subcategory: ["subkategori", "subcategory"],
    type: ["tipe", "type", "jenis"],
    port: ["port"],
};

/**
 * Make a header comparable: lower case, without spaces and punctuation.
 * @param {unknown} value Header cell
 * @returns {string} For example "Sub-Kategori" becomes "subkategori"
 */
function normalizeHeader(value) {
    return cellText(value)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Turn a cell into trimmed text.
 * @param {unknown} value Cell as read from the sheet (text, number, boolean, date or empty)
 * @returns {string} The text, "" for an empty or unsupported cell
 */
function cellText(value) {
    if (typeof value === "string") {
        return value.trim();
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? String(value) : "";
    }
    if (typeof value === "boolean") {
        return String(value);
    }
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString();
    }
    return "";
}

/**
 * Find the column of each field in the header row.
 * @param {unknown[]} headerRow Cells of the header row
 * @returns {Record<string, number>} Column index per field; fields without a column are left out
 */
function mapColumns(headerRow) {
    const columns = {};
    headerRow.forEach((cell, index) => {
        const header = normalizeHeader(cell);
        for (const [field, names] of Object.entries(HEADER_NAMES)) {
            if (columns[field] === undefined && names.includes(header)) {
                columns[field] = index;
            }
        }
    });
    return columns;
}

/**
 * Read the rows of the first sheet of an import file.
 * @param {unknown[][]} grid Rows of cells, as `read-excel-file` returns them
 * @returns {{items: object[], error: null|{code: "empty"|"no-ip-column"|"too-many-rows", count?: number}}}
 *     `items` hold `{ row, ip, name, category, subcategory, type, port }`, all text; `row` is the row number in Excel
 */
export function parseImportRows(grid) {
    const rows = Array.isArray(grid) ? grid : [];
    if (rows.every((cells) => !Array.isArray(cells) || cells.every((cell) => cellText(cell) === ""))) {
        return { items: [], error: { code: "empty" } };
    }

    let headerIndex = -1;
    let columns = {};
    for (let i = 0; i < Math.min(rows.length, HEADER_SEARCH_ROWS); i++) {
        const found = Array.isArray(rows[i]) ? mapColumns(rows[i]) : {};
        if (found.ip !== undefined) {
            headerIndex = i;
            columns = found;
            break;
        }
    }
    if (headerIndex === -1) {
        return { items: [], error: { code: "no-ip-column" } };
    }

    const items = [];
    for (let i = headerIndex + 1; i < rows.length; i++) {
        const cells = Array.isArray(rows[i]) ? rows[i] : [];
        const read = (field) => (columns[field] === undefined ? "" : cellText(cells[columns[field]]));
        const fields = {
            ip: read("ip"),
            name: read("name"),
            category: read("category"),
            subcategory: read("subcategory"),
            type: read("type"),
            port: read("port"),
        };
        if (Object.values(fields).some((value) => value !== "")) {
            items.push({ row: i + 1, ...fields });
        }
    }

    if (items.length === 0) {
        return { items: [], error: { code: "empty" } };
    }
    if (items.length > MAX_IMPORT_ROWS) {
        return { items: [], error: { code: "too-many-rows", count: items.length } };
    }
    return { items, error: null };
}

/**
 * Text of the template file the user can download: the six columns and two example rows.
 * @returns {string} CSV with a BOM, so Excel opens it as UTF-8
 */
export function buildImportTemplateCsv() {
    const lines = [
        "IP,Nama,Kategori,Sub kategori,Tipe,Port",
        "10.20.0.11,CCTV Lobi,Terminal 2,Lobi,ping,",
        "10.20.1.5,X-Ray Gate 3,Terminal 2,Gate,port,443",
    ];
    return "﻿" + lines.join("\r\n");
}
