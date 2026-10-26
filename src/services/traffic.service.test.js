import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.IS_TEST = process.env.IS_TEST || '1';
const { istHourKey, sectionForPath } = await import('./traffic.service.js');

test('TRF-03: IST hour key matches ol-node-rest and crosses the UTC date line', () => {
    assert.equal(istHourKey(Date.parse('2026-10-25T18:29:59Z')), '2026102523');
    assert.equal(istHourKey(Date.parse('2026-10-25T18:30:00Z')), '2026102600');
    assert.equal(istHourKey(Date.parse('2026-10-26T06:45:00Z')), '2026102612');
});

test('TRF-03: only app routes get a section', () => {
    assert.equal(sectionForPath('/api/live-stream/list'), 'Live');
    assert.equal(sectionForPath('/api/live-stream/join/abc?x=1'), 'Live');
    assert.equal(sectionForPath('/api/video-call/initiate'), 'Video call');
    assert.equal(sectionForPath('/api/video-call/webhook'), null);
    assert.equal(sectionForPath('/api/admin/live/failures'), null);
    assert.equal(sectionForPath('/api/v1/admin/live/failures'), null);
    assert.equal(sectionForPath('/live-health'), null);
});
