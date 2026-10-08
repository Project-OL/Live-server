/**
 * Multi-node primitives for Live-server (backlog LIVE-09, design doc
 * ol-node-rest docs/gcp-migration/HORIZONTAL_SCALING_DESIGN.md section 2).
 *
 * Everything here degrades to the old single-process behaviour when Redis is
 * unavailable, so one node keeps working exactly as before.
 *
 *   L5 leader lock    runAsLeader(name) - only one node runs each singleton loop.
 *   L4 durable timers scheduleDurable/cancelDurable - deadlines live in Redis, so a
 *                     restart or another node still fires them; a local setTimeout
 *                     keeps the original precision on the node that scheduled it.
 *   L6 shutdown       onShutdown(fn) + isShuttingDown() - used by server.js.
 *
 * Redis keys (shared Redis, no prefix):
 *   live:leader:<name>       STRING nodeId, PX LEADER_TTL_MS (renewed every tick)
 *   live:deadlines           ZSET member "<kind>|<key>", score = due epoch ms
 *   live:deadlines:payload   HASH member -> JSON payload
 */
import os from 'os';
import crypto from 'crypto';
import { client as redisClient } from '../config/redis.js';

export const NODE_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;

// ---------------------------------------------------------------------------
// L6: shutdown registry
// ---------------------------------------------------------------------------

let shuttingDown = false;
const shutdownHooks = [];

/** True once SIGTERM/SIGINT handling has started. */
export const isShuttingDown = () => shuttingDown;

/**
 * Flag the process as shutting down. Socket disconnect handlers check this so a
 * server-side close is not mistaken for users dropping off (no 15s call-end grace,
 * no host-disconnect timers); loops stop claiming leadership.
 */
export const beginShutdown = () => {
    shuttingDown = true;
};

/** Register a cleanup step; hooks run in reverse registration order. */
export const onShutdown = (name, fn) => {
    shutdownHooks.push({ name, fn });
};

export const runShutdownHooks = async () => {
    shuttingDown = true;
    for (const { name, fn } of [...shutdownHooks].reverse()) {
        try {
            await fn();
        } catch (err) {
            console.error(`[Shutdown] hook ${name} failed:`, err.message);
        }
    }
};

// ---------------------------------------------------------------------------
// L5: leader lock
// ---------------------------------------------------------------------------

const LEADER_TTL_MS = Number(process.env.LIVE_LEADER_TTL_MS || 15000);
const leaderKey = (name) => `live:leader:${name}`;
const heldLocks = new Set();

// Renew only if we still own the lock (atomic compare-and-pexpire).
const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

const lastLeaderState = new Map();

/**
 * True when this node holds (or just acquired/renewed) the lock for `name`.
 * Call once per loop tick. Redis down -> true (single-node fallback).
 */
export const isLeader = async (name) => {
    if (shuttingDown) return false;
    if (!redisClient.isOpen) return true;
    const key = leaderKey(name);
    let leader = false;
    try {
        const got = await redisClient.set(key, NODE_ID, { NX: true, PX: LEADER_TTL_MS });
        if (got === 'OK') {
            leader = true;
        } else {
            const renewed = await redisClient.eval(RENEW_LUA, {
                keys: [key],
                arguments: [NODE_ID, String(LEADER_TTL_MS)]
            });
            leader = Number(renewed) === 1;
        }
    } catch (err) {
        console.error(`[Leader] ${name} check failed, running locally:`, err.message);
        return true;
    }
    if (leader) heldLocks.add(name);
    else heldLocks.delete(name);
    if (lastLeaderState.get(name) !== leader) {
        lastLeaderState.set(name, leader);
        console.log(`[Leader] ${name}: ${leader ? 'acquired' : 'standby'} on ${NODE_ID}`);
    }
    return leader;
};

/** Run `fn` only on the leader for `name`. Returns fn's result, or undefined when skipped. */
export const runAsLeader = async (name, fn) => {
    if (!(await isLeader(name))) return undefined;
    return fn();
};

/** Release every lock this node holds so a peer takes over at once. */
export const releaseLeaderLocks = async () => {
    if (!redisClient.isOpen) return;
    for (const name of heldLocks) {
        try {
            await redisClient.eval(RELEASE_LUA, { keys: [leaderKey(name)], arguments: [NODE_ID] });
        } catch {
            // expires on its own
        }
    }
    heldLocks.clear();
};

// ---------------------------------------------------------------------------
// L4: durable timers
// ---------------------------------------------------------------------------

const DEADLINES_KEY = 'live:deadlines';
const PAYLOAD_KEY = 'live:deadlines:payload';
/** The sweeper leaves a deadline this long for the scheduling node's own setTimeout. */
const SWEEP_GRACE_MS = 1500;
const SWEEP_INTERVAL_MS = 2000;

const handlers = new Map();
const localTimers = new Map();
const memberOf = (kind, key) => `${kind}|${key}`;

/**
 * Register the handler for a timer kind. Handlers must be idempotent and re-check
 * state (status, balance, pending flags): a deadline can fire after a restart.
 * @param {string} kind
 * @param {(key: string, payload: object|null) => Promise<void>} fn
 */
export const registerDurableHandler = (kind, fn) => {
    handlers.set(kind, fn);
};

const runHandler = async (member, payload) => {
    const sep = member.indexOf('|');
    const kind = member.slice(0, sep);
    const key = member.slice(sep + 1);
    const fn = handlers.get(kind);
    if (!fn) {
        console.error(`[DurableTimer] no handler for ${kind} (${key}); dropped`);
        return;
    }
    try {
        await fn(key, payload);
    } catch (err) {
        console.error(`[DurableTimer] ${kind} ${key} handler failed:`, err.message);
    }
};

/**
 * Claim a deadline exactly once across nodes (ZREM returns 1 for one caller only),
 * then run its handler. Redis down -> run with the local payload.
 */
const fire = async (member, localPayload, persisted = true) => {
    localTimers.delete(member);
    if (!persisted || !redisClient.isOpen) {
        await runHandler(member, localPayload ?? null);
        return;
    }
    let payload = localPayload ?? null;
    try {
        const removed = await redisClient.zRem(DEADLINES_KEY, member);
        if (Number(removed) !== 1) return; // cancelled, or another node fired it
        const raw = await redisClient.hGet(PAYLOAD_KEY, member);
        await redisClient.hDel(PAYLOAD_KEY, member);
        if (raw) payload = JSON.parse(raw);
    } catch (err) {
        console.error(`[DurableTimer] claim ${member} failed:`, err.message);
        return;
    }
    await runHandler(member, payload);
};

/**
 * Schedule (or reschedule) a deadline.
 * @param {string} kind     handler name (registerDurableHandler)
 * @param {string} key      unique id within the kind (e.g. sessionId)
 * @param {number} atMs     epoch ms when it is due
 * @param {object} [payload] small JSON-serialisable context for the handler
 */
export const scheduleDurable = async (kind, key, atMs, payload = null) => {
    const member = memberOf(kind, key);
    const existing = localTimers.get(member);
    if (existing) clearTimeout(existing);

    let persisted = false;
    if (redisClient.isOpen) {
        try {
            await redisClient
                .multi()
                .zAdd(DEADLINES_KEY, { score: atMs, value: member })
                .hSet(PAYLOAD_KEY, member, JSON.stringify(payload))
                .exec();
            persisted = true;
        } catch (err) {
            console.error(`[DurableTimer] persist ${member} failed (local timer only):`, err.message);
        }
    }

    const delay = Math.max(0, atMs - Date.now());
    const handle = setTimeout(() => {
        fire(member, payload, persisted).catch(() => { });
    }, delay);
    localTimers.set(member, handle);
};

/** Cancel a deadline on this node and in Redis. */
export const cancelDurable = async (kind, key) => {
    const member = memberOf(kind, key);
    const handle = localTimers.get(member);
    if (handle) {
        clearTimeout(handle);
        localTimers.delete(member);
    }
    if (!redisClient.isOpen) return;
    try {
        await redisClient.multi().zRem(DEADLINES_KEY, member).hDel(PAYLOAD_KEY, member).exec();
    } catch (err) {
        console.error(`[DurableTimer] cancel ${member} failed:`, err.message);
    }
};

/** True when a deadline is pending on any node. */
export const hasDurable = async (kind, key) => {
    const member = memberOf(kind, key);
    if (localTimers.has(member)) return true;
    if (!redisClient.isOpen) return false;
    try {
        return (await redisClient.zScore(DEADLINES_KEY, member)) !== null;
    } catch {
        return false;
    }
};

let sweeper = null;

/**
 * Leader-only sweep: fires deadlines whose scheduling node died or restarted.
 * Idempotent; call once at startup.
 */
export const startDurableTimerSweeper = () => {
    if (sweeper) return;
    sweeper = setInterval(() => {
        runAsLeader('durable-timers', async () => {
            if (!redisClient.isOpen) return;
            const due = await redisClient.zRangeByScore(DEADLINES_KEY, '-inf', Date.now() - SWEEP_GRACE_MS, {
                LIMIT: { offset: 0, count: 100 }
            });
            for (const member of due) {
                if (localTimers.has(member)) continue; // our own timer is about to fire
                console.log(`[DurableTimer] sweeping overdue ${member}`);
                await fire(member, null);
            }
        }).catch((err) => console.error('[DurableTimer] sweep failed:', err.message));
    }, SWEEP_INTERVAL_MS);
    sweeper.unref?.();
    onShutdown('durable-timer-sweeper', () => {
        clearInterval(sweeper);
        sweeper = null;
        // Local handles die with the process; the deadlines stay in Redis for a peer.
        for (const h of localTimers.values()) clearTimeout(h);
        localTimers.clear();
    });
};
