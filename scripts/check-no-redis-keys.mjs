#!/usr/bin/env node
// LIVE-32: fail if any source file calls Redis KEYS (blocking, O(all keys) on the shared Redis).
// Use src/utils/redisScan.js (SCAN + UNLINK) or an epoch key instead.
import fs from "fs";
import path from "path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "src");
const offenders = [];
const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".js")) {
            fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
                if (/\b(redisClient|client|redis)\s*\.\s*keys\s*\(/i.test(line) || /\.sendCommand\(\s*\[\s*["']KEYS["']/i.test(line)) {
                    offenders.push(`${path.relative(process.cwd(), p)}:${i + 1}: ${line.trim()}`);
                }
            });
        }
    }
};
walk(root);
if (offenders.length) {
    console.error("Redis KEYS is not allowed (LIVE-32). Use src/utils/redisScan.js:\n  " + offenders.join("\n  "));
    process.exit(1);
}
console.log("OK: no Redis KEYS calls in src/");
