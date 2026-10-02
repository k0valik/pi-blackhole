/**
 * Dropper tool schema, factored out of agent.ts so the consolidation stage
 * can measure the exact serialized schema as part of the worker prompt budget
 * (src/om/prompt-budget.ts) without importing the agent loop. Single source
 * of truth: the agent builds its tool from these same objects.
 */
import { Type } from "typebox";
import type { Static } from "typebox";

export const DropObservationsSchema = Type.Object({
  ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  reason: Type.Optional(Type.String()),
});

export type DropObservationsArgs = Static<typeof DropObservationsSchema>;
