import { createClient } from "redis";
import dotenv from "dotenv";

dotenv.config();

/**
 * Never stop reconnecting (mirrors ol-node-rest BE-18): backoff capped at 2 s, with jitter so many
 * processes don't reconnect in lockstep. node-redis's default gives up on a socket timeout; this doesn't.
 */
export const redisReconnectStrategy = (retries) =>
  Math.min(retries * 200, 2000) + Math.floor(Math.random() * 100);

/** Commands queued while reconnecting; past this they fail instead of growing memory during an outage. */
export const REDIS_OFFLINE_QUEUE_MAX = 10000;

export const redisClientOptions = (url) => ({
  url,
  socket: { reconnectStrategy: redisReconnectStrategy, connectTimeout: 5000 },
  // Keeps idle connections (the Socket.IO adapter pair) from being dropped silently.
  pingInterval: 30000,
  commandsQueueMaxLength: REDIS_OFFLINE_QUEUE_MAX,
});

export const isReadonlyError = (err) =>
  typeof err?.message === "string" && err.message.startsWith("READONLY");

/** At most one forced reconnect per window, so a persistent replica can't cause a reconnect storm. */
export const READONLY_RECONNECT_COOLDOWN_MS = 5000;

/**
 * After a Memorystore Standard failover (or a resize) the old primary becomes a read-only replica.
 * A connection still on it gets READONLY for every write until it reconnects to the new primary.
 * node-redis has no reconnect-on-error hook (ioredis's `reconnectOnError` in ol-node-rest), so wrap
 * `sendCommand`, which every command goes through, and force one reconnect when READONLY appears.
 * The failing command still rejects; the caller's normal error handling applies.
 * Not for subscriber connections: they only receive, so they never see READONLY.
 */
export const attachReadonlyRecovery = (redis, label, now = Date.now) => {
  // createClient() returns a wrapper; commands run through its internal `_self` instance
  // (`this._self._executeCommand` -> `this.sendCommand`), so the patch must live there.
  const target = redis._self ?? redis;
  const send = target.sendCommand.bind(target);
  let lastReconnectAt = 0;
  target.sendCommand = (...args) =>
    send(...args).catch((err) => {
      if (isReadonlyError(err) && now() - lastReconnectAt >= READONLY_RECONNECT_COOLDOWN_MS) {
        lastReconnectAt = now();
        console.error(`[Redis ${label}] READONLY: connected to a replica after failover; reconnecting`);
        Promise.resolve()
          .then(() => redis.destroy())
          .then(() => redis.connect())
          .then(() => console.log(`[Redis ${label}] reconnected after READONLY`))
          .catch((e) => console.error(`[Redis ${label}] reconnect after READONLY failed:`, e.message));
      }
      throw err;
    });
  return redis;
};

const client = attachReadonlyRecovery(createClient(redisClientOptions(process.env.REDIS_URL)), "main");

client.on("error", (err) => {
  console.error("❌ Redis Client Error:", err);
});

client.on("connect", () => {
  console.log("🔄 Redis Connecting...");
});

client.on("ready", () => {
  console.log("✅ Redis Connected");
});

const connectRedis = async () => {
  try {
    if (!client.isOpen) {
      await client.connect();
    }
  } catch (error) {
    console.error("❌ Redis Connection Failed:", error);
  }
};

export { client, connectRedis };
