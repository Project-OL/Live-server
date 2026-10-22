import express from "express";

/**
 * F20: request bodies are capped at 1 MB, except where the app uploads base64 images: video-call
 * and live-stream frame checks (verify-frame) and fake-live reports (report-fake, ~300 KB seen in
 * LB logs). Those keep 50 MB. ol-node-rest is 1 MB too (REQUEST_BODY_LIMIT_BYTES). Socket.IO
 * traffic never reaches these parsers.
 */
export const DEFAULT_BODY_LIMIT = "1mb";
export const LARGE_BODY_LIMIT = "50mb";

const LARGE_BODY_PATH = /^\/api\/(video-call\/verify-frame|live-stream\/[^/]+\/(verify-frame|report-fake))\/?$/;

export const isLargeBodyPath = (path) => LARGE_BODY_PATH.test(String(path || ""));

/** JSON + urlencoded parsers with the per-path limit. */
export const bodyParsers = () => {
    const pick = (small, large) => (req, res, next) => (isLargeBodyPath(req.path) ? large : small)(req, res, next);
    return [
        pick(express.json({ limit: DEFAULT_BODY_LIMIT }), express.json({ limit: LARGE_BODY_LIMIT })),
        pick(
            express.urlencoded({ extended: true, limit: DEFAULT_BODY_LIMIT }),
            express.urlencoded({ extended: true, limit: LARGE_BODY_LIMIT })
        )
    ];
};
