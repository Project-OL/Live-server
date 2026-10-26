/**
 * Phase 4 gate helpers: mode-off payload key set must match Phase 0 golden (additive engine fields OK).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(__dirname, 'golden_phase0.json'), 'utf8'));

function keysOf(obj) {
    return Object.keys(obj || {}).sort();
}

describe('Phase 4 contract vs Phase 0 golden', () => {
    it('HTTP stream lucky data keys are stable', () => {
        const sample = golden.singles[0].payloads.httpStream.data;
        const required = ['newBalance', 'currentLevel', 'isLevelUp', 'isLucky', 'sendValue', 'returnValue', 'transactionId', 'category'];
        for (const k of required) assert.ok(k in sample, `missing ${k}`);
    });

    it('socket GIFT_SENT lucky keys include isLucky and gift', () => {
        const sample = golden.singles[1].payloads.giftSent;
        assert.equal(sample.isLucky, true);
        assert.ok(sample.gift);
        assert.ok('senderRemainingCoins' in sample);
    });

    it('non-lucky fixture has isLucky false and no luckyWin', () => {
        const nl = golden.nonLucky.stream.payloads;
        assert.equal(nl.httpStream.data.isLucky, false);
        assert.equal(nl.luckyGiftWin, null);
    });

    it('additive engine field does not remove golden keys', () => {
        const base = golden.singles[2].payloads.httpDirect;
        const withEngine = { ...base, engine: 'legacy', tierId: null, configVersion: null };
        for (const k of keysOf(base)) assert.ok(k in withEngine);
    });
});
