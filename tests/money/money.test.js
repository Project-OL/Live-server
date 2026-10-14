/**
 * LIVE-52 part 2: money concurrency tests against a throwaway Postgres + Redis.
 *
 *   docker compose -f tests/money/docker-compose.yml up -d --wait
 *   npx prisma db push --skip-generate   (DATABASE_URL=postgresql://money:money@127.0.0.1:55432/money_test)
 *   npm run test:money
 *
 * Tests marked `todo: "<ID>"` reproduce a known bug from docs/context/HARDENING_SCALE_PLAN.md. They run and
 * report, but don't fail the suite until the fix lands; then drop the `todo`.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
    prisma, videoCall, live, makeUser, makeAgency, makeGift, makeActiveCall,
    walletIdOf, ledgerProblems, olNodeStyleLockedCredit, closeAll, ensureWallets,
} from "./helpers.mjs";

after(closeAll);

const N = 20;
const settledAll = (ps) => Promise.allSettled(ps);
const fulfilled = (rs) => rs.filter((r) => r.status === "fulfilled").map((r) => r.value);
/** Distinct rejection reasons with counts, for assertion messages. */
const reasons = (rs) => {
    const m = new Map();
    for (const r of rs) if (r.status === "rejected") {
        const k = `${r.reason?.code ?? ""} ${String(r.reason?.message ?? r.reason).split("\n").slice(-1)[0].slice(0, 160)}`.trim();
        m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m].map(([k, n]) => `${n}x ${k}`).join(" | ");
};

test("concurrent video-call gifts from one sender keep sender and host ledgers consistent", async () => {
    const sender = await makeUser({ coins: 1_000_000n });
    const hostUser = await makeUser();
    await ensureWallets(hostUser.id);
    const gift = await makeGift(100);
    const call = await makeActiveCall(sender.id, hostUser.id);

    const rs = await settledAll(Array.from({ length: N }, () => videoCall.sendGift(call.id, sender.id, gift.id, 1)));
    const failed = rs.filter((r) => r.status === "rejected");
    assert.equal(failed.length, 0, `gift sends failed: ${failed.map((f) => f.reason?.message).join("; ")}`);

    const [sw, hw] = [await walletIdOf(sender.id, "COIN"), await walletIdOf(hostUser.id, "POINT")];
    assert.deepEqual(await ledgerProblems([sw, hw]), []);
    const latest = await prisma.coinLedgerEntry.findFirst({ where: { walletId: sw }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    assert.equal(latest.balanceAfter, 1_000_000n - BigInt(N * 100), "sender charged exactly once per gift");
});

test("sender cannot overspend: parallel gifts beyond the balance are rejected, never negative", async () => {
    const sender = await makeUser({ coins: 1_000n }); // affords 10 gifts of 100
    const hostUser = await makeUser();
    await ensureWallets(hostUser.id);
    const gift = await makeGift(100);
    const call = await makeActiveCall(sender.id, hostUser.id);

    const rs = await settledAll(Array.from({ length: N }, () => videoCall.sendGift(call.id, sender.id, gift.id, 1)));
    assert.equal(fulfilled(rs).length, 10, "exactly the affordable number succeed");
    const sw = await walletIdOf(sender.id, "COIN");
    assert.deepEqual(await ledgerProblems([sw]), []);
    const latest = await prisma.coinLedgerEntry.findFirst({ where: { walletId: sw }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    assert.equal(latest.balanceAfter, 0n);
});

test("LIVE-24: two hosts of one agency earning at once keep the agency wallet consistent", { todo: "LIVE-24" }, async () => {
    const agency = await makeAgency("A", 1600);
    const [h1, h2] = [await makeUser({ agencyUserId: agency.id }), await makeUser({ agencyUserId: agency.id })];
    const [s1, s2] = [await makeUser({ coins: 1_000_000n }), await makeUser({ coins: 1_000_000n })];
    const gift = await makeGift(100);
    const [c1, c2] = [await makeActiveCall(s1.id, h1.id), await makeActiveCall(s2.id, h2.id)];
    for (const u of [h1, h2, agency]) await ensureWallets(u.id);

    const ops = [];
    for (let i = 0; i < N; i++) {
        ops.push(videoCall.sendGift(c1.id, s1.id, gift.id, 1));
        ops.push(videoCall.sendGift(c2.id, s2.id, gift.id, 1));
    }
    const rs = await settledAll(ops);
    assert.equal(rs.filter((r) => r.status === "rejected").length, 0, `rejected: ${reasons(rs)}`);

    const aw = await walletIdOf(agency.id, "POINT");
    assert.deepEqual(await ledgerProblems([aw]), [], "agency wallet balance must equal the sum of its commission credits");
});

test("LIVE-24 cross-service: Live-server commission racing an ol-node-rest-style locked credit", { todo: "LIVE-24" }, async () => {
    const agency = await makeAgency("A", 1600);
    const h1 = await makeUser({ agencyUserId: agency.id });
    const s1 = await makeUser({ coins: 1_000_000n });
    const gift = await makeGift(100);
    const c1 = await makeActiveCall(s1.id, h1.id);
    for (const u of [h1, agency]) await ensureWallets(u.id);
    await olNodeStyleLockedCredit(agency.id, 1n); // agency already has a balance before the race

    const ops = [];
    for (let i = 0; i < N; i++) {
        ops.push(videoCall.sendGift(c1.id, s1.id, gift.id, 1));
        ops.push(olNodeStyleLockedCredit(agency.id, 7n));
    }
    const rs = await settledAll(ops);
    assert.equal(rs.filter((r) => r.status === "rejected").length, 0, `rejected: ${reasons(rs)}`);
    assert.deepEqual(await ledgerProblems([await walletIdOf(agency.id, "POINT")]), []);
});

test("LIVE-56: the first gifts to a brand-new host (no wallet yet) all succeed", { todo: "LIVE-56" }, async () => {
    // getOrCreateWallet is find-then-create: parallel first gifts race to create the receiver's
    // POINT wallet, the losers hit P2002 on (user_id, currency_type), and the controller reports
    // that as 409 "Duplicate gift send (already processed)" although nothing was sent.
    const sender = await makeUser({ coins: 1_000_000n });
    const newHost = await makeUser(); // deliberately no wallets
    const gift = await makeGift(100);
    const call = await makeActiveCall(sender.id, newHost.id);

    const rs = await settledAll(Array.from({ length: N }, () => videoCall.sendGift(call.id, sender.id, gift.id, 1)));
    assert.equal(rs.filter((r) => r.status === "rejected").length, 0, `rejected: ${reasons(rs)}`);
    assert.deepEqual(await ledgerProblems([await walletIdOf(sender.id, "COIN"), await walletIdOf(newHost.id, "POINT")]), []);
});

test("LIVE-25: the minute-1 agency commission is committed together with the call accept", { todo: "LIVE-25" }, async () => {
    const agency = await makeAgency("A", 1600);
    const hostUser = await makeUser({ agencyUserId: agency.id });
    const caller = await makeUser({ coins: 1_000_000n });
    const session = await prisma.videoCallSession.create({
        data: { callerId: caller.id, creatorId: hostUser.id, livekitRoom: `room_${Date.now()}_${Math.random()}`, pricePerMin: 600, status: "RINGING" },
    });

    await videoCall.acceptCall(session.id, hostUser.id);
    // Read straight after the accept returns: a committed accept must already include the commission.
    const hostLedger = await prisma.pointLedgerEntry.findFirst({ where: { idempotencyKey: `call-${session.id}-min-1-points` } });
    const commission = await prisma.pointLedgerEntry.findFirst({ where: { idempotencyKey: `agency-commission-${hostLedger.id}` } });
    assert.ok(commission, "commission row must exist as soon as the accept has committed");
});

test("LIVE-26: concurrent endCall calls have exactly one winner", { todo: "LIVE-26" }, async () => {
    const caller = await makeUser({ coins: 10_000n });
    const hostUser = await makeUser();
    const call = await makeActiveCall(caller.id, hostUser.id);

    const rs = await settledAll(Array.from({ length: 5 }, () => videoCall.endCall(call.id, caller.id, "USER_ENDED")));
    const winners = fulfilled(rs).filter((v) => v !== null);
    assert.equal(winners.length, 1, `expected 1 winning end, got ${winners.length}`);
});

test("LIVE-28: a double-tapped call start creates one ringing session", { todo: "LIVE-28" }, async () => {
    const caller = await makeUser({ coins: 1_000_000n });
    const hostUser = await makeUser();
    await prisma.videoCallSettings.create({ data: { userId: hostUser.id } });

    await settledAll(Array.from({ length: 10 }, () => videoCall.initiateCall({ callerId: caller.id, creatorId: hostUser.id })));
    const ringing = await prisma.videoCallSession.count({ where: { callerId: caller.id, creatorId: hostUser.id, status: "RINGING" } });
    assert.equal(ringing, 1, `expected 1 ringing session, got ${ringing}`);
});

test("LIVE-29: concurrent stream ends run the end path once", { todo: "LIVE-29" }, async () => {
    const hostUser = await makeUser();
    const streamId = crypto.randomUUID();
    await prisma.liveStream.create({
        data: { id: streamId, streamId, userId: hostUser.id, title: "t", streamKey: `k_${streamId}`, isLive: true, startedAt: new Date() },
    });

    const rs = await settledAll(Array.from({ length: 5 }, () => live.endLiveStreamService({ id: streamId, userId: hostUser.id, reason: "TEST" })));
    const realEnds = fulfilled(rs).filter((v) => v && !v.alreadyEnded);
    assert.equal(realEnds.length, 1, `expected 1 real end, got ${realEnds.length}`);
});
