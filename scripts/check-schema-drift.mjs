#!/usr/bin/env node
/**
 * LIVE-51: Live-server keeps its own copy of the shared Postgres schema (prisma/schema.prisma), while
 * ol-node-rest owns the tables and their migrations. This checks that every table and column
 * Live-server declares exists in a reference schema with the same type, list-ness and nullability.
 *
 *   node scripts/check-schema-drift.mjs ../ol-node-rest/prisma/schema.prisma      # vs ol-node-rest
 *   npx prisma db pull --print > /tmp/db.prisma && node scripts/check-schema-drift.mjs /tmp/db.prisma
 *                                                                                  # vs the real DB
 * Errors (exit 1): a table or column Live-server uses is missing, or has a different base type or
 * list-ness, or Live-server says "required" where the reference allows NULL (a read would fail).
 * Warnings: Live-server optional where the reference is required (harmless), native type differs.
 * Models only the reference has are ignored: Live-server needs just a subset.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const SCALARS = new Set(["String", "Int", "BigInt", "Float", "Decimal", "Boolean", "DateTime", "Json", "Bytes"]);

export const parseSchema = (text) => {
    const enums = new Map();
    const models = new Map();
    const blockRe = /^(model|enum|view)\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
    let m;
    while ((m = blockRe.exec(text))) {
        const [, kind, name, body] = m;
        const lines = body.split("\n").map((l) => l.replace(/\/\/.*$/, "").trim()).filter(Boolean);
        if (kind === "enum") {
            const map = lines.find((l) => l.startsWith("@@map("));
            enums.set(name, {
                dbName: map ? map.match(/@@map\("([^"]+)"\)/)[1] : name,
                values: lines.filter((l) => !l.startsWith("@@")).map((l) => {
                    const vm = l.match(/^(\w+)(?:.*@map\("([^"]+)"\))?/);
                    return vm[2] || vm[1];
                })
            });
            continue;
        }
        const mapLine = lines.find((l) => l.startsWith("@@map("));
        const table = mapLine ? mapLine.match(/@@map\("([^"]+)"\)/)[1] : name;
        const fields = [];
        for (const l of lines) {
            if (l.startsWith("@@")) continue;
            const fm = l.match(/^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/);
            if (!fm) continue;
            const [, field, type, list, opt, attrs] = fm;
            if (/@relation\b/.test(attrs) || (!SCALARS.has(type) && !text.match(new RegExp(`^enum\\s+${type}\\s*\\{`, "m")))) continue;
            const colMap = attrs.match(/@map\("([^"]+)"\)/);
            const native = attrs.match(/@db\.(\w+(?:\([^)]*\))?)/);
            fields.push({ field, column: colMap ? colMap[1] : field, type, list: Boolean(list), optional: Boolean(opt), native: native ? native[1] : null, isEnum: !SCALARS.has(type) });
        }
        models.set(table, { model: name, kind, fields });
    }
    return { models, enums };
};

export const compareSchemas = (live, ref) => {
    const errors = [];
    const warnings = [];
    for (const [table, lm] of live.models) {
        const rm = ref.models.get(table);
        if (!rm) {
            errors.push(`table ${table} (model ${lm.model}) is missing from the reference`);
            continue;
        }
        const refCols = new Map(rm.fields.map((f) => [f.column, f]));
        for (const lf of lm.fields) {
            const rf = refCols.get(lf.column);
            const where = `${table}.${lf.column}`;
            if (!rf) {
                errors.push(`${where}: column missing from the reference`);
                continue;
            }
            const lt = lf.isEnum ? `enum:${live.enums.get(lf.type)?.dbName ?? lf.type}` : lf.type;
            const rt = rf.isEnum ? `enum:${ref.enums.get(rf.type)?.dbName ?? rf.type}` : rf.type;
            if (lt !== rt) errors.push(`${where}: type ${lt} here, ${rt} in the reference`);
            if (lf.list !== rf.list) errors.push(`${where}: list ${lf.list} here, ${rf.list} in the reference`);
            if (!lf.optional && rf.optional) errors.push(`${where}: required here but nullable in the reference (a NULL row would fail to load)`);
            if (lf.optional && !rf.optional) warnings.push(`${where}: optional here, required in the reference`);
            if (lf.native && rf.native && lf.native !== rf.native) warnings.push(`${where}: @db.${lf.native} here, @db.${rf.native} in the reference`);
            if (lf.isEnum && rf.isEnum) {
                const lv = live.enums.get(lf.type)?.values ?? [];
                const rv = new Set(ref.enums.get(rf.type)?.values ?? []);
                const missing = lv.filter((v) => !rv.has(v));
                if (missing.length) errors.push(`${where}: enum values ${missing.join(", ")} not in the reference`);
            }
        }
    }
    return { errors, warnings };
};

const main = () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const refPath = process.argv[2];
    if (!refPath) {
        console.error("usage: check-schema-drift.mjs <reference schema.prisma> [--warnings]");
        process.exit(2);
    }
    const live = parseSchema(fs.readFileSync(path.join(here, "..", "prisma", "schema.prisma"), "utf8"));
    const ref = parseSchema(fs.readFileSync(refPath, "utf8"));
    const { errors, warnings } = compareSchemas(live, ref);
    if (process.argv.includes("--warnings")) for (const w of warnings) console.log(`warn  ${w}`);
    for (const e of errors) console.log(`ERROR ${e}`);
    console.log(`schema drift: ${live.models.size} Live-server tables checked, ${errors.length} errors, ${warnings.length} warnings`);
    process.exit(errors.length ? 1 : 0);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
