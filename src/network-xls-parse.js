/**
 * A reader for the old Excel format (.xls, "Excel 97-2003", BIFF8 inside an OLE2 compound file). It reads the first
 * visible worksheet as text, numbers and booleans, which is all an import file needs. Formats and dates are not
 * interpreted: a date arrives as its serial number.
 */

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;
const MAX_SECTORS = 1 << 22;

const REC = {
    EOF: 0x000a,
    BOF: 0x0809,
    FILEPASS: 0x002f,
    CONTINUE: 0x003c,
    BOUNDSHEET: 0x0085,
    SST: 0x00fc,
    LABELSST: 0x00fd,
    LABEL: 0x0204,
    RSTRING: 0x00d6,
    NUMBER: 0x0203,
    RK: 0x027e,
    MULRK: 0x00bd,
    FORMULA: 0x0006,
    STRING: 0x0207,
    BOOLERR: 0x0205,
};

/**
 * @param {string} message What is wrong
 * @returns {Error} Error with `code` "xls"
 */
function xlsError(message) {
    const error = new Error(`Berkas .xls tidak bisa dibaca: ${message}`);
    error.code = "xls";
    return error;
}

/**
 * @param {ArrayBuffer|Uint8Array} input File content
 * @returns {boolean} True when the content starts like an OLE2 compound file (the container of .xls)
 */
export function isXls(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    return bytes.length >= 8 && OLE_SIGNATURE.every((b, i) => bytes[i] === b);
}

/**
 * Read the streams of an OLE2 compound file.
 * @param {Uint8Array} bytes File content
 * @returns {{stream: (name: string) => Uint8Array|null}} Access to a stream by name
 */
function openCompoundFile(bytes) {
    if (!isXls(bytes)) {
        throw xlsError("bukan berkas Excel lama");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sectorSize = 1 << view.getUint16(0x1e, true);
    const miniSectorSize = 1 << view.getUint16(0x20, true);
    const miniCutoff = view.getUint32(0x38, true);
    if (![512, 4096].includes(sectorSize) || miniSectorSize > sectorSize) {
        throw xlsError("susunan berkas tidak dikenal");
    }
    const sectorOffset = (id) => (id + 1) * sectorSize;
    const readSector = (id) => {
        const start = sectorOffset(id);
        if (id >= MAX_SECTORS || start + sectorSize > bytes.length) {
            throw xlsError("berkas terpotong");
        }
        return bytes.subarray(start, start + sectorSize);
    };
    const u32List = (data) => {
        const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const list = [];
        for (let i = 0; i + 4 <= data.length; i += 4) {
            list.push(v.getUint32(i, true));
        }
        return list;
    };

    // The table of sectors (FAT): its own sectors are listed in the header and in extra sectors (DIFAT)
    const fatSectors = [];
    for (let i = 0; i < 109; i++) {
        const id = view.getUint32(0x4c + i * 4, true);
        if (id !== FREE_SECTOR && id !== END_OF_CHAIN) {
            fatSectors.push(id);
        }
    }
    let difat = view.getUint32(0x44, true);
    for (let n = view.getUint32(0x48, true); n > 0 && difat !== END_OF_CHAIN && difat !== FREE_SECTOR; n--) {
        const entries = u32List(readSector(difat));
        for (const id of entries.slice(0, -1)) {
            if (id !== FREE_SECTOR && id !== END_OF_CHAIN) {
                fatSectors.push(id);
            }
        }
        difat = entries[entries.length - 1];
    }
    const fat = fatSectors.flatMap((id) => u32List(readSector(id)));

    const chainOf = (table, start) => {
        const ids = [];
        let id = start;
        while (id !== END_OF_CHAIN && id !== FREE_SECTOR) {
            if (id >= table.length || ids.length > MAX_SECTORS) {
                throw xlsError("rantai sektor rusak");
            }
            ids.push(id);
            id = table[id];
        }
        return ids;
    };
    const join = (parts, size) => {
        const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
        let at = 0;
        for (const part of parts) {
            out.set(part, at);
            at += part.length;
        }
        return out.subarray(0, size ?? out.length);
    };
    const readChain = (start, size) =>
        join(
            chainOf(fat, start).map((id) => readSector(id)),
            size
        );

    // Directory: 128 byte entries
    const directory = readChain(view.getUint32(0x30, true));
    const dirView = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
    const entries = [];
    for (let at = 0; at + 128 <= directory.length; at += 128) {
        const nameLength = dirView.getUint16(at + 0x40, true);
        let name = "";
        for (let i = 0; i + 2 <= Math.max(0, nameLength - 2); i += 2) {
            name += String.fromCharCode(dirView.getUint16(at + i, true));
        }
        entries.push({
            name,
            type: directory[at + 0x42],
            start: dirView.getUint32(at + 0x74, true),
            size: dirView.getUint32(at + 0x78, true),
        });
    }

    let miniStream = null;
    let miniFat = null;
    const loadMini = () => {
        if (miniStream) {
            return;
        }
        const root = entries.find((e) => e.type === 5);
        if (!root) {
            throw xlsError("susunan berkas tidak dikenal");
        }
        miniStream = readChain(root.start, root.size);
        miniFat = u32List(readChain(view.getUint32(0x3c, true)));
    };

    return {
        stream(name) {
            const entry = entries.find((e) => e.type === 2 && e.name === name);
            if (!entry) {
                return null;
            }
            if (entry.size >= miniCutoff) {
                return readChain(entry.start, entry.size);
            }
            loadMini();
            return join(
                chainOf(miniFat, entry.start).map((id) =>
                    miniStream.subarray(id * miniSectorSize, (id + 1) * miniSectorSize)
                ),
                entry.size
            );
        },
    };
}

/**
 * Read the records of a BIFF stream from a position until the end of the substream that starts there.
 * @param {Uint8Array} stream Workbook stream
 * @param {number} from Position of the first record (a BOF)
 * @returns {{type: number, data: Uint8Array}[]} Records, including CONTINUE records, up to and including the last EOF
 */
function readRecords(stream, from) {
    const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    const records = [];
    let depth = 0;
    for (let at = from; at + 4 <= stream.length;) {
        const type = view.getUint16(at, true);
        const length = view.getUint16(at + 2, true);
        if (at + 4 + length > stream.length) {
            throw xlsError("berkas terpotong");
        }
        const data = stream.subarray(at + 4, at + 4 + length);
        records.push({ type, data });
        at += 4 + length;
        if (type === REC.BOF) {
            depth++;
        } else if (type === REC.EOF) {
            depth--;
            if (depth <= 0) {
                break;
            }
        }
    }
    return records;
}

/**
 * Reads strings that may continue in the next CONTINUE record. A string that is cut by a record boundary starts the
 * next record with one byte that tells whether the rest is written as 16 bit characters.
 */
class ChunkReader {
    /**
     * @param {Uint8Array[]} chunks Data of the first record and of the CONTINUE records after it
     * @param {number} offset Position in the first chunk
     */
    constructor(chunks, offset = 0) {
        this.chunks = chunks;
        this.index = 0;
        this.offset = offset;
    }

    /**
     * @returns {boolean} True when there is nothing more to read
     */
    done() {
        while (this.index < this.chunks.length && this.offset >= this.chunks[this.index].length) {
            this.index++;
            this.offset = 0;
        }
        return this.index >= this.chunks.length;
    }

    /**
     * @returns {number} Next byte
     */
    u8() {
        if (this.done()) {
            throw xlsError("daftar teks terpotong");
        }
        return this.chunks[this.index][this.offset++];
    }

    /**
     * @returns {number} Next 16 bit number
     */
    u16() {
        return this.u8() | (this.u8() << 8);
    }

    /**
     * @returns {number} Next 32 bit number
     */
    u32() {
        return (this.u16() | (this.u16() << 16)) >>> 0;
    }

    /**
     * @param {number} count Bytes to skip
     * @returns {void}
     */
    skip(count) {
        for (let left = count; left > 0;) {
            if (this.done()) {
                throw xlsError("daftar teks terpotong");
            }
            const step = Math.min(left, this.chunks[this.index].length - this.offset);
            this.offset += step;
            left -= step;
        }
    }

    /**
     * Read a string as BIFF8 writes it: length (16 bit), flags, optional counts, characters, formatting runs.
     * @param {number} lengthBytes How many bytes the length takes (2 for strings in the SST, 2 for LABEL and STRING)
     * @returns {string} The text
     */
    string(lengthBytes = 2) {
        const length = lengthBytes === 1 ? this.u8() : this.u16();
        const flags = this.u8();
        let wide = (flags & 0x01) !== 0;
        const runs = flags & 0x08 ? this.u16() : 0;
        const extra = flags & 0x04 ? this.u32() : 0;
        let text = "";
        for (let left = length; left > 0;) {
            if (this.done()) {
                throw xlsError("daftar teks terpotong");
            }
            if (this.offset === 0 && this.index > 0 && left < length) {
                // Continued in the next record: it starts with the flag of the characters that follow
                wide = (this.chunks[this.index][this.offset++] & 0x01) !== 0;
                continue;
            }
            const chunk = this.chunks[this.index];
            const size = wide ? 2 : 1;
            const fit = Math.min(left, Math.floor((chunk.length - this.offset) / size));
            if (fit === 0) {
                // A 16 bit character cut in two cannot happen in a valid file
                throw xlsError("teks rusak");
            }
            for (let i = 0; i < fit; i++) {
                text += String.fromCharCode(
                    wide ? chunk[this.offset + i * 2] | (chunk[this.offset + i * 2 + 1] << 8) : chunk[this.offset + i]
                );
            }
            this.offset += fit * size;
            left -= fit;
        }
        this.skip(runs * 4 + extra);
        return text;
    }
}

/**
 * @param {number} rk RK value (a number packed in 32 bits)
 * @returns {number} The number
 */
function decodeRk(rk) {
    let value;
    if (rk & 0x02) {
        value = rk >> 2;
    } else {
        const buffer = new DataView(new ArrayBuffer(8));
        buffer.setUint32(4, (rk & 0xfffffffc) >>> 0, true);
        value = buffer.getFloat64(0, true);
    }
    return rk & 0x01 ? value / 100 : value;
}

/**
 * Collect the strings of the shared string table (SST), with their CONTINUE records.
 * @param {{type: number, data: Uint8Array}[]} records Records of the workbook globals
 * @returns {string[]} The strings by index
 */
function readSharedStrings(records) {
    const start = records.findIndex((r) => r.type === REC.SST);
    if (start < 0) {
        return [];
    }
    const chunks = [records[start].data];
    for (let i = start + 1; i < records.length && records[i].type === REC.CONTINUE; i++) {
        chunks.push(records[i].data);
    }
    const reader = new ChunkReader(chunks, 8);
    const unique = new DataView(chunks[0].buffer, chunks[0].byteOffset, chunks[0].byteLength).getUint32(4, true);
    const strings = [];
    for (let i = 0; i < unique && !reader.done(); i++) {
        strings.push(reader.string());
    }
    return strings;
}

/**
 * Read the first visible worksheet of an .xls file.
 * @param {ArrayBuffer|Uint8Array} input File content
 * @param {number} maxRows Most rows to read (default 20000)
 * @returns {(string|number|boolean|null)[][]} Rows of cells; an empty cell is null
 * @throws {Error} With `code` "xls" when the file is not a readable .xls file (also an encrypted one or one from Excel 5)
 */
export function parseXls(input, maxRows = 20000) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const file = openCompoundFile(bytes);
    const book = file.stream("Workbook");
    if (!book) {
        throw xlsError(file.stream("Book") ? "format Excel 5 tidak didukung" : "tidak ada lembar kerja");
    }
    if (book.length < 4 || new DataView(book.buffer, book.byteOffset).getUint16(0, true) !== REC.BOF) {
        throw xlsError("isi berkas tidak dikenal");
    }

    const globals = readRecords(book, 0);
    if (globals.some((r) => r.type === REC.FILEPASS)) {
        throw xlsError("berkas dilindungi sandi");
    }
    const strings = readSharedStrings(globals);
    const sheets = globals
        .filter((r) => r.type === REC.BOUNDSHEET)
        .map((r) => {
            const v = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
            return { offset: v.getUint32(0, true), hidden: r.data[4] & 0x03, kind: r.data[5] };
        })
        .filter((s) => s.kind === 0);
    const sheet = sheets.find((s) => s.hidden === 0) || sheets[0];
    if (!sheet) {
        throw xlsError("tidak ada lembar kerja");
    }

    const records = readRecords(book, sheet.offset);
    const rows = [];
    const put = (row, col, value) => {
        if (row >= maxRows) {
            return;
        }
        while (rows.length <= row) {
            rows.push([]);
        }
        const cells = rows[row];
        while (cells.length < col) {
            cells.push(null);
        }
        cells[col] = value;
    };

    for (let i = 0; i < records.length; i++) {
        const { type, data } = records[i];
        const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
        if (type === REC.LABELSST) {
            put(v.getUint16(0, true), v.getUint16(2, true), strings[v.getUint32(6, true)] ?? null);
        } else if (type === REC.LABEL || type === REC.RSTRING) {
            const chunks = [data.subarray(6)];
            for (let j = i + 1; j < records.length && records[j].type === REC.CONTINUE; j++) {
                chunks.push(records[j].data);
            }
            put(v.getUint16(0, true), v.getUint16(2, true), new ChunkReader(chunks).string());
        } else if (type === REC.NUMBER) {
            put(v.getUint16(0, true), v.getUint16(2, true), v.getFloat64(6, true));
        } else if (type === REC.RK) {
            put(v.getUint16(0, true), v.getUint16(2, true), decodeRk(v.getUint32(6, true)));
        } else if (type === REC.MULRK) {
            const row = v.getUint16(0, true);
            const first = v.getUint16(2, true);
            const count = (data.length - 6) / 6;
            for (let k = 0; k < count; k++) {
                put(row, first + k, decodeRk(v.getUint32(4 + k * 6 + 2, true)));
            }
        } else if (type === REC.BOOLERR) {
            // An error such as #N/A is left empty
            put(v.getUint16(0, true), v.getUint16(2, true), data[7] === 0 ? data[6] !== 0 : null);
        } else if (type === REC.FORMULA) {
            const row = v.getUint16(0, true);
            const col = v.getUint16(2, true);
            if (data[12] === 0xff && data[13] === 0xff) {
                if (data[6] === 0) {
                    // The text of the result is in the STRING record that follows
                    const next = records[i + 1];
                    if (next && next.type === REC.STRING) {
                        const chunks = [next.data];
                        for (let j = i + 2; j < records.length && records[j].type === REC.CONTINUE; j++) {
                            chunks.push(records[j].data);
                        }
                        put(row, col, new ChunkReader(chunks).string());
                    }
                } else if (data[6] === 1) {
                    put(row, col, data[8] !== 0);
                } else if (data[6] === 3) {
                    put(row, col, "");
                }
            } else {
                put(row, col, v.getFloat64(6, true));
            }
        }
    }
    return rows;
}
