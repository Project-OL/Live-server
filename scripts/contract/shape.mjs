/**
 * LIVE-52: JSON "shape" (types only, never values) used by the API contract snapshots.
 *
 * A shape node is { types: string[], props?: {key: node}, items?: node, optional?: true }.
 *   - types: "string" | "number" | "boolean" | "null" | "object" | "array" (union over samples)
 *   - props: object keys, merged across samples; a key absent from some samples is `optional`
 *   - items: merged shape of array elements (first 20)
 */
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export const shapeOf = (v) => {
    const t = typeOf(v);
    const node = { types: [t] };
    if (t === "object") {
        node.props = {};
        for (const [k, val] of Object.entries(v)) node.props[k] = shapeOf(val);
    } else if (t === "array") {
        const items = v.slice(0, 20).map(shapeOf);
        if (items.length) node.items = items.reduce(mergeShapes);
    }
    return node;
};

export const mergeShapes = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    const out = { types: [...new Set([...a.types, ...b.types])].sort() };
    if (a.optional || b.optional) out.optional = true;
    if (a.props || b.props) {
        out.props = {};
        const keys = new Set([...Object.keys(a.props || {}), ...Object.keys(b.props || {})]);
        for (const k of keys) {
            const pa = a.props?.[k];
            const pb = b.props?.[k];
            // A key missing from one side's object samples is optional (null samples have no props).
            const merged = mergeShapes(pa, pb);
            const aHadObject = a.types.includes("object");
            const bHadObject = b.types.includes("object");
            if ((aHadObject && !pa) || (bHadObject && !pb)) merged.optional = true;
            out.props[k] = merged;
        }
    }
    if (a.items || b.items) out.items = mergeShapes(a.items, b.items);
    return out;
};

/**
 * Compare a recorded shape with a fresh one. Additive changes (new keys, new types alongside the
 * old ones) pass. Breaking changes are reported:
 *   - a required key the app could read is gone
 *   - a value's type changed (e.g. string -> number). `null` is data-dependent, so it is ignored.
 * @returns {string[]} problems, each prefixed with the JSON path
 */
export const compareShapes = (recorded, now, path = "$") => {
    const problems = [];
    if (!recorded || !now) return problems;
    const recTypes = recorded.types.filter((t) => t !== "null");
    const nowTypes = now.types.filter((t) => t !== "null");
    if (recTypes.length && nowTypes.length && !recTypes.some((t) => nowTypes.includes(t))) {
        problems.push(`${path}: type ${recTypes.join("|")} -> ${nowTypes.join("|")}`);
        return problems;
    }
    if (recorded.props && now.types.includes("object")) {
        for (const [k, rec] of Object.entries(recorded.props)) {
            const cur = now.props?.[k];
            if (!cur) {
                if (!rec.optional) problems.push(`${path}.${k}: missing (was ${rec.types.join("|")})`);
                continue;
            }
            problems.push(...compareShapes(rec, cur, `${path}.${k}`));
        }
    }
    if (recorded.items && now.items) problems.push(...compareShapes(recorded.items, now.items, `${path}[]`));
    return problems;
};
