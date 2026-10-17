import prisma from "../config/prisma.js";
import { client as redisClient } from "../config/redis.js";
import { withGiftThumbnail } from "../utils/giftImage.js";

/**
 * LIVE-37: the active gift catalogue for GET /live-stream/gifts and GET /video-call/gifts (same
 * query, same response). It was read from the DB (up to 500 rows + a count) on every request.
 *
 * Cached in the shared Redis under `gifts:list:live:<page>`, which ol-node-rest already deletes on
 * every gift / category edit (`deleteByPattern('gifts:list*')` in gift.service.ts), so admin edits
 * show at once; the 60 s TTL is only a safety net. A Redis failure falls through to the DB.
 */
export const GIFT_CATALOG_PAGE_SIZE = 500;
const TTL_SECONDS = 60;
const cacheKey = (page) => `gifts:list:live:${page}`;

const loadFromDb = async (page) => {
    const skip = (page - 1) * GIFT_CATALOG_PAGE_SIZE;
    const [gifts, total] = await Promise.all([
        prisma.gift.findMany({
            where: { isActive: true },
            include: {
                gift_categories: {
                    select: {
                        id: true,
                        name: true,
                        slug: true
                    }
                }
            },
            orderBy: { coinCost: "asc" },
            skip,
            take: GIFT_CATALOG_PAGE_SIZE
        }),
        prisma.gift.count({ where: { isActive: true } })
    ]);
    return { data: gifts.map(withGiftThumbnail), total };
};

/** @returns {Promise<{ data: object[], total: number }>} */
export const getActiveGiftCatalogPage = async (page) => {
    if (redisClient.isOpen) {
        try {
            const hit = await redisClient.get(cacheKey(page));
            if (hit) return JSON.parse(hit);
        } catch {
            // fall through to the DB
        }
    }
    const result = await loadFromDb(page);
    if (redisClient.isOpen) {
        // Stored as its JSON form: the response is JSON too, so a hit returns identical bytes.
        redisClient.set(cacheKey(page), JSON.stringify(result), { EX: TTL_SECONDS }).catch(() => { });
    }
    return JSON.parse(JSON.stringify(result));
};
