// BigInt Serialization Patch
BigInt.prototype.toJSON = function () {
  const num = Number(this);
  return Number.isSafeInteger(num) ? num : this.toString();
};

// LIVE-44: structured logs (console.* -> JSON lines); first so every later line is structured.
import './src/config/logging.js';
// LIVE-45: before anything else connects (exits before anything signs with a placeholder).
import './src/config/assertProductionConfig.js';
import http from 'http';
import app from './src/app.js';
import dotenv from 'dotenv';
import { initSocket } from "./src/socket/index.js";
import prisma from './src/config/prisma.js';
import { client as redisClient } from './src/config/redis.js';
import {
  NODE_ID,
  beginShutdown,
  isShuttingDown,
  releaseLeaderLocks,
  runShutdownHooks,
  startDurableTimerSweeper
} from './src/services/cluster.service.js';

dotenv.config();

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

// Keep idle connections longer than the Google LB's 600 s backend keepalive. Node's 5 s default made
// the LB open a fresh connection to Mumbai for most requests from far-away users (~4 round trips:
// p95 1.6 s vs 0.2 s near Mumbai, 2026-10-21). headersTimeout stays above it as Node recommends.
const keepAliveMs = Number(process.env.LIVE_HTTP_KEEP_ALIVE_TIMEOUT_MS) || 620_000;
server.keepAliveTimeout = keepAliveMs;
server.headersTimeout = keepAliveMs + 5_000;

// Socket Init (attaches the Redis adapter before any client can connect)
const io = await initSocket(server);

// L4 (LIVE-09): fire timers whose node restarted or died.
startDurableTimerSweeper();

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} (node ${NODE_ID})`);
});

/**
 * L6 (LIVE-09): graceful shutdown on SIGTERM (scale-in, MIG) and SIGINT (pm2 stop /
 * restart). pm2 SIGKILLs after kill_timeout (1600 ms by default), so this stays well
 * under that: stop accepting, close sockets (clients reconnect to a peer or to the
 * restarted process), hand over leader locks, run cleanup hooks, then exit.
 * Durable deadlines stay in Redis and are fired by whichever node leads next.
 */
const SHUTDOWN_TIMEOUT_MS = Number(process.env.LIVE_SHUTDOWN_TIMEOUT_MS || 1400);

const shutdown = async (signal) => {
  if (isShuttingDown()) return;
  beginShutdown();
  console.log(`[Shutdown] ${signal} received on ${NODE_ID}; draining.`);
  const hardExit = setTimeout(() => {
    console.error('[Shutdown] timed out; exiting.');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  hardExit.unref();

  try {
    await new Promise((resolve) => io.close(() => resolve()));
  } catch (err) {
    console.error('[Shutdown] io.close failed:', err.message);
  }
  await releaseLeaderLocks();
  await runShutdownHooks();
  await Promise.allSettled([
    prisma.$disconnect(),
    redisClient.isOpen ? redisClient.quit() : Promise.resolve()
  ]);
  console.log('[Shutdown] done.');
  process.exit(0);
};

/**
 * LIVE-58 backstop: a rejected promise nobody awaited (e.g. an async socket handler that throws)
 * used to crash the process, dropping every live stream and call on this node. It is now logged
 * and the server keeps running; the request or event that caused it fails on its own.
 * Synchronous uncaught exceptions still exit (state may be inconsistent); pm2 restarts the process.
 */
let unhandledCount = 0;
process.on('unhandledRejection', (reason) => {
  unhandledCount += 1;
  if (unhandledCount <= 20 || unhandledCount % 100 === 0) {
    console.error(`[Process] unhandled rejection #${unhandledCount}:`, reason instanceof Error ? reason.stack : reason);
  }
});
process.on('uncaughtException', (err) => {
  console.error('[Process] uncaught exception; exiting:', err?.stack || err);
  process.exit(1);
});

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
