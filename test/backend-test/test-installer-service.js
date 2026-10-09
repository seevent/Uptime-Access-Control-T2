const { describe, test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const net = require("net");
const { execFileSync } = require("child_process");
const {
    renderServiceXml,
    makeServiceControl,
    waitForHttp,
    isPortFree,
} = require("../../installer/payload/tools/service.js");
const { parseArgs, main } = require("../../installer/payload/tools/cli.js");

const TEMPLATE_FILE = path.join(__dirname, "..", "..", "installer", "service.xml.template");
const CMD_FILE = path.join(__dirname, "..", "..", "installer", "payload", "tools", "Pindahkan-Data.cmd");
const template = fs.readFileSync(TEMPLATE_FILE, "utf8");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uac-service-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const BASE = {
    template,
    installDir: "C:\\Program Files\\Uptime Access Control T2",
    dataDir: "C:\\ProgramData\\UptimeAccessControlT2\\data",
    logDir: "C:\\ProgramData\\UptimeAccessControlT2\\logs",
    port: "3001",
    access: "subnet",
};

/**
 * Pretend to be sc.exe: answers `query` from a list of states and records every call.
 * @param {string[]} states What each successive `query` reports ("MISSING" gives exit code 1060)
 * @returns {{exec: Function, calls: string[][], sleeps: number[], sleep: Function}} The double
 */
function fakeSc(states) {
    const calls = [];
    const sleeps = [];
    let queryIndex = 0;
    return {
        calls,
        sleeps,
        sleep: async (ms) => {
            sleeps.push(ms);
        },
        exec: async (cmd, args) => {
            calls.push([cmd, ...args]);
            if (args[0] === "query") {
                const state = states[Math.min(queryIndex++, states.length - 1)];
                if (state === "MISSING") {
                    return { code: 1060, stdout: "[SC] EnumQueryServicesStatus:OpenService FAILED 1060" };
                }
                return { code: 0, stdout: `SERVICE_NAME: X\n        STATE              : 4  ${state}\n` };
            }
            return { code: 0, stdout: "" };
        },
    };
}

describe("renderServiceXml", () => {
    test("renderServiceXml fills every token and leaves none behind", () => {
        const xml = renderServiceXml(BASE);
        assert.doesNotMatch(xml, /@[A-Z_]+@/);
        assert.match(xml, /<id>UptimeAccessControlT2<\/id>/);
        assert.match(xml, /<env name="UPTIME_KUMA_DB_TYPE" value="sqlite"\s*\/>/);
        assert.match(xml, /<env name="NODE_ENV" value="production"\s*\/>/);
        assert.match(xml, /<env name="UPTIME_KUMA_PORT" value="3001"\s*\/>/);
        assert.match(
            xml,
            /<env name="KUMA_SKIP_HIBP" value="1"\s*\/>/,
            "an offline LAN cannot reach the password-breach check"
        );
        assert.match(xml, /--import=tsx server\/server\.js/);
        assert.match(xml, /<arguments>--require \.\/uac-guard\.cjs --import=tsx/, "the guard is loaded first");
        assert.match(xml, /<stoptimeout>20 sec<\/stoptimeout>/);
        assert.match(xml, /C:\\Program Files\\Uptime Access Control T2\\node\\node\.exe/);
        const failures = [...xml.matchAll(/<onfailure action="restart" delay="(\d+) sec"\s*\/>/g)].map((m) => m[1]);
        assert.deepEqual(failures, ["10", "10", "10", "60"]);
    });

    test("renderServiceXml adds UPTIME_KUMA_HOST only for access lokal", () => {
        assert.match(
            renderServiceXml({ ...BASE, access: "lokal" }),
            /<env name="UPTIME_KUMA_HOST" value="127\.0\.0\.1"\s*\/>/
        );
        assert.doesNotMatch(renderServiceXml({ ...BASE, access: "subnet" }), /UPTIME_KUMA_HOST/);
        assert.doesNotMatch(renderServiceXml({ ...BASE, access: "semua" }), /UPTIME_KUMA_HOST/);
    });

    test("renderServiceXml escapes paths with spaces, ampersand, quote and non-ASCII", () => {
        const dataDir = "C:\\Users\\Yuli Syarif\\Downloads\\Monitoring Network & Co\\data'é\"";
        const xml = renderServiceXml({ ...BASE, dataDir });
        assert.ok(xml.includes("Monitoring Network &amp; Co\\data&apos;é&quot;"));
        assert.ok(xml.includes("C:\\Users\\Yuli Syarif\\Downloads"));
        assert.doesNotMatch(xml, /Network & Co/);
    });

    test("renderServiceXml rejects bad ports", () => {
        for (const port of ["", "abc", 0, 65536, 3001.5, -1, "3001.5", " 3001", "0x10"]) {
            assert.throws(
                () => renderServiceXml({ ...BASE, port }),
                /Port tidak valid/,
                `port ${JSON.stringify(port)}`
            );
        }
        assert.match(renderServiceXml({ ...BASE, port: "3001" }), /value="3001"/);
        assert.match(renderServiceXml({ ...BASE, port: 65535 }), /value="65535"/);
        assert.throws(() => renderServiceXml({ ...BASE, access: "x" }), /Akses tidak valid/);
    });
});

describe("service control", () => {
    test("state finds the state word even when sc.exe prints a localized label", async () => {
        const exec = (text) => async () => ({ code: 0, stdout: text });
        for (const label of ["STATE", "ZUSTAND", "ETAT", "STATUS", "KEADAAN"]) {
            const out = `SERVICE_NAME: X\n        TYPE               : 10  WIN32_OWN_PROCESS\n        ${label}              : 3  STOP_PENDING\n`;
            assert.equal(await makeServiceControl({ name: "X", exec: exec(out) }).state(), "STOP_PENDING", label);
        }
        assert.equal(await makeServiceControl({ name: "X", exec: exec("tidak dikenal") }).state(), "UNKNOWN");
    });

    test("state reports MISSING for exit code 1060 and parses the state name", async () => {
        assert.equal(await makeServiceControl({ name: "X", ...fakeSc(["MISSING"]) }).state(), "MISSING");
        assert.equal(await makeServiceControl({ name: "X", ...fakeSc(["RUNNING"]) }).state(), "RUNNING");
    });

    test("service control stop waits for STOPPED, does nothing when already stopped or missing, and times out", async () => {
        const waiting = fakeSc(["RUNNING", "STOP_PENDING", "STOP_PENDING", "STOPPED"]);
        await makeServiceControl({ name: "X", ...waiting }).stop();
        assert.equal(waiting.calls.filter((c) => c[1] === "stop").length, 1);
        assert.ok(waiting.sleeps.length >= 2);

        for (const state of ["STOPPED", "MISSING"]) {
            const idle = fakeSc([state]);
            await makeServiceControl({ name: "X", ...idle }).stop();
            assert.equal(idle.calls.filter((c) => c[1] === "stop").length, 0, state);
        }

        const stuck = fakeSc(["RUNNING", "STOP_PENDING"]);
        await assert.rejects(
            makeServiceControl({ name: "UptimeAccessControlT2", timeoutMs: 3000, ...stuck }).stop(),
            /UptimeAccessControlT2 tidak berhenti dalam 3 detik/
        );
        assert.ok(stuck.sleeps.reduce((a, b) => a + b, 0) >= 3000);
    });

    test("service control start throws Layanan UptimeAccessControlT2 belum terpasang when missing", async () => {
        const missing = fakeSc(["MISSING"]);
        await assert.rejects(
            makeServiceControl({ name: "UptimeAccessControlT2", ...missing }).start(),
            new Error("Layanan UptimeAccessControlT2 belum terpasang")
        );

        const stopped = fakeSc(["STOPPED"]);
        await makeServiceControl({ name: "X", ...stopped }).start();
        assert.equal(stopped.calls.filter((c) => c[1] === "start").length, 1);

        const running = fakeSc(["RUNNING"]);
        await makeServiceControl({ name: "X", ...running }).start();
        assert.equal(running.calls.filter((c) => c[1] === "start").length, 0);
    });
});

describe("waitForHttp", () => {
    test("waitForHttp is true after a few refused tries, false after the timeout", async () => {
        let tries = 0;
        const sleeps = [];
        const sleep = async (ms) => {
            sleeps.push(ms);
        };
        const flaky = async () => {
            if (++tries <= 3) {
                throw new Error("ECONNREFUSED");
            }
            return { status: 500 };
        };
        assert.equal(await waitForHttp({ url: "http://x/", fetchFn: flaky, sleep }), true, "any HTTP answer counts");
        assert.equal(sleeps.length, 3);

        const dead = async () => {
            throw new Error("ECONNREFUSED");
        };
        sleeps.length = 0;
        const result = await waitForHttp({ url: "http://x/", timeoutMs: 5000, intervalMs: 1000, fetchFn: dead, sleep });
        assert.equal(result, false);
        assert.ok(sleeps.reduce((a, b) => a + b, 0) >= 5000);
        assert.ok(sleeps.length <= 6);
    });
});

describe("cli", () => {
    /**
     * Collect what main prints.
     * @returns {{out: string[], deps: object}} The collected lines and base deps
     */
    function collector() {
        const out = [];
        return {
            out,
            deps: {
                log: (m) => out.push(String(m)),
                error: (m) => out.push(String(m)),
                sleep: async () => {},
                env: {},
            },
        };
    }

    test("parseArgs handles --key value, --flag and positionals", () => {
        assert.deepEqual(
            parseArgs(["migrate", "--source", "C:\\old data", "--yes", "--port=3002", "extra", "--force"]),
            {
                _: ["migrate", "extra"],
                flags: { source: "C:\\old data", yes: true, port: "3002", force: true },
            }
        );
        assert.deepEqual(parseArgs([]), { _: [], flags: {} });
    });

    test("main wait returns 1 on timeout and 0 on answer", async () => {
        const { out, deps } = collector();
        const dead = async () => {
            throw new Error("ECONNREFUSED");
        };
        assert.equal(await main(["wait", "--url", "http://x/", "--timeout", "3"], { ...deps, fetchFn: dead }), 1);
        assert.match(out.join("\n"), /tidak menjawab/);
        const alive = async () => ({ status: 200 });
        assert.equal(await main(["wait", "--url", "http://x/", "--timeout", "3"], { ...deps, fetchFn: alive }), 0);
    });

    test("main render-service writes the file", async () => {
        const { deps } = collector();
        const outFile = path.join(tmpRoot, "layanan.xml");
        const code = await main(
            [
                "render-service",
                "--template",
                TEMPLATE_FILE,
                "--out",
                outFile,
                "--install-dir",
                BASE.installDir,
                "--data-dir",
                "D:\\Lain\\data",
                "--log-dir",
                "D:\\Lain\\logs",
                "--port",
                "3055",
                "--access",
                "lokal",
            ],
            deps
        );
        assert.equal(code, 0);
        const xml = fs.readFileSync(outFile, "utf8");
        assert.match(xml, /value="3055"/);
        assert.ok(xml.includes(`<env name="DATA_DIR" value="D:\\Lain\\data"/>`), "--data-dir reaches the XML");
        assert.ok(xml.includes(`<logpath>D:\\Lain\\logs</logpath>`));
        assert.match(xml, /127\.0\.0\.1/);

        const bad = await main(
            ["render-service", "--template", TEMPLATE_FILE, "--out", outFile, "--port", "abc"],
            deps
        );
        assert.equal(bad, 1);
    });

    test("main backup saves the data folder", async () => {
        const { out, deps } = collector();
        const data = path.join(tmpRoot, "data-backup");
        fs.mkdirSync(data);
        fs.writeFileSync(path.join(data, "db-config.json"), "{}");
        assert.equal(await main(["backup", "--data", data, "--label", "sebelum-upgrade"], deps), 0);
        assert.match(out.join("\n"), /sebelum-upgrade-/);
        assert.equal(fs.readdirSync(path.join(data, "backup")).length, 1);

        const empty = path.join(tmpRoot, "data-empty");
        fs.mkdirSync(empty);
        assert.equal(await main(["backup", "--data", empty], deps), 0);
        assert.equal(fs.existsSync(path.join(empty, "backup")), false);
    });

    test("main migrate with --source --yes calls migrate with the service control", async () => {
        const { out, deps } = collector();
        const service = { state: async () => "RUNNING", stop: async () => {}, start: async () => {} };
        let received;
        const migrate = async (options) => {
            received = options;
            return {
                backupDir: "C:\\cadangan",
                counts: { monitor: 3, heartbeat: 5, network_device: 2, network_category: 1 },
            };
        };

        const code = await main(["migrate", "--source", "D:\\Kuma Lama\\data", "--data", "E:\\baru", "--yes"], {
            ...deps,
            service,
            migrate,
        });

        assert.equal(code, 0);
        assert.equal(received.source, "D:\\Kuma Lama\\data");
        assert.equal(received.dest, "E:\\baru");
        assert.equal(received.service, service);
        assert.equal(received.force, false);
        const printed = out.join("\n");
        assert.match(printed, /3/);
        assert.match(printed, /C:\\cadangan/);
    });

    test("main migrate asks for the source when it is missing", async () => {
        const { deps } = collector();
        const service = { state: async () => "RUNNING", stop: async () => {}, start: async () => {} };
        let received = null;
        const migrate = async (options) => {
            received = options;
            return { backupDir: null, counts: { monitor: 0, heartbeat: 0, network_device: 0, network_category: 0 } };
        };
        const answers = ['  "C:\\Kuma lama\\data"  ', "y"];
        const ask = async () => answers.shift();

        assert.equal(await main(["migrate", "--data", "E:\\baru"], { ...deps, service, migrate, ask }), 0);
        assert.equal(received.source, "C:\\Kuma lama\\data");

        received = null;
        const no = ['"C:\\x"', "n"];
        assert.equal(
            await main(["migrate", "--data", "E:\\baru"], { ...deps, service, migrate, ask: async () => no.shift() }),
            1
        );
        assert.equal(received, null, "declining stops before anything is touched");

        assert.equal(
            await main(["migrate", "--data", "E:\\baru"], { ...deps, service, migrate, ask: async () => "" }),
            1
        );
        assert.equal(received, null);
    });

    test("main migrate stops when the service is not installed, and reports a failed migrate", async () => {
        const { out, deps } = collector();
        let called = false;
        const migrate = async () => {
            called = true;
            throw new Error("Folder sumber dan tujuan sama");
        };
        const missing = { state: async () => "MISSING", stop: async () => {}, start: async () => {} };
        assert.equal(await main(["migrate", "--source", "S", "--yes"], { ...deps, service: missing, migrate }), 1);
        assert.match(out.join("\n"), /belum terpasang/);
        assert.equal(called, false);

        const present = { ...missing, state: async () => "RUNNING" };
        assert.equal(await main(["migrate", "--source", "S", "--yes"], { ...deps, service: present, migrate }), 1);
        assert.match(out.join("\n"), /Gagal: Folder sumber dan tujuan sama/);
    });

    test("main migrate uses a no-op service when UAC_FAKE_SERVICE=1", async () => {
        const { deps } = collector();
        let service;
        const migrate = async (options) => {
            service = options.service;
            return { backupDir: null, counts: { monitor: 0, heartbeat: 0, network_device: 0, network_category: 0 } };
        };
        const code = await main(["migrate", "--source", "S", "--yes"], {
            ...deps,
            env: { UAC_FAKE_SERVICE: "1" },
            migrate,
        });
        assert.equal(code, 0);
        await service.stop();
        await service.start();
        assert.equal(await service.state(), "RUNNING");
    });

    test("main with an unknown command prints usage and returns 1", async () => {
        const { out, deps } = collector();
        assert.equal(await main(["bukan-perintah"], deps), 1);
        assert.match(out.join("\n"), /Pemakaian/);
        out.length = 0;
        assert.equal(await main([], deps), 1);
        assert.match(out.join("\n"), /Pemakaian/);
    });
});

describe("cli: stopping, waiting for removal and checking the port", () => {
    /**
     * Collect what main prints.
     * @returns {{out: string[], deps: object}} The collected lines and base deps
     */
    function collector() {
        const out = [];
        return {
            out,
            deps: {
                log: (m) => out.push(String(m)),
                error: (m) => out.push(String(m)),
                sleep: async () => {},
                env: {},
            },
        };
    }

    test("main stop-service stops the service and does not fail when it is missing", async () => {
        const { deps } = collector();
        let stops = 0;
        const service = { state: async () => "RUNNING", stop: async () => void stops++, start: async () => {} };
        assert.equal(await main(["stop-service"], { ...deps, service }), 0);
        assert.equal(stops, 1);
        const stuck = {
            ...service,
            stop: async () => {
                throw new Error("Layanan X tidak berhenti dalam 30 detik");
            },
        };
        const { out, deps: deps2 } = collector();
        assert.equal(await main(["stop-service"], { ...deps2, service: stuck }), 1);
        assert.match(out.join("\n"), /tidak berhenti/);
    });

    test("main wait-service-gone polls until the service is no longer registered, and times out", async () => {
        const { deps } = collector();
        const states = ["STOP_PENDING", "STOPPED", "MISSING"];
        const service = { state: async () => states.shift() ?? "MISSING", stop: async () => {}, start: async () => {} };
        assert.equal(await main(["wait-service-gone", "--timeout", "30"], { ...deps, service }), 0);
        assert.equal(states.length, 0);

        const { out, deps: deps2 } = collector();
        const stays = { ...service, state: async () => "STOPPED" };
        assert.equal(await main(["wait-service-gone", "--timeout", "3"], { ...deps2, service: stays }), 1);
        assert.match(out.join("\n"), /masih terdaftar/);
    });

    test("main check-port fails while something listens on the port and passes when it is free", async () => {
        const holder = net.createServer();
        await new Promise((resolve) => holder.listen(0, resolve));
        const port = holder.address().port;
        const { out, deps } = collector();
        try {
            assert.equal(await main(["check-port", "--port", String(port)], deps), 1);
            assert.match(out.join("\n"), new RegExp(`${port}.*dipakai`));
            assert.equal(await isPortFree({ port }), false);
        } finally {
            await new Promise((resolve) => holder.close(resolve));
        }
        assert.equal(await main(["check-port", "--port", String(port)], deps), 0);
        assert.equal(await isPortFree({ port }), true);
        assert.equal(await main(["check-port", "--port", "abc"], deps), 1);
        assert.equal(await main(["check-port", "--port", "0"], deps), 1);
    });

    test("main default data folder follows %ProgramData%", async () => {
        const { out, deps } = collector();
        const data = path.join(tmpRoot, "programdata-test");
        fs.mkdirSync(path.join(data, "UptimeAccessControlT2", "data"), { recursive: true });
        fs.writeFileSync(path.join(data, "UptimeAccessControlT2", "data", "db-config.json"), "{}");
        const code = await main(["backup"], { ...deps, env: { ProgramData: data } });
        assert.equal(code, 0);
        assert.match(out.join("\n"), /Cadangan dibuat/);
    });
});

describe("uac-guard.cjs", () => {
    test("uac-guard.cjs stops module lookup at the install folder", () => {
        const root = fs.mkdtempSync(path.join(tmpRoot, "guard-"));
        const stub = (dir, text) => {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "index.js"), `module.exports = ${JSON.stringify(text)};`);
        };
        stub(path.join(root, "node_modules", "evil"), "evil"); // what a local user could plant in C:\\node_modules
        const app = path.join(root, "install", "app");
        stub(path.join(app, "node_modules", "foo"), "foo");
        fs.copyFileSync(
            path.join(__dirname, "..", "..", "installer", "payload", "uac-guard.cjs"),
            path.join(app, "uac-guard.cjs")
        );
        fs.writeFileSync(
            path.join(app, "probe.cjs"),
            'const r = (n) => { try { return require(n); } catch (e) { return "MISSING"; } };\nconsole.log(JSON.stringify([r("foo"), r("evil"), require("fs") === require("node:fs")]));'
        );

        const run = (args) =>
            JSON.parse(execFileSync(process.execPath, [...args, "probe.cjs"], { cwd: app }).toString());
        assert.deepEqual(run([]), ["foo", "evil", true], "without the guard the planted module is found (control)");
        assert.deepEqual(run(["--require", "./uac-guard.cjs"]), ["foo", "MISSING", true]);
    });
});

describe("Pindahkan-Data.cmd", () => {
    test("Pindahkan-Data.cmd elevates once, calls cli.js migrate and uses Windows line endings", () => {
        const text = fs.readFileSync(CMD_FILE, "utf8");
        assert.match(text, /Start-Process[^\r\n]*-Verb RunAs/);
        assert.match(text, /"%~dp0\.\.\\node\\node\.exe" "%~dp0cli\.js" migrate/);
        assert.match(text, /pause/);
        assert.ok(!/[^\r]\n/.test(text), "every line ends with CRLF");
        // "net session" fails for administrators too when the Server service is stopped, which made the script loop
        assert.doesNotMatch(text, /net session/);
        assert.match(text, /fltmc/);
        assert.match(text, /if \/i "%~1"=="--elevated" goto run/, "an elevated copy never elevates again");
        assert.match(text, /--elevated/);
        assert.ok(text.includes("%SELF:'=''%"), "a quote in the path is escaped for PowerShell");
    });
});

describe("installer: password breach check", () => {
    test("better-auth.ts only checks passwords online when KUMA_SKIP_HIBP is not 1", () => {
        const source = require("node:fs").readFileSync(
            require("node:path").join(__dirname, "../../server/better-auth.ts"),
            "utf8"
        );
        assert.match(source, /process\.env\.KUMA_SKIP_HIBP === "1" \? \[\] : \[haveIBeenPwned\(\)\]/);
    });
});
