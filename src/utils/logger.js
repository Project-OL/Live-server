import os from "os";
import util from "util";
import { AsyncLocalStorage } from "async_hooks";
import pino from "pino";

/**
 * LIVE-44: structured logs for Live-server.
 *
 * Every line becomes one JSON object with a timestamp, level, node and, when the line was written
 * while handling an HTTP request or a socket event, that request's id / user / event. The ~290
 * existing `console.*` calls keep working unchanged: installConsoleBridge() routes them here, so
 * old greps such as `[Ledger] last 10m` still match the `msg` field.
 *
 * - info/debug go to stdout and warn/error to stderr, so pm2's out/err log split is unchanged.
 * - Writes are synchronous (same as console on a pipe), so nothing is lost on process.exit.
 * - LIVE_LOG_FORMAT=plain keeps the old console output exactly (the kill switch).
 * - LIVE_LOG_LEVEL (default debug, so no existing line disappears).
 */
export const logContext = new AsyncLocalStorage();

const LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);
const level = (() => {
    const l = String(process.env.LIVE_LOG_LEVEL || "debug").trim().toLowerCase();
    return LEVELS.has(l) ? l : "debug";
})();

export const logFormat = () => (String(process.env.LIVE_LOG_FORMAT || "json").trim().toLowerCase() === "plain" ? "plain" : "json");

const streams = pino.multistream(
    [
        { level: "trace", stream: pino.destination({ fd: 1, sync: true }) },
        { level: "warn", stream: pino.destination({ fd: 2, sync: true }) }
    ],
    { dedupe: true }
);

export const logger = pino(
    {
        level,
        base: { svc: "live", node: `${os.hostname()}:${process.pid}` },
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: (label) => ({ level: label }) },
        // Per-line request / socket context (reqId, userId, event) without touching call sites.
        mixin: () => logContext.getStore() || {}
    },
    streams
);

/** Run fn with log context fields (merged over any outer context). */
export const withLogContext = (fields, fn) => logContext.run({ ...(logContext.getStore() || {}), ...fields }, fn);

/** Add fields to the current context (e.g. the userId once auth has run). No-op outside a context. */
export const setLogFields = (fields) => {
    const store = logContext.getStore();
    if (store) Object.assign(store, fields);
};

const original = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error
};

let installed = false;

/** Route console.* through the logger (once, at boot). Returns false when LIVE_LOG_FORMAT=plain. */
export const installConsoleBridge = () => {
    if (installed || logFormat() === "plain") return false;
    installed = true;
    const bridge = (lvl) =>
        function (...args) {
            // util.format matches console's own rendering of mixed strings, objects and errors.
            logger[lvl](util.format(...args));
        };
    console.log = bridge("info");
    console.info = bridge("info");
    console.debug = bridge("debug");
    console.warn = bridge("warn");
    console.error = bridge("error");
    return true;
};

/** Tests only. */
export const restoreConsoleForTests = () => {
    Object.assign(console, original);
    installed = false;
};
