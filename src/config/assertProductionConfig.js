/**
 * LIVE-45 / SEC-13: refuse to boot in production with missing or placeholder secrets.
 *
 * Several modules fall back to LiveKit `devkey`/`secret` and JWT `fallback_secret` when a variable
 * is missing. In production that silently signs tokens with a public placeholder, so here the
 * process exits instead (pm2 shows the reason). Development and tests keep the old fallbacks.
 * Imported first by server.js, before any module reads the variables.
 */
import dotenv from "dotenv";

dotenv.config();

const PLACEHOLDERS = new Set(["", "devkey", "secret", "fallback_secret", "changeme", "change-me"]);

export const productionConfigProblems = (env = process.env) => {
    const problems = [];
    const need = (name, value) => {
        const v = value === undefined || value === null ? "" : String(value).trim();
        if (PLACEHOLDERS.has(v)) problems.push(`${name} is ${v ? "a placeholder" : "missing"}`);
    };
    need("LIVEKIT_API_KEY", env.LIVEKIT_API_KEY);
    need("LIVEKIT_API_SECRET", env.LIVEKIT_API_SECRET);
    need("JWT_ACCESS_SECRET (or JWT_SECRET / JWT_SECRET_KEY)", env.JWT_ACCESS_SECRET || env.JWT_SECRET || env.JWT_SECRET_KEY);
    need("DATABASE_URL", env.DATABASE_URL);
    need("REDIS_URL", env.REDIS_URL);
    // BE-20: every coin/point write goes through ol-node-rest's signed internal ledger API since
    // Live-server's local money code was retired (2026-10-21); without the key every send would fail.
    need("INTERNAL_LEDGER_HMAC_SECRET", env.INTERNAL_LEDGER_HMAC_SECRET);
    return problems;
};

if (process.env.NODE_ENV === "production") {
    const problems = productionConfigProblems();
    if (problems.length) {
        console.error(`[Config] FATAL: refusing to start in production: ${problems.join("; ")}`);
        process.exit(1);
    }
}
