import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseSchema, compareSchemas } from "./check-schema-drift.mjs";

const REF = `
model User {
  id        String   @id
  nickName  String?  @map("nick_name")
  coins     BigInt   @default(0)
  role      Role
  tags      String[]
  wallet    Wallet?  @relation(fields: [id], references: [id])
  @@map("users")
}
enum Role {
  USER
  ADMIN
  @@map("user_role")
}
model Extra { id Int @id }
`;

test("identical subset passes; reference-only models and relation fields are ignored", () => {
    const live = `
model User {
  id       String  @id
  nickName String? @map("nick_name")
  coins    BigInt
  role     Role
  tags     String[]
  @@map("users")
}
enum Role {
  USER
  @@map("user_role")
}`;
    const { errors, warnings } = compareSchemas(parseSchema(live), parseSchema(REF));
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
});

test("missing table, missing column, type, list, nullability and enum drift are errors", () => {
    const live = `
model User {
  id       String @id
  nickName String @map("nick_name")
  coins    Int
  gone     String
  role     Role
  tags     String
  @@map("users")
}
model Phantom {
  id String @id
}
enum Role {
  USER
  OWNER
  @@map("user_role")
}`;
    const { errors } = compareSchemas(parseSchema(live), parseSchema(REF));
    const text = errors.join("\n");
    assert.match(text, /table Phantom .* missing/);
    assert.match(text, /users\.gone: column missing/);
    assert.match(text, /users\.coins: type Int here, BigInt/);
    assert.match(text, /users\.tags: list false here, true/);
    assert.match(text, /users\.nick_name: required here but nullable/);
    assert.match(text, /users\.role: enum values OWNER/);
});

test("the repo's own schema parses into tables and columns", () => {
    const own = parseSchema(fs.readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8"));
    assert.ok(own.models.size > 100);
    assert.ok([...own.models.values()].every((m) => m.fields.length > 0));
});
