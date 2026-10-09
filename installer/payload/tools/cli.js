"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const { SERVICE_NAME, renderServiceXml, makeServiceControl, waitForHttp, isPortFree } = require("./service.js");
const dataTools = require("./data.js");

/**
 * Default data or log folder, under %ProgramData% as the installer creates it.
 * @param {object} env Environment variables
 * @param {string} name "data" or "logs"
 * @returns {string} The folder
 */
function defaultDir(env, name) {
    return path.join(env.ProgramData || "C:\\ProgramData", "UptimeAccessControlT2", name);
}

const USAGE = `Pemakaian: node cli.js <perintah> [opsi]

  render-service --template <berkas> --out <berkas> [--install-dir <folder>] [--data-dir <folder>]
                 [--log-dir <folder>] [--port 3001] [--access lokal|subnet|semua]
  wait           [--url http://127.0.0.1:3001/] [--timeout 60]
  backup         [--data <folder>] [--label sebelum-upgrade]
  migrate        [--source <folder data Kuma lama>] [--data <folder>] [--yes] [--force]
  stop-service   (menghentikan layanan dan menunggu sampai benar-benar berhenti)
  wait-service-gone [--timeout 30]   (menunggu sampai layanan tidak lagi terdaftar)
  check-port     --port <port> [--access lokal|subnet|semua]`;

/**
 * Split command line arguments into positionals and flags.
 * @param {string[]} argv The arguments after the program name
 * @returns {{_: string[], flags: {[name: string]: string|true}}} Positionals and flags
 */
function parseArgs(argv) {
    const result = { _: [], flags: {} };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith("--")) {
            result._.push(arg);
            continue;
        }
        const equals = arg.indexOf("=");
        if (equals > 0) {
            result.flags[arg.slice(2, equals)] = arg.slice(equals + 1);
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
            result.flags[arg.slice(2)] = argv[++i];
        } else {
            result.flags[arg.slice(2)] = true;
        }
    }
    return result;
}

/**
 * Ask one question on the console.
 * @param {string} question The question
 * @returns {Promise<string>} The answer
 */
function defaultAsk(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

/**
 * Take the quotes and spaces off a path the user typed or pasted.
 * @param {string} text What was typed
 * @returns {string} The path
 */
function cleanPath(text) {
    return String(text || "")
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .trim();
}

/**
 * A service control that does nothing, for tests only (UAC_FAKE_SERVICE=1).
 * @returns {{state: function(): Promise<string>, stop: function(): Promise<void>, start: function(): Promise<void>}} The fake
 */
function fakeService() {
    return {
        state: async () => "RUNNING",
        stop: async () => {},
        start: async () => {},
    };
}

/**
 * Run one command of the installer helper.
 * @param {string[]} argv The arguments after the program name
 * @param {object} deps Replacements for the outside world, used by the tests
 * @returns {Promise<number>} The exit code, 0 for success
 */
async function main(argv, deps = {}) {
    const log = deps.log || ((message) => console.log(message));
    const error = deps.error || ((message) => console.error(message));
    const env = deps.env || process.env;
    const { _: positionals, flags } = parseArgs(argv);
    const command = positionals[0];
    const dataDir = typeof flags.data === "string" ? flags.data : env.DATA_DIR || defaultDir(env, "data");

    try {
        if (command === "render-service") {
            if (typeof flags.template !== "string" || typeof flags.out !== "string") {
                error("render-service butuh --template dan --out");
                return 1;
            }
            const xml = renderServiceXml({
                template: fs.readFileSync(flags.template, "utf8"),
                installDir:
                    typeof flags["install-dir"] === "string" ? flags["install-dir"] : path.resolve(__dirname, ".."),
                dataDir: typeof flags["data-dir"] === "string" ? flags["data-dir"] : dataDir,
                logDir: typeof flags["log-dir"] === "string" ? flags["log-dir"] : defaultDir(env, "logs"),
                port: flags.port === undefined ? "3001" : flags.port,
                access: typeof flags.access === "string" ? flags.access : "subnet",
            });
            fs.writeFileSync(flags.out, xml, "utf8");
            log(`Konfigurasi layanan ditulis ke ${flags.out}`);
            return 0;
        }

        if (command === "wait") {
            const url = typeof flags.url === "string" ? flags.url : "http://127.0.0.1:3001/";
            const seconds = typeof flags.timeout === "string" ? Number(flags.timeout) : 60;
            const answered = await waitForHttp({
                url,
                timeoutMs: (Number.isFinite(seconds) ? seconds : 60) * 1000,
                fetchFn: deps.fetchFn,
                sleep: deps.sleep,
            });
            if (!answered) {
                error(`Layanan tidak menjawab di ${url} dalam ${seconds} detik`);
                return 1;
            }
            log(`Layanan menjawab di ${url}`);
            return 0;
        }

        if (command === "backup") {
            const label = typeof flags.label === "string" ? flags.label : "sebelum-upgrade";
            const { backupDir } = await dataTools.backupData({ dataDir, label });
            log(backupDir ? `Cadangan dibuat: ${backupDir}` : "Tidak ada data untuk dicadangkan");
            return 0;
        }

        const getService = () =>
            deps.service || (env.UAC_FAKE_SERVICE === "1" ? fakeService() : makeServiceControl({ name: SERVICE_NAME }));

        if (command === "stop-service") {
            await getService().stop();
            log("Layanan berhenti");
            return 0;
        }

        if (command === "wait-service-gone") {
            const service = getService();
            const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
            const seconds = typeof flags.timeout === "string" ? Number(flags.timeout) : 30;
            for (let waited = 0; (await service.state()) !== "MISSING"; waited += 1000) {
                if (waited >= seconds * 1000) {
                    error(`Layanan ${SERVICE_NAME} masih terdaftar setelah ${seconds} detik`);
                    return 1;
                }
                await sleep(1000);
            }
            log("Layanan sudah tidak terdaftar");
            return 0;
        }

        if (command === "check-port") {
            const portText = String(flags.port);
            if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
                error("Port tidak valid");
                return 1;
            }
            const host = flags.access === "lokal" ? "127.0.0.1" : undefined;
            if (!(await isPortFree({ port: Number(portText), host }))) {
                error(
                    `Port ${portText} sedang dipakai program lain (mungkin Kuma lama yang masih berjalan). Hentikan program itu atau pilih port lain.`
                );
                return 1;
            }
            log(`Port ${portText} bebas`);
            return 0;
        }

        if (command === "migrate") {
            const service = getService();
            const migrate = deps.migrate || dataTools.migrate;
            const ask = deps.ask || defaultAsk;

            if ((await service.state()) === "MISSING") {
                error(`Layanan ${SERVICE_NAME} belum terpasang. Pasang aplikasinya lebih dulu.`);
                return 1;
            }

            let source = typeof flags.source === "string" ? cleanPath(flags.source) : "";
            if (!source) {
                source = cleanPath(await ask("Folder data Kuma lama (yang berisi kuma.db): "));
            }
            if (!source) {
                error("Folder sumber tidak diisi");
                return 1;
            }
            if (flags.yes !== true) {
                const answer = await ask(
                    `Data di ${dataDir} akan diganti dengan data dari ${source} (cadangan dibuat otomatis). Lanjutkan? (y/N): `
                );
                if (!/^(y|ya)$/i.test(String(answer || "").trim())) {
                    log("Dibatalkan, tidak ada yang diubah");
                    return 1;
                }
            }

            const result = await migrate({ source, dest: dataDir, service, force: flags.force === true, log });
            const c = result.counts;
            log(
                `Selesai. Monitor: ${c.monitor}, riwayat: ${c.heartbeat}, perangkat: ${c.network_device}, kategori: ${c.network_category}.`
            );
            log(
                result.backupDir
                    ? `Data tujuan sebelumnya dicadangkan di ${result.backupDir}`
                    : "Tidak ada data lama di tujuan, jadi tidak ada cadangan."
            );
            return 0;
        }

        error(USAGE);
        return 1;
    } catch (err) {
        error(`Gagal: ${err.message}`);
        return 1;
    }
}

module.exports = { parseArgs, main };

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    });
}
