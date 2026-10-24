import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LUCKY_GIFT_CONFIG } from '../../config/luckyGift.config.js';
import {
    calculateSingleReward,
    calculateComboReward,
    setLuckyRewardRandom,
    expectedComboEv,
    isLegacyComboReduceFixEnabled,
    LEGACY_COMBO_NEUTRAL_EV,
    LEGACY_COMBO_BUGGY_REDUCE_EV,
    LEGACY_COMBO_FIXED_REDUCE_EV,
    LEGACY_COMBO_REDUCE_WEIGHTS,
} from './luckyReward.engine.js';

/** Deterministic sequence: yields values in [0,1) cycling through `seq`. */
function seqRandom(seq) {
    let i = 0;
    return () => {
        const v = seq[i % seq.length];
        i += 1;
        return v;
    };
}

describe('luckyReward.engine LG-01 + RNG injection', () => {
    const prev = process.env.LUCKY_LEGACY_COMBO_REDUCE_FIX;

    beforeEach(() => {
        setLuckyRewardRandom(Math.random);
        delete process.env.LUCKY_LEGACY_COMBO_REDUCE_FIX;
    });

    afterEach(() => {
        setLuckyRewardRandom(Math.random);
        if (prev === undefined) delete process.env.LUCKY_LEGACY_COMBO_REDUCE_FIX;
        else process.env.LUCKY_LEGACY_COMBO_REDUCE_FIX = prev;
    });

    it('neutral combo EV = 66.5%', () => {
        const ev = expectedComboEv(LUCKY_GIFT_CONFIG.comboOdds);
        assert.equal(Number(ev.toFixed(6)), LEGACY_COMBO_NEUTRAL_EV);
    });

    it('boost path EV unchanged (multiplier +0.05 on ratios)', () => {
        // Boost does not change weights; EV of ratios+0.05:
        const boosted = expectedComboEv(LUCKY_GIFT_CONFIG.comboOdds, (c) => (c.returnRatio ?? 0) + 0.05);
        assert.equal(Number(boosted.toFixed(6)), 0.715);
    });

    it('reduce EV with fix enabled = 62.5% (below neutral)', () => {
        process.env.LUCKY_LEGACY_COMBO_REDUCE_FIX = 'true';
        assert.equal(isLegacyComboReduceFixEnabled(), true);
        const odds = LUCKY_GIFT_CONFIG.comboOdds.map((c) => ({
            ...c,
            weight: LEGACY_COMBO_REDUCE_WEIGHTS[c.id] ?? c.weight,
        }));
        const ev = expectedComboEv(odds);
        assert.equal(Number(ev.toFixed(6)), LEGACY_COMBO_FIXED_REDUCE_EV);
        assert.ok(ev < LEGACY_COMBO_NEUTRAL_EV);
    });

    it('flag=false reproduces old buggy reduce EV 73.75%', () => {
        process.env.LUCKY_LEGACY_COMBO_REDUCE_FIX = 'false';
        assert.equal(isLegacyComboReduceFixEnabled(), false);
        const buggy = expectedComboEv(
            LUCKY_GIFT_CONFIG.comboOdds,
            (c) => Math.max(0.5, (c.returnRatio ?? 0) - 0.05)
        );
        assert.equal(Number(buggy.toFixed(6)), LEGACY_COMBO_BUGGY_REDUCE_EV);
        assert.ok(buggy > LEGACY_COMBO_NEUTRAL_EV);
    });

    it('injectable RNG selects single categories deterministically', () => {
        // Neutral weights: MISS40, SMALL30, EQUAL20, MEDIUM9, JACKPOT1 (sum 100)
        // rand*100 in (40,70] → SMALL; (0,40] → MISS; (70,90] → EQUAL; (90,99] → MEDIUM; >99 → JACKPOT
        setLuckyRewardRandom(seqRandom([0.0])); // → MISS
        assert.equal(calculateSingleReward({ giftCoinCost: 100, currentRtp: 92, targetRtp: 92 }).category, 'MISS');
        setLuckyRewardRandom(seqRandom([0.45])); // 45 → SMALL
        assert.equal(calculateSingleReward({ giftCoinCost: 100, currentRtp: 92, targetRtp: 92 }).category, 'SMALL');
        setLuckyRewardRandom(seqRandom([0.75])); // 75 → EQUAL
        assert.equal(calculateSingleReward({ giftCoinCost: 100, currentRtp: 92, targetRtp: 92 }).category, 'EQUAL');
        setLuckyRewardRandom(seqRandom([0.95])); // 95 → MEDIUM
        assert.equal(calculateSingleReward({ giftCoinCost: 100, currentRtp: 92, targetRtp: 92 }).category, 'MEDIUM');
        setLuckyRewardRandom(seqRandom([0.995])); // 99.5 → JACKPOT
        assert.equal(calculateSingleReward({ giftCoinCost: 100, currentRtp: 92, targetRtp: 92 }).category, 'JACKPOT');
    });

    it('single multipliers map to rewardCoins', () => {
        setLuckyRewardRandom(seqRandom([0.995]));
        const j = calculateSingleReward({ giftCoinCost: 100, currentRtp: 92, targetRtp: 92 });
        assert.equal(j.rewardCoins, 1000n);
        assert.equal(j.multiplier, 10);
        setLuckyRewardRandom(seqRandom([0.45]));
        const s = calculateSingleReward({ giftCoinCost: 100, currentRtp: 92, targetRtp: 92 });
        assert.equal(s.rewardCoins, 50n);
    });

    it('combo reduce with fix uses reweighted table (MISS more likely)', () => {
        process.env.LUCKY_LEGACY_COMBO_REDUCE_FIX = 'true';
        // Reduce weights: MISS28 → rand 0.0 picks MISS
        setLuckyRewardRandom(seqRandom([0.0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]));
        const r = calculateComboReward({
            giftCoinCost: 100,
            comboCount: 3,
            currentRtp: 100,
            targetRtp: 92,
        });
        assert.equal(r.category, 'MISS');
        assert.equal(r.totalReward, 0n);
    });
});
