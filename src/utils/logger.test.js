import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { pickRequestId } from "../middlewares/requestLog.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const loggerUrl = pathToFileURL(path.join(here, "logger.js")).href;

// The logger writes straight to fd 1 / fd 2, so check it from a child process.
const run = (body, env = {}) => {
    const script = `import { installConsoleBridge, withLogContext, setLogFields } from ${JSON.stringify(loggerUrl)};\n${body}`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, LIVE_LOG_FORMAT: "", LIVE_LOG_LEVEL: "", ...env },
        encoding: "utf8"
    });
    assert.equal(r.status, 0, r.stderr);
    const lines = (s) => s.split("\n").filter(Boolean);
    return { out: lines(r.stdout), err: lines(r.stderr) };
};

test("console.* become JSON lines: info/debug on stdout, warn/error on stderr", () => {
    const { out, err } = run(`
        installConsoleBridge();
        console.log("[Ledger] last 10m:", { a: 1 });
        console.debug("dbg");
        console.warn("careful");
        console.error("boom", new Error("bad"));
    `);
    assert.equal(out.length, 2);
    assert.equal(err.length, 2);
    const first = JSON.parse(out[0]);
    assert.equal(first.level, "info");
    assert.equal(first.svc, "live");
    assert.match(first.time, /^\d{4}-\d\d-\d\dT/);
    assert.equal(first.msg, "[Ledger] last 10m: { a: 1 }"); // old greps still match msg
    assert.equal(JSON.parse(out[1]).level, "debug");
    assert.equal(JSON.parse(err[0]).level, "warn");
    const e = JSON.parse(err[1]);
    assert.equal(e.level, "error");
    assert.match(e.msg, /boom Error: bad/);
});

test("context fields ride along, including across await and timers", () => {
    const { out } = run(`
        installConsoleBridge();
        await withLogContext({ reqId: "req-12345678" }, async () => {
            setLogFields({ userId: "u1" });
            await new Promise((r) => setTimeout(r, 5));
            console.log("inside");
        });
        console.log("outside");
    `);
    const [inside, outside] = out.map((l) => JSON.parse(l));
    assert.equal(inside.reqId, "req-12345678");
    assert.equal(inside.userId, "u1");
    assert.equal(outside.reqId, undefined);
});

test("LIVE_LOG_FORMAT=plain keeps the old console output", () => {
    const { out } = run(`installConsoleBridge(); console.log("hello", 1);`, { LIVE_LOG_FORMAT: "plain" });
    assert.deepEqual(out, ["hello 1"]);
});

test("pickRequestId: caller id, then LB trace id, else a UUID", () => {
    assert.equal(pickRequestId({ "x-request-id": "abcDEF12-34" }), "abcDEF12-34");
    assert.equal(pickRequestId({ "x-cloud-trace-context": "105445aa7843bc8bf206b12000100000/1;o=1" }), "105445aa7843bc8bf206b12000100000");
    assert.match(pickRequestId({ "x-request-id": "bad id with spaces" }), /^[0-9a-f-]{36}$/);
    assert.match(pickRequestId({}), /^[0-9a-f-]{36}$/);
});
