#!/usr/bin/env node
/**
 * One-command local setup for the money tests: start the throwaway containers and push the schema.
 *   node tests/money/setup.mjs        (then: npm run test:money)
 *   node tests/money/setup.mjs down   (stop and remove them; data is on tmpfs anyway)
 */
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const compose = "docker compose -f tests/money/docker-compose.yml";
const run = (cmd, env = {}) => execSync(cmd, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });

if (process.argv[2] === "down") {
    run(`${compose} down -v`);
} else {
    run(`${compose} up -d --wait`);
    run("npx prisma db push --skip-generate --accept-data-loss", {
        DATABASE_URL: "postgresql://money:money@127.0.0.1:55432/money_test",
    });
}
