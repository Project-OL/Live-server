import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.IS_TEST = process.env.IS_TEST || '1';
const { deriveSeverity, recordClientEvent, LIVE_FAILURE_KINDS } = await import('./liveFailureLog.service.js');
const { livekitCause, disconnectReasonName, isAbnormalLeave } = await import('./livekitEvents.service.js');
const { notifyServerShift } = await import('../socket/index.js');

test('BE-01: severities follow the taxonomy', () => {
    assert.equal(deriveSeverity({ kind: 'HEARTBEAT_LOST', code: 'HEARTBEAT_LOST' }), 'S1');
    assert.equal(deriveSeverity({ kind: 'HEARTBEAT_LOST', code: 'HOST_NO_VIDEO' }), 'S2');
    assert.equal(deriveSeverity({ kind: 'GHOST_STREAM_ENDED', code: 'NO_LIVEKIT_HOST' }), 'S2');
    assert.equal(deriveSeverity({ kind: 'JOIN_REJECTED', code: 'KICKED' }), 'S4');
    assert.equal(deriveSeverity({ kind: 'GO_LIVE_REJECTED', code: 'VALIDATION' }), 'S3');
    assert.equal(deriveSeverity({ kind: 'CLIENT_CONNECT_FAILED', code: 'CANCELLED_BY_USER' }), 'S4');
    assert.equal(deriveSeverity({ kind: 'CLIENT_CONNECT_FAILED', code: 'TIMEOUT_LIVEKIT_CONNECT' }), 'S2');
    assert.equal(deriveSeverity({ kind: 'CALL_NET_LOST', code: 'HEARTBEAT_LOST' }), 'S1');
    assert.equal(deriveSeverity({ kind: 'CLIENT_EVENT', code: 'APP_CRASH_LOOP' }), 'S1');
    assert.equal(deriveSeverity({ kind: 'CLIENT_EVENT', code: 'NET_WEAK' }), 'S3');
});

test('BE-01: a crash on a live screen, or a host with >20 viewers, is one level higher', () => {
    assert.equal(deriveSeverity({ kind: 'CLIENT_EVENT', code: 'APP_FATAL_NATIVE', meta: { screen: 'go_live_screen' } }), 'S1');
    assert.equal(deriveSeverity({ kind: 'CLIENT_EVENT', code: 'APP_FATAL_NATIVE', meta: { screen: 'wallet' } }), 'S2');
    assert.equal(deriveSeverity({ kind: 'GHOST_STREAM_ENDED', code: 'X', role: 'host', meta: { viewers: 25 } }), 'S1');
});

test('BE-01: an explicit valid severity wins, an invalid one is ignored', () => {
    assert.equal(deriveSeverity({ kind: 'CLIENT_EVENT', code: 'NET_WEAK', severity: 'S0' }), 'S0');
    assert.equal(deriveSeverity({ kind: 'CLIENT_EVENT', code: 'NET_WEAK', severity: 'S9' }), 'S3');
});

test('BE-02: client events are validated', async () => {
    const now = Date.parse('2026-10-26T12:00:00Z');
    const ok = { area: 'app', failureCode: 'APP_FATAL_DART', occurredAt: '2026-10-26T11:00:00Z' };
    assert.equal(await recordClientEvent('u', ok, '1.0.0+20', now), 'ok');
    assert.equal(await recordClientEvent('u', { ...ok, area: 'moon' }, null, now), 'bad_area');
    assert.equal(await recordClientEvent('u', { ...ok, failureCode: 'bad code!' }, null, now), 'bad_failureCode');
    assert.equal(await recordClientEvent('u', { ...ok, occurredAt: 'yesterday' }, null, now), 'bad_occurredAt');
    assert.equal(await recordClientEvent('u', { ...ok, occurredAt: '2026-10-01T00:00:00Z' }, null, now), 'occurredAt_out_of_range');
    assert.equal(await recordClientEvent('u', null, null, now), 'not_an_object');
    assert.ok(LIVE_FAILURE_KINDS.CLIENT_EVENT);
});

test('BE-06: LiveKit cause from the webhook history', () => {
    assert.equal(livekitCause({ joined: false }), 'NEVER_REACHED_LIVEKIT');
    assert.equal(livekitCause({ joined: true, gone: true, lastLeftReason: 'JOIN_FAILURE' }), 'LEFT_LIVEKIT_JOIN_FAILURE');
    assert.equal(livekitCause({ joined: true, gone: false, publishedVideo: false }), 'IN_LIVEKIT_NO_VIDEO');
    assert.equal(livekitCause({ joined: true, gone: false, publishedVideo: true }), 'IN_LIVEKIT');
    assert.equal(disconnectReasonName(7), 'JOIN_FAILURE');
    assert.equal(disconnectReasonName(1), 'CLIENT_INITIATED');
    assert.equal(isAbnormalLeave('CLIENT_INITIATED'), false);
    assert.equal(isAbnormalLeave('STATE_MISMATCH'), true);
});

test('BE-08: every local socket gets server_shift with its own delay under 3 s', () => {
    const sent = [];
    const fake = (id) => ({ emit: (event, payload) => sent.push({ id, event, payload }) });
    const server = { sockets: { sockets: new Map([['a', fake('a')], ['b', fake('b')]]) } };
    assert.equal(notifyServerShift(server), 2);
    assert.deepEqual(sent.map((s) => s.event), ['server_shift', 'server_shift']);
    for (const s of sent) assert.ok(s.payload.retryInMs >= 0 && s.payload.retryInMs < 3000);
});
