import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachReadonlyRecovery,
  isReadonlyError,
  READONLY_RECONNECT_COOLDOWN_MS,
  redisClientOptions,
  redisReconnectStrategy,
} from "./redis.js";

const fakeRedis = (reply) => {
  const calls = { destroy: 0, connect: 0 };
  return {
    calls,
    sendCommand: () => reply(),
    destroy: () => { calls.destroy++; },
    connect: async () => { calls.connect++; },
  };
};
const tick = () => new Promise((r) => setImmediate(r));

test("reconnect strategy never gives up and caps at ~2 s", () => {
  for (const n of [0, 1, 5, 50, 10000]) {
    const ms = redisReconnectStrategy(n);
    assert.equal(typeof ms, "number");
    assert.ok(ms >= Math.min(n * 200, 2000) && ms < 2100, `retries=${n} -> ${ms}`);
  }
});

test("client options carry the strategy, ping and a bounded offline queue", () => {
  const o = redisClientOptions("redis://x:6379");
  assert.equal(o.socket.reconnectStrategy, redisReconnectStrategy);
  assert.equal(o.pingInterval, 30000);
  assert.ok(o.commandsQueueMaxLength > 0);
});

test("isReadonlyError matches only READONLY replies", () => {
  assert.ok(isReadonlyError(new Error("READONLY You can't write against a read only replica.")));
  assert.ok(!isReadonlyError(new Error("WRONGTYPE Operation against a key")));
  assert.ok(!isReadonlyError(undefined));
});

test("READONLY rejects the command and forces one reconnect", async () => {
  const r = fakeRedis(() => Promise.reject(new Error("READONLY replica")));
  attachReadonlyRecovery(r, "t");
  await assert.rejects(r.sendCommand(["SET", "k", "v"]), /READONLY/);
  await tick(); await tick();
  assert.deepEqual(r.calls, { destroy: 1, connect: 1 });
});

test("READONLY reconnects at most once per cooldown window", async () => {
  let t = 1_000_000;
  const r = fakeRedis(() => Promise.reject(new Error("READONLY replica")));
  attachReadonlyRecovery(r, "t", () => t);
  await Promise.allSettled([r.sendCommand(["SET"]), r.sendCommand(["SET"]), r.sendCommand(["SET"])]);
  await tick(); await tick();
  assert.equal(r.calls.destroy, 1);
  t += READONLY_RECONNECT_COOLDOWN_MS;
  await assert.rejects(r.sendCommand(["SET"]));
  await tick(); await tick();
  assert.equal(r.calls.destroy, 2);
});

test("real node-redis client: patch reaches the instance commands run through", async () => {
  const { createClient } = await import("redis");
  const c = attachReadonlyRecovery(createClient(), "t");
  // Not connected: the command must still go through the patched sendCommand (ClientClosedError).
  await assert.rejects(c.set("k", "v"), (err) => err.constructor.name === "ClientClosedError");
  assert.notEqual(c._self.sendCommand, Object.getPrototypeOf(c._self).sendCommand);
});

test("other errors and successes pass through without reconnecting", async () => {
  const bad = fakeRedis(() => Promise.reject(new Error("WRONGTYPE x")));
  attachReadonlyRecovery(bad, "t");
  await assert.rejects(bad.sendCommand(["GET"]), /WRONGTYPE/);
  const ok = fakeRedis(() => Promise.resolve("OK"));
  attachReadonlyRecovery(ok, "t");
  assert.equal(await ok.sendCommand(["SET"]), "OK");
  await tick();
  assert.equal(bad.calls.destroy + ok.calls.destroy, 0);
});
