/**
 * Built-in field renderers. The modal's `RENDERERS` lookup is
 * constructed from these so user-supplied `type: "custom"` fields can
 * coexist with built-ins without any registration ceremony.
 */

import type { Field, FieldRenderer } from "../types";
import { actionRenderer } from "./action";
import { booleanRenderer } from "./boolean";
import { customRenderer } from "./custom";
import { enumRenderer } from "./enum";
import { modelRenderer } from "./model";
import { numberRenderer, pathRenderer, secretRenderer, stringRenderer } from "./string";
import { readonlyRenderer } from "./readonly";
import { textRenderer } from "./text";

export {
  actionRenderer,
  booleanRenderer,
  customRenderer,
  enumRenderer,
  modelRenderer,
  numberRenderer,
  pathRenderer,
  readonlyRenderer,
  secretRenderer,
  stringRenderer,
  textRenderer,
};

/** Map of field discriminator → renderer. */

type RenderableField = Exclude<Field, { type: "section" }>;
export const RENDERERS: Record<RenderableField["type"], FieldRenderer<any, any>> = {
  boolean: booleanRenderer,
  enum: enumRenderer,
  string: stringRenderer,
  number: numberRenderer,
  secret: secretRenderer,
  path: pathRenderer,
  text: textRenderer,
  action: actionRenderer,
  model: modelRenderer,
  custom: customRenderer,
  readonly: readonlyRenderer,
};
