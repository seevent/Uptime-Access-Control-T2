"use strict";

const fs = require("fs");
const path = require("path");

/** Packages that are only for development and must not be in the program folder. */
const FORBIDDEN_PACKAGES = ["vite", "vue", "eslint", "@playwright/test"];

/** Folders of the project that must not be copied into the program folder. */
const FORBIDDEN_APP_FOLDERS = ["test", "docs", "data"];

/**
 * Read the first bytes of a file, or null when it cannot be read.
 * @param {string} file The file
 * @param {number} length How many bytes
 * @returns {Buffer|null} The bytes read (possibly fewer than asked)
 */
function readHead(file, length) {
    let fd = null;
    try {
        fd = fs.openSync(file, "r");
        const buf = Buffer.alloc(length);
        const read = fs.readSync(fd, buf, 0, length, 0);
        return buf.subarray(0, read);
    } catch (_) {
        return null;
    } finally {
        if (fd !== null) {
            fs.closeSync(fd);
        }
    }
}

/**
 * Tell whether a file is a 64-bit x86 Windows program or library (PE).
 * @param {string} file The file
 * @returns {boolean} True for PE x64
 */
function isPeX64(file) {
    const head = readHead(file, 0x400);
    if (!head || head.length < 0x40 || head.toString("latin1", 0, 2) !== "MZ") {
        return false;
    }
    const peOffset = head.readUInt32LE(0x3c);
    if (peOffset + 6 > head.length || head.toString("latin1", peOffset, peOffset + 4) !== "PE\0\0") {
        return false;
    }
    return head.readUInt16LE(peOffset + 4) === 0x8664;
}

/**
 * Tell whether a file is an ELF binary (Linux).
 * @param {string} file The file
 * @returns {boolean} True for ELF
 */
function isElf(file) {
    const head = readHead(file, 4);
    return !!head && head.length === 4 && head[0] === 0x7f && head.toString("latin1", 1, 4) === "ELF";
}

/**
 * List every .node file below a folder, as paths relative to a base, with /.
 * @param {string} dir Folder to walk
 * @param {string} base Folder the results are relative to
 * @returns {string[]} The files
 */
function findNodeFiles(dir, base) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            found.push(...findNodeFiles(full, base));
        } else if (entry.isFile() && entry.name.endsWith(".node")) {
            found.push(path.relative(base, full).split(path.sep).join("/"));
        }
    }
    return found;
}

/**
 * Check that an assembled program folder holds exactly what the platform needs.
 * @param {object} options What to check
 * @param {string} options.dir The assembled folder (holds app/, and node/, tools/, service/ for win32)
 * @param {"win32"|"linux"} options.platform The platform it is meant for
 * @returns {{ok: boolean, problems: string[]}} The verdict and one sentence per problem, each starting with the path
 */
function checkPayload({ dir, platform }) {
    const problems = [];
    const exists = (rel) => fs.existsSync(path.join(dir, ...rel.split("/")));
    const need = (rel, why) => {
        if (!exists(rel)) {
            problems.push(`${rel}: tidak ada (${why})`);
        }
    };
    const isNative = platform === "win32" ? isPeX64 : isElf;
    const nativeName = platform === "win32" ? "PE x64 (Windows)" : "ELF (Linux)";

    need("app/server/server.js", "titik masuk server");
    need("app/dist/index.html", "tampilan web yang sudah dibangun");
    need("app/src/util.ts", "dipakai server saat berjalan");
    need("app/package.json", "daftar paket");
    need("app/uac-guard.cjs", "pembatas pencarian modul, dimuat lebih dulu oleh layanan");
    need("app/node_modules/tsx", "penjalan TypeScript");
    need(`app/node_modules/@esbuild/${platform}-x64`, `esbuild untuk ${platform}`);

    const sqlite = "app/node_modules/better-sqlite3/build/Release/better_sqlite3.node";
    if (!exists(sqlite)) {
        problems.push(`${sqlite}: tidak ada (mesin basis data)`);
    } else if (!isNative(path.join(dir, ...sqlite.split("/")))) {
        problems.push(`${sqlite}: bukan berkas ${nativeName}`);
    }

    if (platform === "win32") {
        const nodeExe = "node/node.exe";
        if (!exists(nodeExe)) {
            problems.push(`${nodeExe}: tidak ada (Node.js bawaan)`);
        } else if (!isPeX64(path.join(dir, nodeExe))) {
            problems.push(`${nodeExe}: bukan berkas PE x64 (Windows)`);
        }
        const winswExe = "service/UptimeAccessControlT2.exe";
        if (!exists(winswExe)) {
            problems.push(`${winswExe}: tidak ada (pembungkus layanan)`);
        } else if (!isPeAny(path.join(dir, winswExe))) {
            problems.push(`${winswExe}: bukan berkas program Windows`);
        }
        need("service/service.xml.template", "templat konfigurasi layanan");
        need("tools/cli.js", "alat pemasang");
        need("tools/data.js", "alat pemasang");
        need("tools/service.js", "alat pemasang");
        need("tools/Pindahkan-Data.cmd", "skrip pindah data");
        need("LICENSES", "lisensi komponen");
    }

    for (const folder of FORBIDDEN_APP_FOLDERS) {
        if (exists(`app/${folder}`)) {
            problems.push(`app/${folder}: tidak boleh ikut dalam paket`);
        }
    }
    for (const name of FORBIDDEN_PACKAGES) {
        if (exists(`app/node_modules/${name}`)) {
            problems.push(`app/node_modules/${name}: paket pengembangan, tidak boleh ikut`);
        }
    }

    const esbuildDir = path.join(dir, "app", "node_modules", "@esbuild");
    if (fs.existsSync(esbuildDir)) {
        for (const name of fs.readdirSync(esbuildDir)) {
            if (name !== `${platform}-x64`) {
                problems.push(`app/node_modules/@esbuild/${name}: esbuild untuk platform lain`);
            }
        }
    }

    const modules = path.join(dir, "app", "node_modules");
    if (fs.existsSync(modules)) {
        for (const rel of findNodeFiles(modules, dir)) {
            if (rel === sqlite) {
                continue;
            }
            if (!rel.endsWith(`-${platform}-x64.node`)) {
                problems.push(`${rel}: berkas native milik sistem lain`);
            } else if (!isNative(path.join(dir, ...rel.split("/")))) {
                problems.push(`${rel}: bukan berkas ${nativeName}`);
            }
        }
    }

    return { ok: problems.length === 0, problems };
}

/**
 * Tell whether a file is any Windows PE program (the service wrapper may be built for AnyCPU).
 * @param {string} file The file
 * @returns {boolean} True for a PE file
 */
function isPeAny(file) {
    const head = readHead(file, 0x400);
    if (!head || head.length < 0x40 || head.toString("latin1", 0, 2) !== "MZ") {
        return false;
    }
    const peOffset = head.readUInt32LE(0x3c);
    return peOffset + 4 <= head.length && head.toString("latin1", peOffset, peOffset + 4) === "PE\0\0";
}

module.exports = { checkPayload, isPeX64, isElf };
