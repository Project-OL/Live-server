import { client as redisClient } from "../config/redis.js";

const USER_LAST_ACTIVE_THROTTLE_TTL = 300; // e.g. 5 mins

export const lastActiveTracker = async (req, res) => {
  const userId = req.userId;
  if (!userId) return;

  const gateKey = `user:lastActive:${userId}`;
  try {
    const ok = await redisClient.set(gateKey, "1", {
      EX: USER_LAST_ACTIVE_THROTTLE_TTL,
      NX: true,
    });
    if (!ok) return;

    if (prisma && prisma.user) {
      await prisma.user.update({
        where: { id: userId },
        data: { lastActiveAt: new Date() },
      });
    }
  } catch (err) {
    /* ignore activity tracking failures */
    console.error("Last Active Tracker Error:", err.message);
  }
};
