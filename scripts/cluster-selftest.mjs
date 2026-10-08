// LIVE-09 multi-node self-test. Run from the Live-server root with REDIS_URL set (a
// non-production Redis; it writes selftest-* keys and cleans up after itself).
//   node scripts/cluster-selftest.mjs adapter        two socket.io servers, cross-node emit
//   node scripts/cluster-selftest.mjs leader <name>  print whether this process leads <name>
//   node scripts/cluster-selftest.mjs schedule <key> schedule a selftest deadline, then exit hard
//   node scripts/cluster-selftest.mjs sweep <key>    run the sweeper until <key> fires (or 12s)
import http from 'http';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { createAdapter } from '@socket.io/redis-adapter';
import { client as redis } from '../src/config/redis.js';

const mode = process.argv[2];
await redis.connect();
const cluster = await import('../src/services/cluster.service.js');

const done = async (code) => {
    await redis.quit().catch(() => {});
    process.exit(code);
};

if (mode === 'adapter') {
    const mk = async (port) => {
        const httpServer = http.createServer();
        const io = new Server(httpServer);
        const pub = redis.duplicate();
        const sub = redis.duplicate();
        await Promise.all([pub.connect(), sub.connect()]);
        io.adapter(createAdapter(pub, sub));
        await new Promise((r) => httpServer.listen(port, r));
        return { io, httpServer, pub, sub };
    };
    const A = await mk(15001);
    const B = await mk(15002);
    const room = `selftest-room-${Date.now()}`;
    let joinedId = null;
    A.io.on('connection', (s) => {
        s.join(room);
        joinedId = s.id;
    });
    const c = ioClient('http://127.0.0.1:15001', { transports: ['websocket'] });
    const got = [];
    c.on('to-room', (d) => got.push(['room', d]));
    c.on('to-socket', (d) => got.push(['socket', d]));
    await new Promise((r) => c.on('connect', r));
    await new Promise((r) => setTimeout(r, 300));
    B.io.to(room).emit('to-room', 'from-B');
    B.io.to(joinedId).emit('to-socket', 'from-B');
    const remote = await B.io.in(room).fetchSockets();
    await new Promise((r) => setTimeout(r, 800));
    console.log('client on A received:', JSON.stringify(got));
    console.log('B.fetchSockets(room) sees', remote.length, 'socket(s)');
    const ok = got.length === 2 && remote.length === 1;
    console.log(ok ? 'ADAPTER_OK' : 'ADAPTER_FAIL');
    c.close();
    for (const n of [A, B]) {
        n.io.close();
        await Promise.allSettled([n.pub.quit(), n.sub.quit()]);
    }
    await done(ok ? 0 : 1);
} else if (mode === 'leader') {
    const name = process.argv[3];
    const a = await cluster.isLeader(name);
    console.log(`LEADER ${name} ${cluster.NODE_ID} -> ${a}`);
    if (process.argv[4] === 'release') await cluster.releaseLeaderLocks();
    await done(0);
} else if (mode === 'schedule') {
    const key = process.argv[3];
    cluster.registerDurableHandler('selftest', async () => console.log('WRONG: fired in scheduling process'));
    await cluster.scheduleDurable('selftest', key, Date.now() + 1500, { from: cluster.NODE_ID });
    console.log(`SCHEDULED selftest|${key} for +1.5s; exiting before it fires`);
    process.exit(0); // hard exit: the local setTimeout dies with us
} else if (mode === 'sweep') {
    const key = process.argv[3];
    const t0 = Date.now();
    cluster.registerDurableHandler('selftest', async (k, payload) => {
        console.log(`FIRED selftest|${k} after ${Date.now() - t0}ms in ${cluster.NODE_ID}, payload=${JSON.stringify(payload)}`);
        if (k === key) {
            console.log('SWEEP_OK');
            await done(0);
        }
    });
    cluster.startDurableTimerSweeper();
    setTimeout(async () => {
        console.log('SWEEP_FAIL (timeout)');
        await redis.zRem('live:deadlines', `selftest|${key}`).catch(() => {});
        await redis.hDel('live:deadlines:payload', `selftest|${key}`).catch(() => {});
        await done(1);
    }, 12000);
}
