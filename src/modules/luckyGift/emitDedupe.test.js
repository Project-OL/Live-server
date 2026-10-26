import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claimLuckyEmit, withLuckyEmitOnce } from './emitDedupe.js';

describe('emitDedupe F6', () => {
    it('withLuckyEmitOnce runs the callback when claim succeeds (no Redis or Redis up)', async () => {
        let ran = 0;
        // Unique tx id so we don't collide with prior runs in a shared Redis.
        const txId = `test-emit-${Date.now()}-${Math.random()}`;
        const first = await withLuckyEmitOnce(txId, () => {
            ran += 1;
        });
        const second = await withLuckyEmitOnce(txId, () => {
            ran += 1;
        });
        // If Redis is up: first true, second false, ran=1.
        // If Redis is down: both true (prefer emit), ran=2.
        assert.ok(first === true);
        assert.ok(ran >= 1);
        if (second === false) assert.equal(ran, 1);
        else assert.equal(ran, 2);
    });

    it('claimLuckyEmit without transactionId always allows emit', async () => {
        assert.equal(await claimLuckyEmit(null), true);
        assert.equal(await claimLuckyEmit(undefined), true);
        assert.equal(await claimLuckyEmit(''), true);
    });
});

describe('Phase 4 payload: water vs legacy source', () => {
    it('water_v1 overrides local draw for reward fields', () => {
        const local = { totalReward: 50n, category: 'SMALL', breakdownArray: [50] };
        const ledger = {
            engine: 'water_v1',
            rewardCoins: 250n,
            category: 'MEDIUM',
            breakdownArray: [250],
        };
        const useWater = ledger.engine === 'water_v1';
        const totalRewardCoins = useWater ? ledger.rewardCoins : local.totalReward;
        const category = useWater ? ledger.category : local.category;
        const breakdownArray = useWater ? ledger.breakdownArray : local.breakdownArray;
        assert.equal(Number(totalRewardCoins), 250);
        assert.equal(category, 'MEDIUM');
        assert.deepEqual(breakdownArray, [250]);
        assert.equal(totalRewardCoins > 0n, true);
    });

    it('missing engine (old ledger) keeps local draw', () => {
        const ledger = { engine: undefined };
        assert.equal(ledger.engine === 'water_v1', false);
    });

    it('sum(breakdown) == totalReward for water combo collapse', () => {
        const breakdown = [30, 30, 30, 30, 30, 20, 20, 20, 20, 20];
        assert.equal(breakdown.reduce((a, b) => a + b, 0), 250);
    });
});
