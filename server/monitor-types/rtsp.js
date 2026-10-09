const net = require("net");
const { MonitorType } = require("./monitor-type");
const { UP } = require("../../src/util");

const DEFAULT_PORT = 554;
const MAX_RESPONSE_BYTES = 8192;

/**
 * Send one RTSP OPTIONS request and return the status line of the answer.
 * @param {string} hostname Address of the device
 * @param {number} port RTSP port
 * @param {number} timeoutMs Time allowed for the whole exchange
 * @returns {Promise<{statusCode: number, statusLine: string, ms: number}>} The answer and how long it took
 * @throws {Error} When the device does not answer, or does not answer with RTSP
 */
function rtspOptions(hostname, port, timeoutMs) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const socket = net.connect({ host: hostname, port });
        let received = "";
        let finished = false;

        const finish = (error, value) => {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(timer);
            socket.destroy();
            if (error) {
                reject(error);
            } else {
                resolve(value);
            }
        };

        const timer = setTimeout(() => finish(new Error("Timeout: tidak ada jawaban RTSP")), timeoutMs);

        socket.on("connect", () => {
            const host = hostname.includes(":") ? `[${hostname}]` : hostname;
            socket.write(
                `OPTIONS rtsp://${host}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: UptimeAccessControl\r\n\r\n`
            );
        });
        socket.on("data", (chunk) => {
            received += chunk.toString("latin1");
            const end = received.indexOf("\r\n");
            if (end === -1 && received.length < MAX_RESPONSE_BYTES) {
                return;
            }
            const statusLine = (end === -1 ? received.slice(0, 100) : received.slice(0, end)).trim();
            const match = /^RTSP\/\d(?:\.\d)?\s+(\d{3})\b/.exec(statusLine);
            if (!match) {
                finish(new Error("Bukan jawaban RTSP"));
                return;
            }
            finish(null, { statusCode: Number(match[1]), statusLine, ms: Date.now() - started });
        });
        socket.on("error", (e) => finish(new Error(`Koneksi gagal: ${e.message}`)));
        socket.on("close", () => finish(new Error("Koneksi ditutup tanpa jawaban RTSP")));
    });
}

class RtspMonitorType extends MonitorType {
    name = "rtsp";

    /**
     * Up when the device answers an RTSP OPTIONS request with a status below 500. A device that asks for a login
     * (401) or refuses the request (403) still shows that its RTSP service works.
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        const port = Number(monitor.port) || DEFAULT_PORT;
        const timeoutMs = (Number(monitor.timeout) > 0 ? Number(monitor.timeout) : 10) * 1000;
        const answer = await rtspOptions(monitor.hostname, port, timeoutMs);
        if (answer.statusCode >= 500) {
            throw new Error(`Layanan RTSP bermasalah: ${answer.statusLine}`);
        }
        heartbeat.ping = answer.ms;
        heartbeat.msg = answer.statusLine;
        heartbeat.status = UP;
    }
}

module.exports = { RtspMonitorType, rtspOptions, DEFAULT_PORT };
