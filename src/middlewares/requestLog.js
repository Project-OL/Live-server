import crypto from "crypto";
import { logger, logContext } from "../utils/logger.js";
import { recordTrafficRequest } from "../services/traffic.service.js";

/**
 * LIVE-44 / INF-11: a request id and one access-log line per HTTP request.
 *
 * The id is the caller's `x-request-id` when it looks sane, else the GCP load balancer's trace id
 * (so a line can be matched to the LB log), else a new UUID. It is echoed back as `x-request-id`
 * (an added header; bodies and status codes are untouched) and attached to every log line written
 * while the request runs.
 *
 * The logged path never includes the query string (tokens have been sent there).
 * LIVE_REQUEST_LOG: all (default) | errors (status >= 400 only) | off.
 */
const SANE_ID = /^[A-Za-z0-9._-]{8,64}$/;
const QUIET_PATHS = new Set(["/live-health", "/"]);

const requestLogMode = () => {
    const m = String(process.env.LIVE_REQUEST_LOG || "all").trim().toLowerCase();
    return m === "off" || m === "errors" ? m : "all";
};

export const pickRequestId = (headers = {}) => {
    const given = headers["x-request-id"];
    if (typeof given === "string" && SANE_ID.test(given)) return given;
    const trace = headers["x-cloud-trace-context"];
    if (typeof trace === "string") {
        const id = trace.split("/")[0];
        if (SANE_ID.test(id)) return id;
    }
    return crypto.randomUUID();
};

export const requestLog = (req, res, next) => {
    const reqId = pickRequestId(req.headers);
    res.setHeader("x-request-id", reqId);
    const started = process.hrtime.bigint();
    const path = String(req.originalUrl || req.url || "").split("?")[0].slice(0, 200);
    const mode = requestLogMode();

    let logged = false;
    const done = (aborted) => {
        if (logged) return;
        logged = true;
        const status = aborted ? 499 : res.statusCode;
        // TRF-03: hourly section counters, independent of LIVE_REQUEST_LOG.
        recordTrafficRequest(path, req.userId ?? req.user?.userId ?? req.user?.id, status);
        if (mode === "off") return;
        if (mode === "errors" && status < 400) return;
        if (QUIET_PATHS.has(path) && status < 500) return;
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const userId = req.userId ?? req.user?.userId ?? req.user?.id;
        const line = { http: { method: req.method, path, status, ms: Math.round(ms * 10) / 10 } };
        // 'finish' may fire outside the request's async context, so set it explicitly. Only 5xx goes
        // to the error log; 4xx (expired tokens, validation) are normal traffic.
        logContext.run(userId ? { reqId, userId: String(userId) } : { reqId }, () => {
            if (status >= 500) logger.error(line, "http");
            else logger.info(line, "http");
        });
    };
    res.on("finish", () => done(false));
    res.on("close", () => done(!res.writableFinished));

    logContext.run({ reqId }, next);
};
