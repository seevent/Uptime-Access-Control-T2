import { decodeText, parseCsv } from "./network-csv-parse.js";
import { isXls, parseXls } from "./network-xls-parse.js";

/** Most bytes of an import file that are read. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * @param {Uint8Array} bytes File content
 * @returns {boolean} True for a zip file, which is what .xlsx is
 */
function isZip(bytes) {
    return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * @param {Uint8Array} bytes File content
 * @returns {boolean} True when the start of the file has a NUL byte, so it is no text (UTF-16 with a mark is text)
 */
function looksBinary(bytes) {
    if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
        return false;
    }
    return bytes.subarray(0, 4096).includes(0);
}

/**
 * Make an error the dialog can tell apart.
 * @param {"read"|"size"} code What went wrong
 * @param {string} message Message for the log
 * @returns {Error} The error
 */
function importError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

/**
 * Read the first sheet of an import file as a grid of cells. The format is taken from the content, not from the
 * name, so a .csv that is really an Excel file, or the other way around, still works.
 * @param {File|Blob} file The chosen file (.xlsx, .xls or text such as .csv)
 * @returns {Promise<unknown[][]>} Rows of cells (text, number, boolean, date or empty)
 * @throws {Error} With code "size" when the file is too big, "read" when it is not a supported or readable file
 */
export async function readImportGrid(file) {
    if (file.size > MAX_FILE_BYTES) {
        throw importError("size", "File too big");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isZip(bytes)) {
        const { readSheet } = await import("read-excel-file/browser");
        return await readSheet(file);
    }
    if (isXls(bytes)) {
        try {
            return parseXls(bytes);
        } catch (e) {
            throw importError("read", e.message);
        }
    }
    if (looksBinary(bytes)) {
        throw importError("read", "Not a spreadsheet or text file");
    }
    return parseCsv(decodeText(bytes));
}
