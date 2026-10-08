// BigInt Serialization Patch
BigInt.prototype.toJSON = function () {
  const num = Number(this);
  return Number.isSafeInteger(num) ? num : this.toString();
};

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

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
