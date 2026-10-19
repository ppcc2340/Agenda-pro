export * from "./schema";
export { createDb, pingDb, assertAppRole, type Db, type DbHandle } from "./client";
export { withWorkspace, type WorkspaceTx } from "./workspace";
export * from "./ids";
export { runMigrations, ensureDevRoles } from "./migrate";
export {
  audit,
  listAudit,
  type AuditContext,
  type AuditEntry,
  type AuditEntryInput,
  type AuditPage,
} from "./repos/audit";
export {
  PreferencesSchema,
  PreferencesPatchSchema,
  getPreferences,
  updatePreferences,
  PreferencesValidationError,
  type Preferences,
  type PreferencesPatch,
  type PreferencesView,
  type UpdatePreferencesOptions,
} from "./repos/preferences";
export {
  bootstrapAccount,
  getMe,
  type AccountIdentity,
  type BootstrapInput,
  type MeView,
} from "./repos/accounts";
