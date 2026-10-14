import jwt from "jsonwebtoken";
import { AppError } from "./errorHandler.js";
import {
    checkAccessPayload,
    recordSessionCheck,
    sessionCheckMode,
    shouldLogRejection,
} from "../services/session.service.js";

export const authenticate = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            console.warn(`[Auth Middleware Failure]: Missing/malformed Authorization header for ${req.method} ${req.originalUrl}`);
            return next(new AppError(401, "Authorization token missing", "UNAUTHORIZED"));
        }

        const token = authHeader.substring(7).trim();
        if (!token) {
            console.warn(`[Auth Middleware Failure]: Empty bearer token for ${req.method} ${req.originalUrl}`);
            return next(new AppError(401, "Authorization token missing", "UNAUTHORIZED"));
        }

        const secret = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || process.env.JWT_SECRET_KEY;
        const payload = jwt.verify(token, secret);

        const userId = payload.userId || payload.sub;
        if (!userId) {
            return next(new AppError(401, "Invalid token", "INVALID_TOKEN"));
        }


        // SEC-14: tokens ol-node-rest revoked (ban, logout, password reset, device ban).
        // A failure to check (DB/Redis error) never locks users out; it is counted instead.
        let verdict;
        try {
            verdict = await checkAccessPayload(payload);
        } catch (checkErr) {
            verdict = { ok: true };
            recordSessionCheck("rest", { ok: false, code: "CHECK_ERROR" });
            console.error(`[Session Check] error for user ${userId}: ${checkErr.message}`);
        }
        recordSessionCheck("rest", verdict);
        if (!verdict.ok) {
            if (shouldLogRejection(userId)) console.warn(`[Session Check] would reject user ${userId} ${verdict.code} (mode=${sessionCheckMode()}) ${req.method} ${req.originalUrl}`);
            if (sessionCheckMode() === "enforce") {
                return next(new AppError(verdict.statusCode, verdict.message, verdict.code));
            }
        }

        req.user = payload;
        req.userId = userId;
        req.sessionId = payload.sessionId;
        req.deviceId = payload.deviceId;
        req.jti = payload.jti;

        next();
    } catch (err) {
        console.error(`[Auth Middleware Failure]: ${err.name} ${err.message} for ${req.method} ${req.originalUrl}`);
        if (err instanceof AppError) {
            return next(err);
        }
        const message = err.name === "TokenExpiredError"
            ? "Token expired. Please login again."
            : `Invalid token (${err.message})`;
        return next(new AppError(401, message, "UNAUTHORIZED"));
    }
};

export default authenticate;