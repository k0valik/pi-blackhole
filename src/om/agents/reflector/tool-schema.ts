/**
 * Reflector tool schema, factored out of agent.ts so the consolidation stage
 * can measure the exact serialized schema as part of the worker prompt budget
 * (src/om/prompt-budget.ts) without importing the agent loop. Single source
 * of truth: the agent builds its tool from these same objects.
 */
import { Type } from "typebox";
import type { Static } from "typebox";

export const RecordReflectionsSchema = Type.Object({
  reflections: Type.Array(
    Type.Object({
      content: Type.String({ minLength: 1 }),
      supportingObservationIds: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
      }),
    }),
    { minItems: 1 },
  ),
  // Optional on purpose: a model that omits the flag must lose only the
  // early-stop hint, never the batch itself (a required field would fail
  // host-side validation and drop every reflection in the call).
  complete: Type.Optional(
    Type.Boolean({
      description:
        "Whether this batch completes reflection review. Set false when more reflections or corrections remain.",
    }),
  ),
});

export type RecordReflectionsArgs = Static<typeof RecordReflectionsSchema>;
