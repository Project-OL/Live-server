#!/usr/bin/env node
/**
 * Guard: `wallet:coins:{userId}` and `wallet:points:{userId}` are shared with
 * ol-node-rest and are CACHES ONLY. A service that decides affordability from
 * them double-spends against the peer service - see
 * src/services/walletBalance.service.js for the full explanation.
 *
 * Every read and write of those keys must go through walletBalance.service.js,
 * whose API makes the cache-only contract explicit. This script fails the build
 * if the literal key prefix appears anywhere else under src/.
 *
 * Run: npm run check:wallet-cache
 */

import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..", "src");
const ALLOWED = new Set([path.join(ROOT, "services", "walletBalance.service.js")]);
const PATTERN = /wallet:(coins|points):/;

const offenders = [];

const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules") continue;
            walk(full);
            continue;
        }
        if (!entry.name.endsWith(".js")) continue;
        if (ALLOWED.has(full)) continue;

        const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
        lines.forEach((line, i) => {
            if (PATTERN.test(line)) {
                offenders.push(`${path.relative(path.join(ROOT, ".."), full)}:${i + 1}: ${line.trim()}`);
            }
        });
    }
};

walk(ROOT);

if (offenders.length > 0) {
    console.error(
        "\nWallet balance cache keys used outside src/services/walletBalance.service.js:\n"
    );
    for (const o of offenders) console.error(`  ${o}`);
    console.error(
        [
            "",
            "These keys are shared with ol-node-rest and are a post-commit cache only.",
            "Use the walletBalance.service.js helpers instead:",
            "  - decide affordability with getCoinBalanceInTx(tx, walletId) under lockWalletsForUpdate",
            "  - refresh the cache with writeCoinBalanceCache / writePointBalanceCache after commit",
            "  - read for display with readCoinBalanceCacheForDisplay",
            ""
        ].join("\n")
    );
    process.exit(1);
}

console.log("OK: wallet balance cache keys are confined to walletBalance.service.js");
