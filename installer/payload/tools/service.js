"use strict";

const net = require("net");
const { execFile } = require("child_process");

/** Name of the Windows service the installer creates. */
const SERVICE_NAME = "UptimeAccessControlT2";

/** Values accepted for who may reach the web interface. */
const ACCESS_MODES = ["lokal", "subnet", "semua"];

/** Windows error code of "the service does not exist". */
const ERROR_SERVICE_DOES_NOT_EXIST = 1060;

/**
 * Write a text so it is safe inside an XML attribute or element.
 * @param {string} text The text
 * @returns {string} The escaped text
 */
function escapeXml(text) {
    return String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}

/**
 * Fill the WinSW configuration template.
 * @param {object} options The values to put in
 * @param {string} options.template Text of service.xml.template
 * @param {string} options.installDir Program folder
 * @param {string} options.dataDir Data folder
 * @param {string} options.logDir Log folder
 * @param {string|number} options.port TCP port of the web interface
 * @param {string} options.access "lokal", "subnet" or "semua"
 * @returns {string} The finished XML
 * @throws {Error} When the port or the access mode is not valid
 */
function renderServiceXml({ template, installDir, dataDir, logDir, port, access }) {
    const portText = String(port);
    if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
        throw new Error("Port tidak valid");
    }
    if (!ACCESS_MODES.includes(access)) {
        throw new Error("Akses tidak valid");
    }

    const hostEnv = access === "lokal" ? '<env name="UPTIME_KUMA_HOST" value="127.0.0.1"/>' : "";
    const hostLine = /^[ \t]*@HOST_ENV@[ \t]*\r?\n/m;
    const values = {
        "@INSTALL_DIR@": escapeXml(installDir),
        "@DATA_DIR@": escapeXml(dataDir),
        "@LOG_DIR@": escapeXml(logDir),
        "@PORT@": portText,
    };

    // a function replacer, so "$&" and similar in a path are not read as patterns
    let xml = template.replace(hostLine, () => (hostEnv ? `  ${hostEnv}\n` : ""));
    for (const [token, value] of Object.entries(values)) {
        xml = xml.replaceAll(token, () => value);
    }
    return xml;
}

/**
 * Run a command and collect its exit code and output; a non-zero exit code is not an error.
 * @param {string} command The program
 * @param {string[]} args Its arguments
 * @returns {Promise<{code: number, stdout: string}>} Exit code and standard output
 */
function defaultExec(command, args) {
    return new Promise((resolve) => {
        execFile(command, args, { windowsHide: true }, (error, stdout) => {
            resolve({
                code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
                stdout: String(stdout || ""),
            });
        });
    });
}

/**
 * Wait for a number of milliseconds.
 * @param {number} ms How long
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Control the Windows service with sc.exe.
 * @param {object} options How to reach sc.exe
 * @param {string} options.name Service name
 * @param {function(string, string[]): Promise<{code: number, stdout: string}>} options.exec Runs a program
 * @param {function(number): Promise<void>} options.sleep Waits for some milliseconds
 * @param {number} options.timeoutMs How long stop() waits for the service to stop
 * @returns {{state: function(): Promise<string>, stop: function(): Promise<void>, start: function(): Promise<void>}} The control
 */
function makeServiceControl({ name = SERVICE_NAME, exec = defaultExec, sleep = defaultSleep, timeoutMs = 30000 } = {}) {
    const POLL_MS = 500;

    const state = async () => {
        const { code, stdout } = await exec("sc.exe", ["query", name]);
        if (code === ERROR_SERVICE_DOES_NOT_EXIST) {
            return "MISSING";
        }
        // the label before the colon is translated on non-English Windows, the state names are not
        const match =
            /:\s*\d+\s+(STOPPED|RUNNING|START_PENDING|STOP_PENDING|CONTINUE_PENDING|PAUSE_PENDING|PAUSED)\b/.exec(
                stdout
            );
        return match ? match[1] : "UNKNOWN";
    };

    return {
        state,

        async stop() {
            let current = await state();
            if (current === "MISSING" || current === "STOPPED") {
                return;
            }
            await exec("sc.exe", ["stop", name]);
            let waited = 0;
            while (current !== "STOPPED" && current !== "MISSING") {
                if (waited >= timeoutMs) {
                    throw new Error(`Layanan ${name} tidak berhenti dalam ${timeoutMs / 1000} detik`);
                }
                await sleep(POLL_MS);
                waited += POLL_MS;
                current = await state();
            }
        },

        async start() {
            const current = await state();
            if (current === "MISSING") {
                throw new Error(`Layanan ${name} belum terpasang`);
            }
            if (current === "RUNNING" || current === "START_PENDING") {
                return;
            }
            const { code } = await exec("sc.exe", ["start", name]);
            if (code !== 0) {
                throw new Error(`Layanan ${name} gagal dinyalakan (kode ${code})`);
            }
        },
    };
}

/**
 * Wait until a URL answers with any HTTP status.
 * @param {object} options What to wait for
 * @param {string} options.url The URL
 * @param {number} options.timeoutMs How long to keep trying
 * @param {number} options.intervalMs Pause between tries
 * @param {function(string, object): Promise<object>} options.fetchFn Does the request (the global fetch by default)
 * @param {function(number): Promise<void>} options.sleep Waits for some milliseconds
 * @returns {Promise<boolean>} True when something answered in time
 */
async function waitForHttp({
    url,
    timeoutMs = 60000,
    intervalMs = 1000,
    fetchFn = (...args) => fetch(...args),
    sleep = defaultSleep,
}) {
    let waited = 0;
    for (;;) {
        try {
            await fetchFn(url, { signal: AbortSignal.timeout(3000) });
            return true;
        } catch (_) {
            // not up yet
        }
        if (waited >= timeoutMs) {
            return false;
        }
        await sleep(intervalMs);
        waited += intervalMs;
    }
}

/**
 * Tell whether a TCP port can be bound, the way the server will bind it.
 * @param {object} options Which port
 * @param {number} options.port The port
 * @param {string} options.host Address to bind; leave empty for the server's own default (all interfaces)
 * @returns {Promise<boolean>} True when nothing else holds the port
 */
function isPortFree({ port, host }) {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.once("error", () => resolve(false));
        probe.once("listening", () => probe.close(() => resolve(true)));
        if (host) {
            probe.listen(port, host);
        } else {
            probe.listen(port);
        }
    });
}

module.exports = {
    SERVICE_NAME,
    ACCESS_MODES,
    renderServiceXml,
    makeServiceControl,
    waitForHttp,
    isPortFree,
    defaultExec,
};
