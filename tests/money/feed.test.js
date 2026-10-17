/**
 * LIVE-36: the country feed (join query) returns what the old IN-list query returned.
 * Runs on the money-test throwaway Postgres (see helpers.mjs).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma, live, makeUser, closeAll } from "./helpers.mjs";

after(closeAll);

const oldCountryFeed = async ({ country, page, limit }) => {
    const users = await prisma.user.findMany({ where: { country: { equals: country, mode: "insensitive" } }, select: { id: true } });
    const where = { isLive: true, userId: { in: users.map((u) => u.id) } };
    const [streams, total] = await Promise.all([
        prisma.liveStream.findMany({ where, orderBy: { startedAt: "desc" }, skip: (page - 1) * limit, take: limit }),
        prisma.liveStream.count({ where })
    ]);
    return { streams, total };
};

test("LIVE-36: country feed via the join matches the old IN-list query", async () => {
    const tag = `Testland${Date.now()}`;
    for (let i = 0; i < 7; i++) {
        const host = await makeUser();
        await prisma.user.update({ where: { id: host.id }, data: { country: i % 2 ? tag : tag.toUpperCase() } });
        const id = crypto.randomUUID();
        await prisma.liveStream.create({
            data: { id, streamId: id, userId: host.id, title: "t", streamKey: `k_${id}`, isLive: i !== 3, startedAt: new Date(Date.now() - i * 1000) }
        });
    }
    for (const [page, limit] of [[1, 20], [1, 2], [2, 2], [3, 2]]) {
        const now = await live.getLiveStreamsService({ page, limit, country: tag.toLowerCase() });
        const old = await oldCountryFeed({ country: tag.toLowerCase(), page, limit });
        assert.equal(now.total, old.total);
        assert.deepEqual(now.streams.map((s) => s.id), old.streams.map((s) => s.id));
        assert.deepEqual(now.streams, old.streams);
    }
});
