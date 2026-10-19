export * from "./schema";
export { createDb, pingDb, assertAppRole, type Db, type DbHandle } from "./client";
export { lockWorkspace, withWorkspace, type WorkspaceTx } from "./workspace";
export * from "./ids";
export { runMigrations, ensureDevRoles } from "./migrate";
export {
  audit,
  listAudit,
  getAuditEntry,
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
export {
  TASK_STATUSES,
  TaskInputSchema,
  TaskPatchSchema,
  listTasks,
  listOpenTasks,
  getTasksByIds,
  getTask,
  createTask,
  updateTask,
  softDeleteTask,
  replaceDependencies,
  applyTaskRisks,
  type TaskStatus,
  type TaskRisk,
  type TaskInput,
  type TaskPatch,
  type TaskView,
  type TaskFilters,
} from "./repos/tasks";
export {
  createProposal,
  getProposal,
  listProposals,
  resolveProposal,
  expirePending,
  countPending,
  type ProposalKind,
  type ProposalStatus,
  type ProposalView,
  type NewProposal,
} from "./repos/proposals";
export {
  getIdempotentResponse,
  storeIdempotentResponse,
  reserveIdempotencyKey,
  finalizeIdempotencyKey,
  releaseIdempotencyKey,
  type StoredResponse,
} from "./repos/idempotency";
export { listClients, projectExists, type ClientSummary } from "./repos/clients";
export * from "./repos/integrations";
export * from "./repos/schedule";
export * from "./repos/notifications";
export * from "./repos/plan-runs";
export * from "./repos/threads";
export * from "./repos/commitments";
export * from "./repos/contacts";
export * from "./repos/ai-usage";
