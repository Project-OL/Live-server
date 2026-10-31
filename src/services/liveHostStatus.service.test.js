import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMarkerRepair, liveStatusFrame, activeStreamKey } from './liveHostStatus.service.js';

const live = [{ userId: 'h1', streamId: 's1' }];

test('LIVE-60: a marker of a live stream is kept and its TTL renewed', () => {
    const plan = planMarkerRepair(new Map([['h1', 's1']]), live, new Set());
    assert.deepEqual(plan.del, []);
    assert.deepEqual(plan.set, []);
    assert.deepEqual(plan.touch, ['h1']);
    assert.equal(plan.suspects.size, 0);
});

test('LIVE-60: a stale marker is only deleted on the second tick in a row', () => {
    const markers = new Map([['h2', 'old']]);
    const first = planMarkerRepair(markers, live, new Set());
    assert.deepEqual(first.del, []);
    const second = planMarkerRepair(markers, live, first.suspects);
    assert.deepEqual(second.del, [{ userId: 'h2', streamId: 'old' }]);
});

test('LIVE-60: a missing marker is restored only on the second tick', () => {
    const first = planMarkerRepair(new Map(), live, new Set());
    assert.deepEqual(first.set, []);
    const second = planMarkerRepair(new Map(), live, first.suspects);
    assert.deepEqual(second.set, [{ userId: 'h1', streamId: 's1' }]);
});

test('LIVE-60: a fresh go-live seen once (marker, no row yet) is never deleted', () => {
    const first = planMarkerRepair(new Map([['h3', 'new']]), [], new Set());
    // Next tick the row exists, so the suspect clears.
    const second = planMarkerRepair(new Map([['h3', 'new']]), [{ userId: 'h3', streamId: 'new' }], first.suspects);
    assert.deepEqual(second.del, []);
    assert.equal(second.suspects.size, 0);
});

test('LIVE-60: a marker pointing at an ended stream while another is live is replaced', () => {
    const markers = new Map([['h1', 'old']]);
    const t1 = planMarkerRepair(markers, live, new Set());
    const t2 = planMarkerRepair(markers, live, t1.suspects);
    assert.deepEqual(t2.del, [{ userId: 'h1', streamId: 'old' }]);
    assert.deepEqual(t2.set, []); // marker present at read time; restored on the following ticks
});

test('LIVE-60: LIVE_STATUS frame shape', () => {
    assert.deepEqual(liveStatusFrame('u', true, 's'), { t: 'LIVE_STATUS', userId: 'u', isLive: true, liveStreamId: 's' });
    assert.deepEqual(liveStatusFrame('u', false, 's'), { t: 'LIVE_STATUS', userId: 'u', isLive: false, liveStreamId: null });
    assert.equal(activeStreamKey('u'), 'user:active_stream:u');
});
