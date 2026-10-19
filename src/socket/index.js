import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { setupVideoCallSockets } from "../modules/videoCall/socket.js";
import { setupLiveSockets } from "../routes/service/socket-live-service.js";
import { client as redisClient } from "../config/redis.js";
import { onShutdown } from "../services/cluster.service.js";
import { claimedUserId, socketAuthMiddleware, socketAuthMode } from "./socketAuth.js";
import { withLogContext } from "../utils/logger.js";
import { socketEventGuard } from "./eventGuard.js";

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
    // SEC-13: browser origins allowed to open a socket. Opt-in: LIVE_SOCKET_CORS_ORIGINS
    // (comma-separated); unset keeps "*". The mobile app sends no Origin, so CORS never applies to it.
    const socketOrigins = String(process.env.LIVE_SOCKET_CORS_ORIGINS || "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean);
    io = new Server(server, {
        cors: {
            origin: socketOrigins.length ? socketOrigins : "*",
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

        socket.on("disconnect", () => {
            console.log("disconnected");
        });
    });

    return io;
};

export const getIO = () => io;
