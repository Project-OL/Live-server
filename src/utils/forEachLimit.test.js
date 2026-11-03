import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forEachLimit } from './forEachLimit.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('never runs more than the limit at once and visits every item', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen = [];
    await forEachLimit([...Array(25).keys()], 4, async (i) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(2 + (i % 3));
        seen.push(i);
        inFlight--;
    });
    assert.equal(peak, 4);
    assert.deepEqual(seen.sort((a, b) => a - b), [...Array(25).keys()]);
});

test('one failing item does not stop the others; onError gets it', async () => {
    const done = [];
    const errs = [];
    await forEachLimit([1, 2, 3, 4], 2, async (i) => {
        if (i === 2) throw new Error('boom');
        done.push(i);
    }, (err, item) => errs.push([err.message, item]));
    assert.deepEqual(done.sort(), [1, 3, 4]);
    assert.deepEqual(errs, [['boom', 2]]);
});

test('without onError the first error is rethrown after all items ran', async () => {
    const done = [];
    await assert.rejects(
        forEachLimit([1, 2, 3], 3, async (i) => {
            if (i === 1) throw new Error('first');
            await sleep(5);
            done.push(i);
        }),
        /first/
    );
    assert.deepEqual(done.sort(), [2, 3]);
});

test('empty input and bad limits are safe', async () => {
    await forEachLimit([], 5, async () => { throw new Error('never'); });
    let calls = 0;
    await forEachLimit([1, 2], 0, async () => { calls++; });
    await forEachLimit([1, 2], 'x', async () => { calls++; });
    assert.equal(calls, 4);
});
