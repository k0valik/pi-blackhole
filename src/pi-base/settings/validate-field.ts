/**
 * Field value validation utilities.
 *
 * Each `validateFieldValue` call checks a single value against the
 * field's type-specific constraints (enum membership, boolean type,
 * string no-newlines, number range / integer / values / step) and
 * returns either `undefined` (valid) or a warning message string.
 *
 * The primary consumer is the settings modal (body.ts), which shows
 * per-field warnings in the focused-row description area. Callers
 * can also use this in ConfigManager to skip invalid values during
 * save, or to repair loaded configs.
 */

import type { Field } from "./types";

/**
 * Validate a field value against the field's type-specific constraints.
 *
 * @param field - The field definition
 * @param value - The value to validate
 * @returns A warning message if invalid, `undefined` if valid
 */
export function validateFieldValue(field: Field, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;

  switch (field.type) {
    case "enum": {
      if (typeof value !== "string") return `Must be a string, got ${typeof value}`;
      if (!field.options.includes(value as never))
        return `Must be one of: ${field.options.join(", ")}`;
      return undefined;
    }

    case "boolean": {
      if (typeof value !== "boolean") return `Must be a boolean, got ${typeof value}`;
      return undefined;
    }

    case "string": {
      if (typeof value !== "string") return `Must be a string, got ${typeof value}`;
      if (value.includes("\n") || value.includes("\r"))
        return "Must be a single-line string (no newlines)";
      return undefined;
    }

    case "text": {
      if (typeof value !== "string") return `Must be a string, got ${typeof value}`;
      return undefined;
    }

    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value))
        return `Must be a finite number, got ${typeof value === "number" ? String(value) : typeof value}`;
      if (field.integer && !Number.isInteger(value)) return "Must be an integer";
      if (field.values !== undefined && field.values.length > 0) {
        if (!field.values.includes(value)) return `Must be one of: ${field.values.join(", ")}`;
      }
      if (typeof field.min === "number" && value < field.min)
        return `Must be at least ${field.min}`;
      if (typeof field.max === "number" && value > field.max) return `Must be at most ${field.max}`;
      if (field.step !== undefined && field.step > 0) {
        // Check alignment to step within floating-point tolerance
        const min = field.min ?? 0;
        const offset = value - min;
        const rem = offset % field.step;
        if (rem > 1e-9 && field.step - rem > 1e-9) {
          return `Must be aligned to step ${field.step}`;
        }
      }
      return undefined;
    }

    case "secret": {
      if (typeof value !== "string") return `Must be a string, got ${typeof value}`;
      return undefined;
    }

    case "path": {
      if (typeof value !== "string") return `Must be a string, got ${typeof value}`;
      return undefined;
    }

    case "model": {
      if (typeof value !== "object" || value === null)
        return `Must be an object with id, got ${typeof value}`;
      const v = value as { id?: unknown };
      if (typeof v.id !== "string") return `Must have a string id, got ${typeof v.id}`;
      return undefined;
    }

    case "action":
    case "custom":
      // Custom types can't be validated generically
      return undefined;

    default:
      return undefined;
  }
}
