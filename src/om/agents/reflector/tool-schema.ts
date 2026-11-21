/**
 * Reflector tool schema, factored out of agent.ts so the consolidation stage
 * can measure the exact serialized schema as part of the worker prompt budget
 * (src/om/prompt-budget.ts) without importing the agent loop. Single source
 * of truth: the agent builds its tool from these same objects.
 */
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { RelevanceSchema } from "../observer/tool-schema.js";

// Compose both schemas from these shared fields. Reading `.properties` back
// from a built schema throws on hosts that shim typebox (omp).
const reflectionItemFields = {
  content: Type.String({ minLength: 1 }),
  supportingObservationIds: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
  }),
  // Optional durable-importance marker (#208): a model that omits it keeps
  // the fallback support-relevance tiering, never loses the batch. The
  // vocabulary reuses the observer's relevance union so one set of values
  // governs both records and validation.
  relevance: Type.Optional(RelevanceSchema),
};

// Optional on purpose: a model that omits the flag must lose only the
// early-stop hint, never the batch itself (a required field would fail
// host-side validation and drop every reflection in the call).
const completeField = Type.Optional(
  Type.Boolean({
    description:
      "Whether this batch completes reflection review. Set false when more reflections or corrections remain.",
  }),
);

// The object skeleton is built in one place so a top-level field can never
// exist in only one of the two schemas. The item fields differ per schema:
// the supersedes variant adds its optional field after the shared ones.
function reflectorObjectFields<F extends Record<string, TSchema>>(itemFields: F) {
  return {
    reflections: Type.Array(Type.Object(itemFields), { minItems: 1 }),
    complete: completeField,
  };
}

export const RecordReflectionsSchema = Type.Object(reflectorObjectFields(reflectionItemFields));

export const RecordReflectionsWithSupersedesSchema = Type.Object(
  reflectorObjectFields({
    ...reflectionItemFields,
    supersedes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  }),
);

export type RecordReflectionsArgs = Static<typeof RecordReflectionsWithSupersedesSchema>;
