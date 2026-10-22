import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authMiddleware from "./middlewares/authMiddleware.js";
import apiRoutes from "./modules/index.js";
import streamRoutes from "./routes/index.js";
import { connectRedis } from "./config/redis.js";
import { requestLog } from "./middlewares/requestLog.js";
import { corsAllowedOrigins } from "./config/corsOrigins.js";
import { bodyParsers } from "./config/bodyLimits.js";
// import { initSocket } from "./socket/index.js"

dotenv.config();

const app = express();

// LIVE-44 / INF-11: request id + one access-log line per request (before everything else).
app.use(requestLog);

// F15: production boots only with an explicit list (assertProductionConfig.js); "*" is honoured
// only outside production.
const allowedOrigins = corsAllowedOrigins()
const allowAnyOrigin = process.env.NODE_ENV !== 'production' && allowedOrigins.includes('*')

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true)
      if (allowAnyOrigin || allowedOrigins.includes(origin)) {
        return callback(null, true)
      }
      return callback(null, false)
    },
    credentials: true,
  })
)

// F20: 1 MB bodies, 50 MB only on the image-upload routes (config/bodyLimits.js).
app.use(...bodyParsers());

app.use(express.static("public"));

await connectRedis();

import prisma from "./config/prisma.js";
try {
  await prisma.$connect();
  console.log("⚡ Database connection pool pre-warmed & ready!");
} catch (dbErr) {
  console.error("❌ Database pre-warm error:", dbErr.message);
}



import { errorHandler } from "./middlewares/errorHandler.js";
import { liveHealth } from "./routes/liveHealth.js";

// LIVE-46: dependency-aware health for uptime checks (see src/routes/liveHealth.js).
app.get("/live-health", liveHealth);

app.get("/", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "API Running 🚀",
  });
});

app.use("/api", apiRoutes);
app.use("/api", streamRoutes);

app.use(errorHandler);

export default app;