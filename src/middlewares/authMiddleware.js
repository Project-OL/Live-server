import jwt from "jsonwebtoken";
import { AppError } from "./errorHandler.js";
import {
    resolveUserTokenVersion,
    sessionService,
} from "../services/session.service.js";

export const authenticate = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return next(new AppError(401, "Authorization token missing", "UNAUTHORIZED"));
        }

        const token = authHeader.substring(7).trim();
        if (!token) {
            return next(new AppError(401, "Authorization token missing", "UNAUTHORIZED"));
        }

        const secret = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || process.env.JWT_SECRET_KEY;
        const payload = jwt.verify(token, secret);

        const userId = payload.userId || payload.sub;
        if (!userId) {
            return next(new AppError(401, "Invalid token", "INVALID_TOKEN"));
        }


        if (payload.sessionId) {
            const sessionTokenVersion = payload.sessionTokenVersion || 0;
            await sessionService.validateAccessSession(
                payload.sessionId,
                sessionTokenVersion,
                userId
            );
        }

        req.user = payload;
        req.userId = userId;
        req.sessionId = payload.sessionId;
        req.deviceId = payload.deviceId;
        req.jti = payload.jti;

        next();
    } catch (err) {
        console.error("[Auth Middleware Failure]:", err.name, err.message);
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