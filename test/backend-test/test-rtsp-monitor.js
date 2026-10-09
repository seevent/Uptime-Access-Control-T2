const { describe, test, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const { UP } = require("../../src/util");
const { RtspMonitorType, rtspOptions } = require("../../server/monitor-types/rtsp");

/**
 * Start a TCP server that answers every connection with the given text.
 * @param {string|null} answer What to send back (null: say nothing)
 * @param {boolean} close Close the connection after the answer
 * @returns {Promise<{port: number, requests: string[], server: net.Server}>} The server
 */
function startServer(answer, close = false) {
    const requests = [];
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        socket.on("data", (data) => {
            requests.push(data.toString());
            if (answer !== null) {
                socket.write(answer);
                if (close) {
                    socket.end();
                }
            }
        });
    });
    server.closeAll = () => {
        for (const socket of sockets) {
            socket.destroy();
        }
        server.close();
    };
    return new Promise((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, requests, server }))
    );
}

describe("RTSP monitor type", () => {
    const servers = [];
    after(() => servers.forEach((s) => s.server.closeAll()));

    /**
     * @param {string|null} answer Answer of the fake device
     * @param {boolean} close Close after the answer
     * @returns {Promise<{port: number, requests: string[]}>} The fake device
     */
    async function device(answer, close) {
        const s = await startServer(answer, close);
        servers.push(s);
        return s;
    }

    /**
     * @param {number} port Port of the fake device
     * @param {object} extra Other monitor fields
     * @returns {Promise<{beat: object, error: ?Error}>} The heartbeat and the error of the check
     */
    async function check(port, extra = {}) {
        const beat = {};
        let error = null;
        try {
            await new RtspMonitorType().check({ hostname: "127.0.0.1", port, timeout: 2, ...extra }, beat, null);
        } catch (e) {
            error = e;
        }
        return { beat, error };
    }

    test("is up when the device answers 200 and the request is a valid OPTIONS", async () => {
        const d = await device("RTSP/1.0 200 OK\r\nCSeq: 1\r\nPublic: OPTIONS, DESCRIBE\r\n\r\n");
        const { beat, error } = await check(d.port);
        assert.equal(error, null);
        assert.equal(beat.status, UP);
        assert.equal(beat.msg, "RTSP/1.0 200 OK");
        assert.ok(beat.ping >= 0);
        assert.match(
            d.requests[0],
            new RegExp(`^OPTIONS rtsp://127\\.0\\.0\\.1:${d.port}/ RTSP/1\\.0\\r\\nCSeq: 1\\r\\n`)
        );
    });

    test("is up when the device asks for a login or refuses (401, 403, 404)", async () => {
        for (const code of ["401 Unauthorized", "403 Forbidden", "404 Not Found"]) {
            const d = await device(`RTSP/1.0 ${code}\r\nCSeq: 1\r\n\r\n`);
            const { beat, error } = await check(d.port);
            assert.equal(error, null, code);
            assert.equal(beat.status, UP);
        }
    });

    test("is down on a server error", async () => {
        const d = await device("RTSP/1.0 503 Service Unavailable\r\nCSeq: 1\r\n\r\n");
        const { error } = await check(d.port);
        assert.match(error.message, /Layanan RTSP bermasalah: RTSP\/1\.0 503/);
    });

    test("is down when something else than RTSP answers", async () => {
        const d = await device("HTTP/1.1 200 OK\r\n\r\n");
        const { error } = await check(d.port);
        assert.match(error.message, /Bukan jawaban RTSP/);
    });

    test("is down when the device never answers (timeout) or closes without answer", async () => {
        const silent = await device(null);
        const t = Date.now();
        const result = await rtspOptions("127.0.0.1", silent.port, 300).catch((e) => e);
        assert.match(result.message, /Timeout/);
        assert.ok(Date.now() - t < 2000);

        const closer = await startServer(null);
        servers.push(closer);
        closer.server.removeAllListeners("connection");
        closer.server.on("connection", (socket) => socket.on("error", () => {}).end());
        const closed = await check(closer.port);
        assert.match(closed.error.message, /ditutup/);
    });

    test("is down when nothing listens on the port", async () => {
        const s = await startServer(null);
        const port = s.port;
        s.server.closeAll();
        const { error } = await check(port);
        assert.match(error.message, /Koneksi gagal/);
    });

    test("uses port 554 when the monitor has none", async () => {
        // Nothing listens on 554 here, so the check fails with a connection error instead of a bad port
        const { error } = await check(undefined);
        assert.match(error.message, /Koneksi gagal|Timeout/);
    });
});
