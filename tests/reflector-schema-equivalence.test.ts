/**
 * Differential check: the composed reflector schemas must be structurally and
 * behaviorally identical to the pre-fix `.properties` read-back formulation,
 * under the real typebox installed here.
 *
 * The "old" schemas below are reconstructed locally from the same builder
 * primitives the old code used; they are a test oracle, not a revert. The
 * supersedes-off golden fixture covers the off schema, but nothing pinned the
 * on schema before this file.
 */
import { describe, expect, test } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  RecordReflectionsSchema,
  RecordReflectionsWithSupersedesSchema,
} from "../src/om/agents/reflector/tool-schema.js";
import { RelevanceSchema } from "../src/om/agents/observer/tool-schema.js";

const COMPLETE_DESCRIPTION =
  "Whether this batch completes reflection review. Set false when more reflections or corrections remain.";

const oldBaseSchema = Type.Object({
  reflections: Type.Array(
    Type.Object({
      content: Type.String({ minLength: 1 }),
      supportingObservationIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      // Optional relevance marker (#208): mirrors the live schema field.
      relevance: Type.Optional(RelevanceSchema),
    }),
    { minItems: 1 },
  ),
  complete: Type.Optional(Type.Boolean({ description: COMPLETE_DESCRIPTION })),
});

const oldOnSchema = Type.Object({
  ...oldBaseSchema.properties,
  reflections: Type.Array(
    Type.Object({
      ...oldBaseSchema.properties.reflections.items.properties,
      supersedes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    }),
    { minItems: 1 },
  ),
});

interface DescriptorTree {
  [key: string]: unknown;
}

/** Own-property descriptors recursively, so non-enumerable `~kind`/`~optional`
 * markers and property order are part of the comparison, not just JSON. */
function descriptorTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(descriptorTree);
  if (value === null || typeof value !== "object") return value;
  const out: DescriptorTree = {
    __keys: Reflect.ownKeys(value).map(String),
  };
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) throw new Error(`missing descriptor for ${String(key)}`);
    out[String(key)] = {
      enumerable: descriptor.enumerable,
      writable: descriptor.writable,
      configurable: descriptor.configurable,
      value: descriptorTree(descriptor.value),
    };
  }
  return out;
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: "durable fact",
    supportingObservationIds: ["aaaaaaaaaaaa"],
    ...overrides,
  };
}

const inputs: Array<{ name: string; value: unknown }> = [
  { name: "minimal item", value: { reflections: [item()] } },
  { name: "complete true", value: { reflections: [item()], complete: true } },
  { name: "complete false", value: { reflections: [item()], complete: false } },
  { name: "supersedes absent", value: { reflections: [item()] } },
  { name: "supersedes empty", value: { reflections: [item({ supersedes: [] })] } },
  {
    name: "supersedes one id",
    value: { reflections: [item({ supersedes: ["bbbbbbbbbbbb"] })] },
  },
  {
    name: "supersedes two ids",
    value: { reflections: [item({ supersedes: ["bbbbbbbbbbbb", "cccccccccccc"] })] },
  },
  { name: "supersedes empty string", value: { reflections: [item({ supersedes: [""] })] } },
  { name: "supersedes wrong type", value: { reflections: [item({ supersedes: "bbbbbbbbbbbb" })] } },
  { name: "supersedes numeric id", value: { reflections: [item({ supersedes: [7] })] } },
  { name: "empty reflections", value: { reflections: [] } },
  { name: "missing reflections", value: {} },
  { name: "empty content", value: { reflections: [item({ content: "" })] } },
  { name: "empty support ids", value: { reflections: [item({ supportingObservationIds: [] })] } },
  {
    name: "empty support id string",
    value: { reflections: [item({ supportingObservationIds: [""] })] },
  },
  { name: "extra top-level property", value: { reflections: [item()], extra: 1 } },
  { name: "extra item property", value: { reflections: [item({ extra: 1 })] } },
  { name: "complete wrong type", value: { reflections: [item()], complete: "yes" } },
];

describe("composed reflector schemas match the old formulation", () => {
  test("supersedes-off schema is descriptor-identical", () => {
    expect(descriptorTree(RecordReflectionsSchema)).toEqual(descriptorTree(oldBaseSchema));
  });

  test("supersedes-on schema is descriptor-identical", () => {
    expect(descriptorTree(RecordReflectionsWithSupersedesSchema)).toEqual(
      descriptorTree(oldOnSchema),
    );
  });

  test("supersedes-on schema serializes identically", () => {
    expect(JSON.stringify(RecordReflectionsWithSupersedesSchema)).toBe(JSON.stringify(oldOnSchema));
  });

  test.each(inputs)("Value.Check parity: $name", ({ value }) => {
    expect(Value.Check(RecordReflectionsSchema, value)).toBe(Value.Check(oldBaseSchema, value));
    expect(Value.Check(RecordReflectionsWithSupersedesSchema, value)).toBe(
      Value.Check(oldOnSchema, value),
    );
  });

  test("shared-field reuse keeps the same identity relations as before", () => {
    expect(
      Object.is(
        RecordReflectionsSchema.properties.complete,
        RecordReflectionsWithSupersedesSchema.properties.complete,
      ),
    ).toBe(Object.is(oldBaseSchema.properties.complete, oldOnSchema.properties.complete));
    expect(
      Object.is(
        RecordReflectionsSchema.properties.reflections.items.properties.content,
        RecordReflectionsWithSupersedesSchema.properties.reflections.items.properties.content,
      ),
    ).toBe(
      Object.is(
        oldBaseSchema.properties.reflections.items.properties.content,
        oldOnSchema.properties.reflections.items.properties.content,
      ),
    );
  });

  test("the two exported schemas do not share their reflections array node", () => {
    expect(RecordReflectionsSchema.properties.reflections).not.toBe(
      RecordReflectionsWithSupersedesSchema.properties.reflections,
    );
  });

  test("the base schema has no supersedes and no mutation leaked from the on schema", () => {
    expect(RecordReflectionsSchema.properties.reflections.items.properties).not.toHaveProperty(
      "supersedes",
    );
    expect(descriptorTree(RecordReflectionsSchema)).toEqual(descriptorTree(oldBaseSchema));
  });

  // The shared builder owns the top-level shape. These pin the built output so
  // a schema that stops using it, or diverges on item fields, fails here.
  test("both schemas expose the same top-level fields", () => {
    expect(Object.keys(RecordReflectionsWithSupersedesSchema.properties)).toEqual(
      Object.keys(RecordReflectionsSchema.properties),
    );
  });

  test("the supersedes item is exactly the base item plus supersedes", () => {
    expect(
      Object.keys(RecordReflectionsWithSupersedesSchema.properties.reflections.items.properties),
    ).toEqual([
      ...Object.keys(RecordReflectionsSchema.properties.reflections.items.properties),
      "supersedes",
    ]);
  });
});
