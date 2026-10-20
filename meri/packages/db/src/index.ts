export * from "./schema";
export { createDb, pingDb, assertAppRole, type Db, type DbHandle } from "./client";
export { lockWorkspace, withWorkspace, ADMIN_WORKSPACE_CONTEXT, type WorkspaceTx } from "./workspace";
export * from "./ids";
export { runMigrations, ensureDevRoles } from "./migrate";
export {
  audit,
  auditActionExists,
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
  getEntitlementRetentionDays,
  getEntitlementMaxClients,
  hardDeleteAccountByEmail,
  isAccountActive,
  softDeleteAccount,
  AccountDeletedError,
  type SoftDeleteResult,
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
  listTasksForReview,
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
  reopenProposal,
  createProposalIfAbsent,
  expirePending,
  expireProposalsForThreads,
  proposalHashExists,
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
export * from "./repos/clients";
export * from "./repos/integrations";
export * from "./repos/schedule";
export * from "./repos/notifications";
export * from "./repos/plan-runs";
export * from "./repos/threads";
export * from "./repos/commitments";
export * from "./repos/contacts";
export * from "./repos/ai-usage";
export * from "./repos/snapshot";
export * from "./repos/briefings";
export * from "./repos/time-entries";
export * from "./repos/search";
export * from "./repos/billing";
export * from "./repos/value-events";
export * from "./repos/rollups";
