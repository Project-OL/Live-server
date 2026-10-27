import { test } from 'node:test';
import assert from 'node:assert/strict';

const { decideRejoin, rejoinTokenService } = await import('./rejoinToken.service.js');

const live = { id: 'db1', streamId: 'room1', userId: 'host1', isLive: true };

const deps = (over = {}) => ({
    getStream: async () => live,
    isKicked: async () => null,
    hasJoined: async () => true,
    hostToken: async (room, uid) => `host:${room}:${uid}`,
    viewerToken: async (room, uid) => `viewer:${room}:${uid}`,
    ...over,
});

test('BE-14: 404 when the stream is missing or ended', () => {
    assert.equal(decideRejoin({ stream: null, userId: 'u' }).status, 404);
    const ended = decideRejoin({ stream: { ...live, isLive: false }, userId: 'host1' });
    assert.deepEqual([ended.status, ended.code], [404, 'STREAM_ENDED']);
});

test('BE-14: the host gets a host token for the same room', async () => {
    const r = await rejoinTokenService({ id: 'db1', userId: 'host1' }, deps({
        isKicked: async () => { throw new Error('not checked for the host'); },
    }));
    assert.deepEqual(r, { ok: true, role: 'host', token: 'host:room1:host1', streamId: 'room1', id: 'db1' });
});

test('BE-14: a viewer who joined gets a viewer token', async () => {
    const r = await rejoinTokenService({ id: 'room1', userId: 'v1' }, deps());
    assert.equal(r.role, 'viewer');
    assert.equal(r.token, 'viewer:room1:v1');
});

test('BE-14: a kicked viewer, or one who never joined, is refused', async () => {
    const kicked = await rejoinTokenService({ id: 'room1', userId: 'v1' }, deps({ isKicked: async () => 600 }));
    assert.deepEqual([kicked.ok, kicked.status, kicked.code], [false, 403, 'KICKED']);
    const stranger = await rejoinTokenService({ id: 'room1', userId: 'v2' }, deps({ hasJoined: async () => false }));
    assert.deepEqual([stranger.ok, stranger.status, stranger.code], [false, 403, 'NOT_JOINED']);
});

test('BE-14: an ended stream returns 404 without minting a token', async () => {
    const r = await rejoinTokenService({ id: 'room1', userId: 'host1' }, deps({
        getStream: async () => ({ ...live, isLive: false }),
        hostToken: async () => { throw new Error('must not mint'); },
    }));
    assert.equal(r.status, 404);
});
