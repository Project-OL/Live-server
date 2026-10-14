import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeOf, mergeShapes, compareShapes } from "./shape.mjs";

test("records types only, never values", () => {
    const s = JSON.stringify(shapeOf({ token: "secret-value", n: 5, list: [{ id: "x" }] }));
    assert.ok(!s.includes("secret-value"));
    assert.ok(!s.includes('"x"'));
});

test("additive changes pass (new key, extra nullable)", () => {
    const rec = shapeOf({ success: true, data: { id: "a", name: "n" } });
    const now = shapeOf({ success: true, data: { id: "b", name: null, publicId: "1" } });
    assert.deepEqual(compareShapes(rec, now), []);
});

test("a removed key is reported", () => {
    const rec = shapeOf({ data: { id: "a", streamId: "s" } });
    const now = shapeOf({ data: { id: "a" } });
    assert.deepEqual(compareShapes(rec, now), ["$.data.streamId: missing (was string)"]);
});

test("a type change is reported", () => {
    const rec = shapeOf({ balance: 10 });
    const now = shapeOf({ balance: "10" });
    assert.deepEqual(compareShapes(rec, now), ["$.balance: type number -> string"]);
});

test("keys present in only some array items are optional", () => {
    const rec = shapeOf({ items: [{ id: 1, ride: { name: "r" } }, { id: 2 }] });
    const now = shapeOf({ items: [{ id: 3 }] });
    assert.deepEqual(compareShapes(rec, now), []);
    const broken = shapeOf({ items: [{ ride: null }] });
    assert.deepEqual(compareShapes(rec, broken), ["$.items[].id: missing (was number)"]);
});

test("merging two samples unions their types", () => {
    const m = mergeShapes(shapeOf({ a: 1 }), shapeOf({ a: null }));
    assert.deepEqual(m.props.a.types, ["null", "number"]);
});
