import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authMiddleware from "./middlewares/authMiddleware.js";
import apiRoutes from "./modules/index.js";
import { connectRedis } from "./config/redis.js";
// import { initSocket } from "./socket/index.js"

dotenv.config();

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  })
);

app.use(express.json({ limit: "50mb" }));

app.use(
  express.urlencoded({
    extended: true,
    limit: "50mb",
  })
);

app.use(express.static("public"));

await connectRedis();



app.get("/", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "API Running 🚀",
  });
});

app.use("/api", apiRoutes);

export default app;