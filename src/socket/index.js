import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { setupVideoCallSockets } from "../modules/videoCall/socket.js";
import { setupLiveSockets } from "../routes/service/socket-live-service.js";
import { client as redisClient } from "../config/redis.js";
import { onShutdown } from "../services/cluster.service.js";
import { claimedUserId, socketAuthMiddleware, socketAuthMode, socketUserId } from "./socketAuth.js";
import { noteDisconnect } from "../services/socketDisconnect.service.js";
import { withLogContext } from "../utils/logger.js";
import { socketEventGuard } from "./eventGuard.js";
import { corsAllowedOrigins } from "../config/corsOrigins.js";

let io;

/**
 * L1 (LIVE-09): with the Redis adapter, io.to(room).emit(...) reaches sockets on
 * every Live-server node, not just this one. On one node it changes nothing
 * visible. LIVE_SOCKET_REDIS_ADAPTER=false falls back to the in-memory adapter.
 */
const attachRedisAdapter = async (server) => {
    if (String(process.env.LIVE_SOCKET_REDIS_ADAPTER || "true").toLowerCase() === "false") {
        console.log("[Socket] Redis adapter disabled (LIVE_SOCKET_REDIS_ADAPTER=false); single-node only.");
        return;
    }
    if (!redisClient.isOpen) {
        console.error("[Socket] Redis not connected; using the in-memory adapter (single-node only).");
        return;
    }
    try {
        const pubClient = redisClient.duplicate();
        const subClient = redisClient.duplicate();
        pubClient.on("error", (err) => console.error("[Socket adapter pub] Redis error:", err.message));
        subClient.on("error", (err) => console.error("[Socket adapter sub] Redis error:", err.message));
        await Promise.all([pubClient.connect(), subClient.connect()]);
        server.adapter(createAdapter(pubClient, subClient));
        console.log("[Socket] Redis adapter attached (multi-node broadcasts enabled).");
        onShutdown("socket-adapter-redis", async () => {
            await Promise.allSettled([pubClient.quit(), subClient.quit()]);
        });
    } catch (err) {
        console.error("[Socket] Redis adapter failed; using the in-memory adapter:", err.message);
    }
};

export const initSocket = async (server) => {
    // SEC-13: browser origins allowed to open a socket: LIVE_SOCKET_CORS_ORIGINS (comma-separated).
    // Unset: F15 uses the HTTP CORS list in production, "*" elsewhere. The mobile app sends no
    // Origin, so CORS never applies to it.
    const socketOrigins = String(process.env.LIVE_SOCKET_CORS_ORIGINS || "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean);
    const defaultOrigins = process.env.NODE_ENV === "production" ? corsAllowedOrigins() : "*";
    io = new Server(server, {
        cors: {
            origin: socketOrigins.length ? socketOrigins : defaultOrigins,
            credentials: true,
        },
    });

    await attachRedisAdapter(io);

    // SEC-05: verify the access token before any handler reads handshake.userId.
    io.use(socketAuthMiddleware);
    console.log(`[Socket Auth] mode=${socketAuthMode()} (LIVE_SOCKET_AUTH_MODE: off | log | enforce)`);

    // LIVE-44: every log line written while handling a socket event carries the socket, user and
    // event. socket.io dispatches handlers on a nextTick inside this callback, so the context reaches them.
    io.use((socket, next) => {
        const userId = socket.data?.authUserId || claimedUserId(socket.handshake) || undefined;
        const base = userId ? { sid: socket.id, userId } : { sid: socket.id };
        socket.use((packet, nextPacket) =>
            withLogContext({ ...base, ev: String(packet?.[0] ?? "").slice(0, 48) }, nextPacket)
        );
        // LIVE-58 / LIVE-48 / LIVE-47: drop crash-inducing payloads; check fields and rates.
        socket.use(socketEventGuard(socket));
        withLogContext(base, next);
    });

    setupVideoCallSockets(io);
    setupLiveSockets(io);

    io.on("connection", (socket) => {
        console.log("connected", socket.id);

        // BE-05: keep the close reason ("transport close", "ping timeout", "client namespace
        // disconnect", ...) so a later failure event can say how the app's connection ended.
        socket.on("disconnect", (reason) => {
            const userId = socketUserId(socket);
            console.log(`[Socket] disconnected sid=${socket.id} user=${userId || "-"} reason=${reason}`);
            noteDisconnect(userId, reason, socket.id);
        });
    });

    return io;
};

/**
 * BE-08: before a graceful shutdown, send each socket on this node `server_shift` with its own
 * random `retryInMs` (0-3000) so reconnects to the next process spread out. Old apps ignore it.
 * Returns how many sockets were told.
 */
export const notifyServerShift = (server) => {
    let n = 0;
    try {
        for (const socket of server.sockets.sockets.values()) {
            socket.emit("server_shift", { reason: "deploy", retryInMs: Math.floor(Math.random() * 3000) });
            n += 1;
        }
    } catch (err) {
        console.error("[Shutdown] server_shift notice failed:", err.message);
    }
    if (n) console.log(`[Shutdown] server_shift sent to ${n} sockets`);
    return n;
};

export const getIO = () => io;
