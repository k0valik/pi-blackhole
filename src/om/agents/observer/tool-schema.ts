/**
 * Observer tool schema, factored out of agent.ts so the consolidation stage
 * can measure the exact serialized schema as part of the worker prompt budget
 * (src/om/prompt-budget.ts) without importing the agent loop. Single source
 * of truth: the agent builds its tool from these same objects.
 */
import { Type } from "typebox";
import type { Static } from "typebox";

const RelevanceSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("critical"),
]);

export const OBSERVATION_TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$";

export const RecordObservationsSchema = Type.Object({
  observations: Type.Array(
    Type.Object({
      content: Type.String({
        minLength: 1,
        description: "Single-line plain prose. No markdown, no tags, no embedded timestamp.",
      }),
      relevance: RelevanceSchema,
      sourceEntryIds: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description:
          "Exact source entry ids from the chunk that directly support this observation. " +
          "Use only ids shown in '[Source entry id: ...]' labels; never invent ids.",
      }),
    }),
    {
      // The empty batch is the only sanctioned way to close a chunk that yielded
      // nothing, so it is paired with the flag. The previous wording also offered
      // "if the tool is not called at all", which is both self-contradictory (an
      // uncalled tool has no array) and points at the plain-text path the observer
      // stage reports as a tool_not_called warning.
      description:
        "Batch of new observations. May be empty only alongside complete=true, " +
        "which closes a run that found nothing new.",
    },
  ),
  // Optional on purpose: a model that omits the flag must lose only the
  // early-stop hint, never the batch itself (a required field would fail
  // host-side validation and drop every observation in the call).
  complete: Type.Optional(
    Type.Boolean({
      description:
        "Whether this batch completes chunk coverage. Set false when more observations or corrections remain.",
    }),
  ),
});

export type RecordObservationsArgs = Static<typeof RecordObservationsSchema>;
