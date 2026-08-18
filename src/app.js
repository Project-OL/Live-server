import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authMiddleware from "./middlewares/authMiddleware.js";
import apiRoutes from "./modules/index.js";
import streamRoutes from "./routes/index.js";
import { connectRedis } from "./config/redis.js";
// import { initSocket } from "./socket/index.js"

dotenv.config();

const app = express();

function corsAllowedOrigins() {
  const raw = [
    process.env.CORS_ORIGINS,
    process.env.ALLOWED_ORIGINS,
    process.env.CLIENT_URL,
    process.env.ADMIN_CLIENT_URL,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((origin) => origin.trim())
    .filter(Boolean)
  return [...new Set(raw)]
}

const allowedOrigins = corsAllowedOrigins()

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true)
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return callback(null, true)
      }
      return callback(null, false)
    },
    credentials: true,
  })
)

app.use(express.json({ limit: "50mb" }));

app.use(
  express.urlencoded({
    extended: true,
    limit: "50mb",
  })
);

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