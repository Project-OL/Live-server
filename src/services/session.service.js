import prisma from "../config/prisma.js";
import { client as redisClient } from "../config/redis.js";

export const resolveUserTokenVersion = async (userId) => {
  try {
    const cacheKey = `user:token_version:${userId}`;
    if (redisClient.isOpen) {
      const cached = await redisClient.get(cacheKey);
      if (cached !== null) {
        return parseInt(cached, 10);
      }
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { tokenVersion: true },
    });
    const version = user?.tokenVersion ?? 0;
    if (redisClient.isOpen) {
      await redisClient.set(cacheKey, version.toString(), "EX", 300);
    }
    return version;
  } catch (err) {
    console.error("Error resolving user token version:", err.message);
    return 0;
  }
};

export const sessionService = {
  validateAccessSession: async (sessionId, sessionTokenVersion, userId) => {
    // Session validation placeholder
    return true;
  },
};
