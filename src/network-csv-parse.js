/** Delimiters a CSV file of Excel may use: comma (English settings), semicolon (Indonesian settings), tab. */
const DELIMITERS = [",", ";", "\t"];

/**
 * Turn the bytes of a text file into text. UTF-8 is read first; a file that is not valid UTF-8 (a CSV saved by Excel
 * with accents in the "CSV (comma delimited)" format) is read as Windows-1252.
 * @param {ArrayBuffer|Uint8Array} bytes File content
 * @returns {string} The text, without a byte order mark
 */
export function decodeText(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // Excel's "Unicode Text" is UTF-16 with a byte order mark
    if (view.length >= 2 && view[0] === 0xff && view[1] === 0xfe) {
        return new TextDecoder("utf-16le").decode(view.subarray(2));
    }
    if (view.length >= 2 && view[0] === 0xfe && view[1] === 0xff) {
        return new TextDecoder("utf-16be").decode(view.subarray(2));
    }
    let text;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(view);
    } catch (e) {
        text = new TextDecoder("windows-1252").decode(view);
    }
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Pick the delimiter that splits the first line into most cells, ignoring delimiters inside quotes.
 * @param {string} line First line of the file
 * @returns {string} "," ";" or tab; a comma when the line has none of them
 */
export function detectDelimiter(line) {
    const counts = new Map(DELIMITERS.map((d) => [d, 0]));
    let quoted = false;
    for (const char of line) {
        if (char === '"') {
            quoted = !quoted;
        } else if (!quoted && counts.has(char)) {
            counts.set(char, counts.get(char) + 1);
        }
    }
    let best = ",";
    for (const [delimiter, count] of counts) {
        if (count > counts.get(best)) {
            best = delimiter;
        }
    }
    return best;
}

/**
 * Read CSV text into rows of cells. Quotes, doubled quotes, line breaks inside quotes, and the three kinds of line end
 * are understood. An empty line stays an empty row, so that row numbers are the ones Excel shows. A first line
 * `sep=;` (written by Excel) sets the delimiter and is not a row.
 * @param {string} text CSV text
 * @param {string} delimiter Delimiter; detected from the first line when left out
 * @returns {string[][]} Rows of cells as text
 */
export function parseCsv(text, delimiter) {
    let source = text;
    let separator = delimiter;
    const hint = /^sep=(.)\r?\n/i.exec(source);
    if (hint) {
        separator = separator ?? hint[1];
        source = source.slice(hint[0].length);
    }
    if (separator === undefined) {
        separator = detectDelimiter(source.split(/\r\n|\n|\r/, 1)[0]);
    }

    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    let wasQuoted = false;
    let started = false;

    const endCell = () => {
        row.push(cell);
        cell = "";
        wasQuoted = false;
    };
    const endRow = () => {
        if (started) {
            endCell();
            rows.push(row);
        } else {
            rows.push([]);
        }
        row = [];
        started = false;
    };

    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (quoted) {
            if (char === '"') {
                if (source[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else {
                    quoted = false;
                }
            } else {
                cell += char;
            }
        } else if (char === '"' && cell === "" && !wasQuoted) {
            quoted = true;
            wasQuoted = true;
            started = true;
        } else if (char === separator) {
            started = true;
            endCell();
        } else if (char === "\r" || char === "\n") {
            if (char === "\r" && source[i + 1] === "\n") {
                i++;
            }
            endRow();
        } else {
            cell += char;
            started = true;
        }
    }
    // The last line has no line end
    if (started || cell !== "" || quoted) {
        endRow();
    }
    return rows;
}
