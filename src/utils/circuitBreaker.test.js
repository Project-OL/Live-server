import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCircuitBreaker, CircuitOpenError } from './circuitBreaker.js';

const clock = () => {
    let t = 1_000;
    return { now: () => t, advance: (ms) => { t += ms; } };
};
const fail = async () => { throw new Error('down'); };
const ok = async () => 'ok';

test('opens after the threshold, fails fast while open, closes after a good trial', async () => {
    const c = clock();
    const b = createCircuitBreaker({ name: 't', failureThreshold: 3, openMs: 1000, now: c.now });
    for (let i = 0; i < 3; i++) await assert.rejects(b.exec(fail), /down/);
    assert.equal(b.state(), 'open');
    let called = false;
    await assert.rejects(b.exec(async () => { called = true; }), CircuitOpenError);
    assert.equal(called, false);
    c.advance(1000);
    assert.equal(b.state(), 'half-open');
    assert.equal(await b.exec(ok), 'ok');
    assert.equal(b.state(), 'closed');
});

test('a failed trial reopens it at once', async () => {
    const c = clock();
    const b = createCircuitBreaker({ name: 't', failureThreshold: 2, openMs: 500, now: c.now });
    await assert.rejects(b.exec(fail));
    await assert.rejects(b.exec(fail));
    c.advance(500);
    await assert.rejects(b.exec(fail), /down/);
    assert.equal(b.state(), 'open');
});

test('a success resets the count; ignored errors never open it', async () => {
    const b = createCircuitBreaker({ name: 't', failureThreshold: 2, isFailure: (e) => e.message !== 'bad input' });
    await assert.rejects(b.exec(fail));
    await b.exec(ok);
    await assert.rejects(b.exec(fail));
    assert.equal(b.state(), 'closed');
    for (let i = 0; i < 5; i++) await assert.rejects(b.exec(async () => { throw new Error('bad input'); }));
    assert.equal(b.state(), 'closed');
});

test('only one trial runs in half-open; the rest fail fast', async () => {
    const c = clock();
    const b = createCircuitBreaker({ name: 't', failureThreshold: 1, openMs: 10, now: c.now });
    await assert.rejects(b.exec(fail));
    c.advance(10);
    let release;
    const trial = b.exec(() => new Promise((r) => { release = r; }));
    await assert.rejects(b.exec(ok), CircuitOpenError);
    release('done');
    assert.equal(await trial, 'done');
    assert.equal(b.state(), 'closed');
});
