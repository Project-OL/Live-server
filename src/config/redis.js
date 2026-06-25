import { createClient } from "redis";
import dotenv from "dotenv";

dotenv.config();

const client = createClient({
  url: process.env.REDIS_URL,
});

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