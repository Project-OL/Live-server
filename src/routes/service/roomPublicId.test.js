import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomPublicId, withSheetPublicIds } from './roomPublicId.js';

test('roomPublicId: BigInt public id becomes a string', () => {
    assert.equal(roomPublicId({ publicId: 34220465n }), '34220465');
});

test('roomPublicId: mystery VIP gets no id', () => {
    assert.equal(roomPublicId({ publicId: 34220465n, privacyMysteryLive: true, vipSubscriptionActive: true }), null);
});

test('roomPublicId: mystery flag without active VIP is not stealth', () => {
    assert.equal(roomPublicId({ publicId: 1n, privacyMysteryLive: true, vipSubscriptionActive: false }), '1');
});

test('roomPublicId: missing user or id', () => {
    assert.equal(roomPublicId(null), null);
    assert.equal(roomPublicId({ publicId: null }), null);
});

test('withSheetPublicIds: fills ids, hides stealth, keeps other fields', async () => {
    const lookup = async ({ userId }) =>
        userId === 'stealth' ? { publicId: '9', isStealth: true } : { publicId: '42', isStealth: false };
    const out = await withSheetPublicIds(
        [{ userId: 'a', username: 'A', isMuted: true }, { userId: 'stealth', username: 'Mystery' }],
        lookup,
    );
    assert.deepEqual(out, [
        { userId: 'a', username: 'A', isMuted: true, publicId: '42' },
        { userId: 'stealth', username: 'Mystery', publicId: null },
    ]);
});

test('withSheetPublicIds: a failed lookup does not fail the list', async () => {
    const out = await withSheetPublicIds([{ userId: 'a' }], async () => { throw new Error('redis down'); });
    assert.deepEqual(out, [{ userId: 'a', publicId: null }]);
});

test('withSheetPublicIds: existing id is not looked up again; empty list passes through', async () => {
    let calls = 0;
    const out = await withSheetPublicIds([{ userId: 'a', publicId: '7' }], async () => { calls++; return {}; });
    assert.deepEqual(out, [{ userId: 'a', publicId: '7' }]);
    assert.equal(calls, 0);
    assert.deepEqual(await withSheetPublicIds([], async () => ({})), []);
});
