/**
 * Network scanner: turns user supplied ranges into IP lists and (in later sections) probes them.
 * Pure logic only: no Socket.IO and no database access, so it can be tested in isolation.
 */
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const dns = require("node:dns");
const { execFile } = require("node:child_process");

/** Maximum number of addresses a single scan may cover. */
const MAX_HOSTS = 4096;

/** How many probes (and hostname lookups) run at the same time by default. */
const DEFAULT_CONCURRENCY = 64;

/** Minimum time between two progress reports, in milliseconds. */
const PROGRESS_INTERVAL_MS = 250;

/** How long a reverse DNS lookup may take, in milliseconds. */
const DNS_TIMEOUT_MS = 1000;

/** Longest hostname that is kept. */
const HOSTNAME_MAX_LENGTH = 255;

/** How long a single ping may take, in milliseconds. */
const PING_TIMEOUT_MS = 1000;

const OCTET_PATTERN = /^(0|[1-9]\d{0,2})$/;

class ScanInputError extends Error {
    /**
     * @param {"EMPTY_INPUT" | "INVALID_RANGE" | "TOO_MANY_HOSTS"} code Machine readable reason
     * @param {string} message Human readable message (shown in the UI)
     */
    constructor(code, message) {
        super(message);
        this.name = "ScanInputError";
        this.code = code;
    }
}

/**
 * Parse a dotted IPv4 address. Octets with leading zeros are rejected because they are ambiguous (octal).
 * @param {string} text Address such as "192.168.1.10"
 * @returns {number | null} Unsigned 32-bit integer, or null if the text is not a valid IPv4 address
 */
function parseIPv4(text) {
    const parts = String(text).split(".");
    if (parts.length !== 4) {
        return null;
    }
    let value = 0;
    for (const part of parts) {
        if (!OCTET_PATTERN.test(part) || Number(part) > 255) {
            return null;
        }
        value = value * 256 + Number(part);
    }
    return value;
}

/**
 * @param {number} value Unsigned 32-bit integer
 * @returns {string} Dotted IPv4 address
 */
function formatIPv4(value) {
    return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

/**
 * Addresses that are never a scannable host: this-network, loopback, link-local, multicast and reserved.
 * @param {number} value Unsigned 32-bit integer
 * @returns {boolean} True if the address may be scanned
 */
function isScannable(value) {
    const first = value >>> 24;
    if (first === 0 || first === 127 || first >= 224) {
        return false;
    }
    return !(first === 169 && ((value >>> 16) & 255) === 254);
}

/**
 * Resolve one user token (single IP, CIDR or range) to an inclusive [first, last] integer span.
 * @param {string} token Trimmed, non-empty token
 * @param {number} maxHosts Upper bound for the span size
 * @returns {{first: number, last: number}} Inclusive span
 * @throws {ScanInputError} If the token is invalid or the span is too large
 */
function resolveToken(token, maxHosts) {
    const invalid = () => new ScanInputError("INVALID_RANGE", `Rentang tidak valid: "${token}"`);
    const tooMany = () =>
        new ScanInputError(
            "TOO_MANY_HOSTS",
            `Rentang terlalu besar (maksimum ${maxHosts} alamat per scan): "${token}"`
        );

    let first;
    let last;

    if (token.includes("/")) {
        const [addressText, prefixText, ...rest] = token.split("/");
        const address = parseIPv4(addressText);
        if (rest.length > 0 || address === null || !/^\d{1,2}$/.test(prefixText) || Number(prefixText) > 32) {
            throw invalid();
        }
        const prefix = Number(prefixText);
        const size = 2 ** (32 - prefix);
        const usable = prefix >= 31 ? size : size - 2;
        if (usable > maxHosts) {
            throw tooMany();
        }
        const network = Math.floor(address / size) * size;
        first = prefix >= 31 ? network : network + 1;
        last = prefix >= 31 ? network + size - 1 : network + size - 2;
    } else if (token.includes("-")) {
        const [startText, endText, ...rest] = token.split("-");
        const start = parseIPv4(startText);
        let end = parseIPv4(endText);
        if (end === null && OCTET_PATTERN.test(endText) && Number(endText) <= 255 && start !== null) {
            end = Math.floor(start / 256) * 256 + Number(endText);
        }
        if (rest.length > 0 || start === null || end === null || end < start) {
            throw invalid();
        }
        if (end - start + 1 > maxHosts) {
            throw tooMany();
        }
        first = start;
        last = end;
    } else {
        const address = parseIPv4(token);
        if (address === null) {
            throw invalid();
        }
        first = address;
        last = address;
    }

    return { first, last };
}

/**
 * Expand user supplied ranges into a de-duplicated list of scannable IPv4 addresses.
 * Accepts CIDR ("10.0.0.0/24"), ranges ("10.0.0.10-50" or "10.0.0.10-10.0.0.50") and single IPs,
 * separated by newlines or commas.
 * @param {string[]} inputs Raw user input lines
 * @param {{maxHosts?: number}} options Options
 * @returns {string[]} Addresses in input order, without duplicates
 * @throws {ScanInputError} On empty input, invalid tokens or more than maxHosts addresses
 */
function expandRanges(inputs, options = {}) {
    const maxHosts = options.maxHosts ?? MAX_HOSTS;
    const tokens = inputs
        .flatMap((line) => String(line).split(/[\r\n,]+/))
        .map((token) => token.trim())
        .filter((token) => token !== "");

    if (tokens.length === 0) {
        throw new ScanInputError("EMPTY_INPUT", "Masukkan minimal satu rentang IP");
    }

    const addresses = new Set();
    for (const token of tokens) {
        const { first, last } = resolveToken(token, maxHosts);
        for (let value = first; value <= last; value++) {
            if (isScannable(value)) {
                addresses.add(value);
            }
        }
        if (addresses.size > maxHosts) {
            throw new ScanInputError("TOO_MANY_HOSTS", `Rentang terlalu besar (maksimum ${maxHosts} alamat per scan)`);
        }
    }
    return [...addresses].map(formatIPv4);
}

/**
 * Prefix length of a contiguous netmask.
 * @param {number} mask Unsigned 32-bit netmask
 * @returns {number | null} Prefix length, or null if the mask is not contiguous
 */
function prefixFromMask(mask) {
    const inverted = ~mask >>> 0;
    if ((inverted & (inverted + 1)) !== 0 && inverted !== 0xffffffff) {
        return null;
    }
    return 32 - Math.log2(inverted + 1);
}

/**
 * Subnets of the machine's own IPv4 interfaces, used to pre-fill the scan form.
 * @param {ReturnType<typeof os.networkInterfaces>} interfaces Interface map (injectable for tests)
 * @returns {string[]} CIDR strings such as "192.168.1.0/24"
 */
function getLocalSubnets(interfaces = os.networkInterfaces()) {
    const subnets = [];
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries || []) {
            if (entry.internal || (entry.family !== "IPv4" && entry.family !== 4)) {
                continue;
            }
            const address = parseIPv4(entry.address);
            const mask = parseIPv4(entry.netmask);
            if (address === null || mask === null) {
                continue;
            }
            const prefix = prefixFromMask(mask);
            if (prefix === null || prefix === 0 || prefix === 32) {
                continue;
            }
            const network = (address & mask) >>> 0;
            if (!isScannable(network)) {
                continue;
            }
            const cidr = `${formatIPv4(network)}/${prefix}`;
            if (!subnets.includes(cidr)) {
                subnets.push(cidr);
            }
        }
    }
    return subnets;
}

class ScanToolError extends Error {
    /**
     * @param {"PING_UNAVAILABLE"} code Machine readable reason
     * @param {string} message Human readable message (shown in the UI)
     */
    constructor(code, message) {
        super(message);
        this.name = "ScanToolError";
        this.code = code;
    }
}

/**
 * Run an external command and capture its stdout. Resolves for any exit code and rejects only when the
 * command could not be started or was killed (for example a missing binary has the error code "ENOENT").
 * @param {string} file Command to run
 * @param {string[]} args Command arguments
 * @param {number} timeoutMs Kill the command if it runs longer than this
 * @returns {Promise<{exitCode: number, stdout: string}>} Exit code and standard output
 */
function runCommand(file, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
            if (error && typeof error.code !== "number") {
                reject(error);
                return;
            }
            resolve({ exitCode: error ? error.code : 0, stdout: String(stdout) });
        });
    });
}

/**
 * Build the OS specific ping command line for a single echo request.
 * @param {string} ip Address to ping
 * @param {number} timeoutMs Time to wait for the reply in milliseconds
 * @param {NodeJS.Platform} platform Operating system
 * @returns {{file: string, args: string[]}} Command and arguments
 */
function buildPingCommand(ip, timeoutMs, platform) {
    if (platform === "win32") {
        return { file: "ping", args: ["-n", "1", "-w", String(timeoutMs), ip] };
    }
    if (platform === "darwin") {
        return { file: "ping", args: ["-c", "1", "-W", String(timeoutMs), ip] };
    }
    return { file: "ping", args: ["-c", "1", "-W", String(Math.max(1, Math.ceil(timeoutMs / 1000))), ip] };
}

/**
 * Decide whether a finished ping means the host answered.
 * Windows ping can exit with 0 on "Destination host unreachable" replies from a router, so a real reply
 * (the TTL field, which is not translated) is required there.
 * @param {{platform: NodeJS.Platform, exitCode: number, stdout: string}} result Finished ping
 * @returns {boolean} True if the host answered
 */
function isPingSuccess({ platform, exitCode, stdout }) {
    if (platform === "win32") {
        return exitCode === 0 && /\bTTL\s*=\s*\d+/i.test(stdout);
    }
    return exitCode === 0;
}

/**
 * Ping one host with the operating system's ping command.
 * @param {string} ip Address to ping (must already be validated)
 * @param {{timeoutMs?: number, platform?: NodeJS.Platform, run?: (file: string, args: string[]) => Promise<{exitCode: number, stdout: string}>}} options Options
 * @returns {Promise<boolean>} True if the host answered
 * @throws {ScanToolError} If the ping command cannot be started
 */
async function pingHost(ip, options = {}) {
    const timeoutMs = options.timeoutMs ?? PING_TIMEOUT_MS;
    const platform = options.platform ?? process.platform;
    const run = options.run ?? ((file, args) => runCommand(file, args, timeoutMs + 2000));
    const command = buildPingCommand(ip, timeoutMs, platform);
    try {
        const { exitCode, stdout } = await run(command.file, command.args);
        return isPingSuccess({ platform, exitCode, stdout });
    } catch (error) {
        if (error.code === "ENOENT" || error.code === "EACCES") {
            throw new ScanToolError("PING_UNAVAILABLE", "Perintah ping tidak tersedia di server ini");
        }
        return false;
    }
}

/**
 * Normalize a MAC address to upper case, colon separated form.
 * @param {string | null | undefined} raw MAC as printed by arp (dash or colon separated)
 * @returns {string | null} Normalized MAC, or null for malformed, all-zero, broadcast and multicast addresses
 */
function normalizeMac(raw) {
    const groups = String(raw ?? "")
        .trim()
        .split(/[:-]/);
    if (groups.length !== 6 || !groups.every((group) => /^[0-9a-f]{1,2}$/i.test(group))) {
        return null;
    }
    const octets = groups.map((group) => group.padStart(2, "0").toUpperCase());
    if (parseInt(octets[0], 16) & 1 || octets.every((octet) => octet === "00")) {
        return null;
    }
    return octets.join(":");
}

/**
 * Parse the output of `arp -a`, `ip neigh` or `arp -an` into an IP to MAC map.
 * Rows without a real host MAC (incomplete, failed, broadcast, multicast, IPv6) are ignored.
 * @param {string} text Command output
 * @param {NodeJS.Platform} platform Operating system the output came from
 * @returns {Map<string, string>} IPv4 address to normalized MAC
 */
function parseArpTable(text, platform) {
    const table = new Map();
    const ipv4 = "(\\d{1,3}(?:\\.\\d{1,3}){3})";
    const windowsRow = new RegExp(`^\\s*${ipv4}\\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\\s+\\w+`, "i");
    const neighRow = new RegExp(`^${ipv4}\\s+.*\\blladdr\\s+([0-9a-f:]+)`, "i");
    const arpRow = new RegExp(`\\(${ipv4}\\)\\s+at\\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\\b`, "i");

    for (const line of String(text).split(/\r?\n/)) {
        const match = platform === "win32" ? line.match(windowsRow) : line.match(neighRow) || line.match(arpRow);
        if (!match) {
            continue;
        }
        const mac = normalizeMac(match[2]);
        if (mac && parseIPv4(match[1]) !== null) {
            table.set(match[1], mac);
        }
    }
    return table;
}

/**
 * Read the operating system's ARP/neighbor table.
 * @param {{platform?: NodeJS.Platform, run?: (file: string, args: string[]) => Promise<{exitCode: number, stdout: string}>}} options Options
 * @returns {Promise<Map<string, string> | null>} IP to MAC map, or null if no ARP command worked
 */
async function readArpTable(options = {}) {
    const platform = options.platform ?? process.platform;
    const run = options.run ?? ((file, args) => runCommand(file, args, 5000));
    const commands =
        platform === "win32" || platform === "darwin"
            ? [{ file: "arp", args: ["-a"] }]
            : [
                  { file: "ip", args: ["neigh"] },
                  { file: "arp", args: ["-an"] },
              ];

    for (const { file, args } of commands) {
        try {
            const { exitCode, stdout } = await run(file, args);
            if (exitCode === 0) {
                return parseArpTable(stdout, platform);
            }
        } catch (error) {
            // Try the next command
        }
    }
    return null;
}

let ouiTable = null;

/**
 * Load the bundled OUI (vendor prefix) table once. A missing or unreadable file means "no vendor names".
 * @returns {Record<string, string>} Map of 6 digit upper case hex prefix to vendor name
 */
function loadOuiTable() {
    if (ouiTable === null) {
        try {
            ouiTable = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "oui.json"), "utf8"));
        } catch (error) {
            ouiTable = {};
        }
    }
    return ouiTable;
}

/**
 * Look up the vendor of a MAC address by its OUI prefix.
 * @param {string | null} mac Normalized MAC address
 * @param {Record<string, string>} table OUI table (defaults to the bundled one)
 * @returns {string | null} Vendor name, or null if unknown
 */
function lookupVendor(mac, table = loadOuiTable()) {
    if (!mac) {
        return null;
    }
    return table[mac.replace(/[:-]/g, "").slice(0, 6).toUpperCase()] ?? null;
}

/**
 * Tidy a reverse DNS name: trim, drop the trailing dot, limit the length.
 * @param {string | null | undefined} raw Name as returned by DNS
 * @returns {string | null} Clean hostname, or null if there is none
 */
function cleanHostname(raw) {
    const name = String(raw ?? "")
        .trim()
        .replace(/\.$/, "");
    return name === "" ? null : name.slice(0, HOSTNAME_MAX_LENGTH);
}

/**
 * Reverse DNS lookup that never throws and never waits longer than the timeout.
 * @param {string} ip Address to look up
 * @param {{timeoutMs?: number, reverse?: (ip: string) => Promise<string[]>}} options Options
 * @returns {Promise<string | null>} Hostname, or null if unknown
 */
async function resolveHostname(ip, options = {}) {
    const timeoutMs = options.timeoutMs ?? DNS_TIMEOUT_MS;
    const reverse = options.reverse ?? ((address) => dns.promises.reverse(address));
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
        const names = await Promise.race([reverse(ip), timeout]);
        return cleanHostname(Array.isArray(names) ? names[0] : null);
    } catch (error) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Map items with at most `limit` calls running at the same time, keeping the input order.
 * @param {any[]} items Items to map
 * @param {number} limit Maximum number of parallel calls
 * @param {(item: any) => Promise<any>} fn Async mapper
 * @returns {Promise<any[]>} Results in input order
 */
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/**
 * Scan a list of addresses: ping each one, add ARP-only neighbours in the same range, then resolve
 * hostnames and vendors for everything found. Cancelling (abort signal) stops new probes and skips the
 * ARP and DNS steps; what was found so far is still returned with `completed: false`.
 * @param {{ips: string[], probe?: (ip: string) => Promise<boolean>, readArp?: () => Promise<Map<string, string> | null>, resolveHostname?: (ip: string) => Promise<string | null>, lookupVendor?: (mac: string | null) => string | null, concurrency?: number, onProgress?: (p: {done: number, total: number, found: number}) => void, progressIntervalMs?: number, signal?: AbortSignal}} options Scan options (already expanded ips)
 * @returns {Promise<{devices: object[], completed: boolean, arpAvailable: boolean, total: number}>} Result
 * @throws {ScanToolError} If a probe reports that the ping command is unavailable
 */
async function scan(options) {
    const { ips, signal, onProgress } = options;
    const probe = options.probe ?? pingHost;
    const readArp = options.readArp ?? readArpTable;
    const resolveName = options.resolveHostname ?? resolveHostname;
    const vendorOf = options.lookupVendor ?? lookupVendor;
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    const progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;

    const total = ips.length;
    const responding = new Set();
    let done = 0;
    let next = 0;
    let failure = null;
    let lastProgress = Date.now();

    const report = (force) => {
        const now = Date.now();
        if (onProgress && (force || now - lastProgress >= progressIntervalMs)) {
            lastProgress = now;
            onProgress({ done, total, found: responding.size });
        }
    };

    const worker = async () => {
        while (!signal?.aborted && failure === null && next < total) {
            const ip = ips[next++];
            try {
                if (await probe(ip)) {
                    responding.add(ip);
                }
            } catch (error) {
                failure = failure ?? error;
                return;
            }
            done++;
            report(false);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
    if (failure !== null) {
        throw failure;
    }
    report(true);

    const aborted = Boolean(signal?.aborted);
    const arpTable = aborted ? null : await readArp();
    const ipSet = new Set(ips);

    const detectedVia = new Map([...responding].map((ip) => [ip, "ping"]));
    for (const ip of arpTable ? arpTable.keys() : []) {
        if (ipSet.has(ip) && !detectedVia.has(ip)) {
            detectedVia.set(ip, "arp");
        }
    }

    const sortedIps = [...detectedVia.keys()].sort((a, b) => parseIPv4(a) - parseIPv4(b));
    const devices = await mapLimit(sortedIps, concurrency, async (ip) => {
        const mac = arpTable?.get(ip) ?? null;
        let hostname = null;
        if (!aborted) {
            try {
                hostname = cleanHostname(await resolveName(ip));
            } catch (error) {
                hostname = null;
            }
        }
        return { ip, mac, hostname, vendor: vendorOf(mac), detectedVia: detectedVia.get(ip) };
    });

    return { devices, completed: !aborted && done === total, arpAvailable: arpTable !== null, total };
}

module.exports = {
    MAX_HOSTS,
    ScanInputError,
    ScanToolError,
    expandRanges,
    getLocalSubnets,
    buildPingCommand,
    isPingSuccess,
    pingHost,
    normalizeMac,
    parseArpTable,
    readArpTable,
    lookupVendor,
    cleanHostname,
    resolveHostname,
    scan,
};
