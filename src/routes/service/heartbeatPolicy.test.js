import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heartbeatVerdict } from './heartbeatPolicy.js';

const base = {
    now: 1_000_000,
    ageMs: 300_000,
    lastHeartbeatTime: null,
    timeoutMs: 90_000,
    startGraceMs: 15_000,
    paused: false,
    hostInLiveKit: false,
};

test('recent heartbeat keeps the stream', () => {
    assert.equal(heartbeatVerdict({ ...base, lastHeartbeatTime: base.now - 10_000 }), 'alive');
});

test('inside the start grace nothing happens even without a heartbeat', () => {
    assert.equal(heartbeatVerdict({ ...base, ageMs: 5_000 }), 'alive');
});

test('stale heartbeat but host still in LiveKit: keep alive (minimized room / dead socket)', () => {
    assert.equal(
        heartbeatVerdict({ ...base, lastHeartbeatTime: base.now - 120_000, hostInLiveKit: true }),
        'keepalive',
    );
});

test('never any heartbeat but host publishing in LiveKit: keep alive (NO_HEARTBEAT_EVER case)', () => {
    assert.equal(heartbeatVerdict({ ...base, ageMs: 95_000, hostInLiveKit: true }), 'keepalive');
});

test('stale heartbeat, host gone from LiveKit, paused for a call: paused', () => {
    assert.equal(
        heartbeatVerdict({ ...base, lastHeartbeatTime: base.now - 120_000, paused: true }),
        'paused',
    );
});

test('stale heartbeat and host gone from LiveKit: end', () => {
    assert.equal(heartbeatVerdict({ ...base, lastHeartbeatTime: base.now - 120_000 }), 'end');
});

test('exactly at the timeout is still alive', () => {
    assert.equal(heartbeatVerdict({ ...base, lastHeartbeatTime: base.now - 90_000 }), 'alive');
});
