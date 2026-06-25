import jwt from "jsonwebtoken";
import { lastActiveTracker } from "./lastActiveTracker.middleware.js";
import { AppError } from "./errorHandler.js";
import {
    resolveUserTokenVersion,
    sessionService,
} from "../services/session.service.js";

function extractBearerToken(request) {
    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
        return null;
    }
    const token = auth.substring(7).trim();
    return token || null;
}

async function applyVerifiedAccessPayload(req, res, payload) {
    const userId = payload.userId || payload.sub;

    if (!userId) {
        throw new AppError(401, "Invalid token", "INVALID_TOKEN");
    }

    // Token Version Check
    const dbTokenVersion = await resolveUserTokenVersion(userId);
    const tokenVersion = payload.tokenVersion || 0;

    if (dbTokenVersion !== tokenVersion) {
        throw new AppError(
            401,
            "Token version mismatch",
            "TOKEN_VERSION_MISMATCH"
        );
    }

    // Session Validation
    if (payload.sessionId) {
        const sessionTokenVersion = payload.sessionTokenVersion || 0;
        await sessionService.validateAccessSession(
            payload.sessionId,
            sessionTokenVersion,
            userId
        );
    }

    // Attach User Context
    req.user = payload;
    req.userId = userId;
    req.sessionId = payload.sessionId;
    req.deviceId = payload.deviceId;
    req.jti = payload.jti;

    // Update Last Active (Non Blocking)
    try {
        await lastActiveTracker(req, res);
    } catch (err) {
        console.error("Last Active Tracker:", err.message);
    }
}

export const authenticate = async (req, res, next) => {
    const token = extractBearerToken(req);

    if (!token) {
        return next(new AppError(401, "Authorization token missing", "UNAUTHORIZED"));
    }

    try {
        // Ensure you have JWT_SECRET in your .env file
        const secret = process.env.JWT_SECRET || "fallback_secret";
        const payload = jwt.verify(token, secret);
        await applyVerifiedAccessPayload(req, res, payload);
        next();
    } catch (err) {
        if (err instanceof AppError) {
            return next(err);
        }
        return next(new AppError(401, "Invalid or expired token", "UNAUTHORIZED"));
    }
};

export const authenticateOptional = async (req, res, next) => {
    const token = extractBearerToken(req);

    if (!token) return next();

    try {
        const secret = process.env.JWT_SECRET || "fallback_secret";
        const payload = jwt.verify(token, secret);
        await applyVerifiedAccessPayload(req, res, payload);
    } catch (err) {
        // Invalid Token Ignore
    }
    
    next();
};

export default authenticate;