import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { bodyParsers, isLargeBodyPath } from "./bodyLimits.js";

test("F20: only the image-upload routes get the large limit", () => {
    for (const p of [
        "/api/video-call/verify-frame",
        "/api/live-stream/3f1c2b9e-0000-4000-8000-000000000000/verify-frame",
        "/api/live-stream/abc/report-fake",
        "/api/live-stream/abc/verify-frame/"
    ]) assert.equal(isLargeBodyPath(p), true, p);
    for (const p of [
        "/api/live-stream/abc/send-gift",
        "/api/live-stream/abc/message",
        "/api/video-call/send-gift",
        "/api/video-call/verify-frame/extra",
        "/api/admin/users/u/restrictions",
        "/live-health",
        ""
    ]) assert.equal(isLargeBodyPath(p), false, p);
});

const post = (port, path, bytes) =>
    new Promise((resolve, reject) => {
        const body = JSON.stringify({ image: "x".repeat(bytes) });
        const req = http.request(
            { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
            (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }
        );
        req.on("error", reject);
        req.end(body);
    });

test("F20: a 2 MB body is refused (413) on a normal route and accepted on verify-frame", async () => {
    const app = express();
    app.use(...bodyParsers());
    app.use((req, res) => res.status(200).json({ n: req.body.image.length }));
    app.use((err, _req, res, _next) => res.status(err.status || 500).end());
    const server = app.listen(0);
    const { port } = server.address();
    try {
        assert.equal(await post(port, "/api/live-stream/abc/send-gift", 2_000_000), 413);
        assert.equal(await post(port, "/api/live-stream/abc/send-gift", 500_000), 200);
        assert.equal(await post(port, "/api/video-call/verify-frame", 2_000_000), 200);
        assert.equal(await post(port, "/api/live-stream/abc/report-fake", 2_000_000), 200);
    } finally {
        server.close();
    }
});
