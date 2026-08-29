/**
 * Declarative environment-variable overrides for pi extension configs.
 *
 * Single source of truth for the env-var surface, shared by:
 *  - ConfigManager (config-manager.ts) — modal + programmatic paths
 *  - Any runtime loader that wants the same env-override semantics
 *
 * Field types are inferred from the defaults object:
 *   - boolean → readBooleanEnv
 *   - positive integer → readPositiveIntEnv
 *   - other number → parseFloat
 *   - custom parser → EnvParser.parse
 */

import { readBooleanEnv, readPositiveIntEnv } from "../config.js";

export interface EnvParser {
  /** Env var name */
  var: string;
  /** Custom parse function (receives raw string, returns parsed value) */
  parse: (raw: string, current: unknown) => unknown;
}

export type EnvOverride = string | EnvParser;

/**
 * Apply env overrides onto a config object. Returns a NEW object;
 * input is not mutated.
 */
export function applyEnvOverrides<T extends object>(
  config: T,
  env: Record<string, EnvOverride>,
  defaults: Record<string, unknown>,
): T {
  const result: Record<string, unknown> = {
    ...(config as Record<string, unknown>),
  };

  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;

    const defaultValue = defaults[key];

    if (typeof value === "string") {
      if (typeof defaultValue === "boolean") {
        result[key] = readBooleanEnv(value, (result[key] as boolean) ?? (defaultValue as boolean));
      } else if (typeof defaultValue === "number") {
        if (Number.isInteger(defaultValue) && defaultValue > 0) {
          result[key] = readPositiveIntEnv(
            value,
            (result[key] as number) ?? (defaultValue as number),
          );
        } else {
          // Float — parse and preserve
          const raw = process.env[value]?.trim();
          if (raw) {
            const parsed = Number.parseFloat(raw);
            if (Number.isFinite(parsed)) {
              result[key] = parsed;
            }
          }
        }
      }
    } else {
      const raw = process.env[value.var]?.trim();
      if (raw) {
        const parsed = value.parse(raw, result[key]);
        if (parsed !== undefined) {
          result[key] = parsed;
        }
      }
    }
  }

  return result as T;
}
