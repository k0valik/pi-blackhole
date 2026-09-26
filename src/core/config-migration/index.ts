/**
 * Config-file migration (plan-10).
 *
 * `steps.ts` owns the pure, ordered transforms and the in-memory applier used
 * by the runtime loader. `runner.ts` owns the atomic, two-phase, verified
 * on-disk rewrite.
 */
export {
  CONFIG_VERSION,
  STEPS,
  applyConfigMigrations,
  foldCompaction,
  projectConfig,
} from "./steps.js";
export type {
  ConfigMigration,
  MigrationResult,
  MigrationWarning,
  ProjectionResult,
} from "./steps.js";
export { atomicWrite, migrateConfigFile, migrateConfigFiles } from "./runner.js";
export type { MigrateFileDeps, MigrateFileResult } from "./runner.js";
