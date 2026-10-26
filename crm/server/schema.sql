-- CRM interno: esquema SQLite. Todas las tablas de datos llevan workspace_id (preparado para multi-tenant).
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '{}',
  visibility TEXT NOT NULL DEFAULT 'own', -- own | team | all
  is_system INTEGER NOT NULL DEFAULT 0,
  UNIQUE(workspace_id, key)
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  manager_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role_id TEXT NOT NULL,
  team_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  quota REAL,
  email_signature TEXT,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  notification_prefs TEXT NOT NULL DEFAULT '{}',
  last_login_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  pending_2fa INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'read,write',
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  domain TEXT,
  sector TEXT,
  size INTEGER,
  revenue REAL,
  tax_id TEXT,
  address TEXT,
  city TEXT,
  country TEXT,
  phone TEXT,
  website TEXT,
  parent_id TEXT,
  owner_id TEXT,
  type TEXT NOT NULL DEFAULT 'prospect', -- prospect | customer | partner | competitor | supplier
  status TEXT NOT NULL DEFAULT 'active',
  tags TEXT NOT NULL DEFAULT '[]',
  custom TEXT NOT NULL DEFAULT '{}',
  last_activity_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_companies_ws ON companies(workspace_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(workspace_id, domain);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  email TEXT,
  phone TEXT,
  job_title TEXT,
  company_id TEXT,
  lifecycle_stage TEXT NOT NULL DEFAULT 'lead', -- subscriber|lead|mql|sql|opportunity|customer|evangelist|lost
  lead_status TEXT NOT NULL DEFAULT 'new', -- new|contacted|qualified|unqualified|nurturing
  disqualify_reason TEXT,
  source TEXT, -- web|referral|event|outbound|ads|import|api|other
  utm TEXT NOT NULL DEFAULT '{}',
  owner_id TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  language TEXT,
  timezone TEXT,
  address TEXT,
  city TEXT,
  country TEXT,
  linkedin TEXT,
  birthday TEXT,
  consent_marketing INTEGER NOT NULL DEFAULT 0,
  consent_date TEXT,
  consent_source TEXT,
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  custom TEXT NOT NULL DEFAULT '{}',
  qualification TEXT NOT NULL DEFAULT '{}', -- BANT checklist
  last_activity_at TEXT,
  last_contacted_at TEXT,
  first_response_at TEXT,
  merged_into TEXT,
  anonymized_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_contacts_ws ON contacts(workspace_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(workspace_id, email);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_id);

CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  pipeline_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  probability INTEGER NOT NULL DEFAULT 10,
  color TEXT NOT NULL DEFAULT '#3A6EDB',
  expected_days INTEGER NOT NULL DEFAULT 14,
  required_fields TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'open' -- open | won | lost
);
CREATE INDEX IF NOT EXISTS idx_stages_pipeline ON stages(pipeline_id);

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  company_id TEXT,
  pipeline_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'EUR',
  probability INTEGER NOT NULL DEFAULT 10,
  expected_close_date TEXT,
  closed_at TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | won | lost
  loss_reason TEXT,
  competitor TEXT,
  owner_id TEXT,
  source TEXT,
  stage_entered_at TEXT NOT NULL,
  next_activity_at TEXT,
  last_activity_at TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  custom TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deals_ws ON deals(workspace_id, deleted_at, status);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage_id);
CREATE INDEX IF NOT EXISTS idx_deals_company ON deals(company_id);
CREATE INDEX IF NOT EXISTS idx_deals_owner ON deals(owner_id);

CREATE TABLE IF NOT EXISTS deal_contacts (
  deal_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'decision_maker', -- decision_maker | influencer | user | other
  PRIMARY KEY (deal_id, contact_id)
);

CREATE TABLE IF NOT EXISTS deal_stage_history (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  from_stage_id TEXT,
  to_stage_id TEXT NOT NULL,
  user_id TEXT,
  entered_at TEXT NOT NULL,
  left_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_dsh_deal ON deal_stage_history(deal_id);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  sku TEXT,
  name TEXT NOT NULL,
  description TEXT,
  unit_price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'EUR',
  tax_rate REAL NOT NULL DEFAULT 21,
  cost REAL,
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'ud',
  billing_period TEXT NOT NULL DEFAULT 'one_time', -- one_time | monthly | yearly
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deal_products (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  product_id TEXT,
  name TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  billing_period TEXT NOT NULL DEFAULT 'one_time',
  total REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_deal_products_deal ON deal_products(deal_id);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  number TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  date TEXT NOT NULL,
  valid_until TEXT,
  lines TEXT NOT NULL DEFAULT '[]',
  subtotal REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft', -- draft|sent|viewed|accepted|rejected|expired
  notes TEXT,
  token TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  viewed_at TEXT,
  decided_at TEXT,
  signer TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quotes_deal ON quotes(deal_id);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  type TEXT NOT NULL, -- email|call|meeting|note|task|sms|whatsapp|chat|system
  subject TEXT NOT NULL DEFAULT '',
  body TEXT,
  occurred_at TEXT NOT NULL,
  duration_min INTEGER,
  outcome TEXT,
  direction TEXT, -- inbound | outbound
  user_id TEXT,
  contact_id TEXT,
  company_id TEXT,
  deal_id TEXT,
  ticket_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_act_contact ON activities(contact_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_act_company ON activities(company_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_act_deal ON activities(deal_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_act_ws ON activities(workspace_id, occurred_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'todo', -- call|email|meeting|followup|todo
  due_at TEXT,
  priority TEXT NOT NULL DEFAULT 'normal', -- low|normal|high
  assignee_id TEXT,
  contact_id TEXT,
  company_id TEXT,
  deal_id TEXT,
  ticket_id TEXT,
  description TEXT,
  completed_at TEXT,
  outcome TEXT,
  recurrence TEXT, -- daily|weekly|monthly
  reminded_at TEXT,
  overdue_notified_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, completed_at, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_deal ON tasks(deal_id);
CREATE INDEX IF NOT EXISTS idx_tasks_contact ON tasks(contact_id);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  subject TEXT NOT NULL,
  description TEXT,
  contact_id TEXT,
  company_id TEXT,
  deal_id TEXT,
  channel TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'new', -- new|open|pending|resolved|closed
  priority TEXT NOT NULL DEFAULT 'normal', -- low|normal|high|urgent
  category TEXT,
  assignee_id TEXT,
  sla_due_at TEXT,
  first_response_at TEXT,
  resolved_at TEXT,
  csat INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_fields (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  object TEXT NOT NULL, -- contact|company|deal|ticket
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL, -- text|textarea|number|currency|percent|date|datetime|boolean|select|multiselect|user|url|email|phone
  options TEXT NOT NULL DEFAULT '[]',
  required INTEGER NOT NULL DEFAULT 0,
  default_value TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  section TEXT,
  show_if TEXT, -- JSON {field, value}
  UNIQUE(workspace_id, object, key)
);

CREATE TABLE IF NOT EXISTS views (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  object TEXT NOT NULL,
  name TEXT NOT NULL,
  filters TEXT NOT NULL DEFAULT '{}',
  columns TEXT NOT NULL DEFAULT '[]',
  sort TEXT NOT NULL DEFAULT '{}',
  shared INTEGER NOT NULL DEFAULT 0,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  object TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'static', -- static | dynamic
  filters TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS list_members (
  list_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (list_id, record_id)
);

CREATE TABLE IF NOT EXISTS email_templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  folder TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  activity_id TEXT,
  contact_id TEXT,
  user_id TEXT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued|sent|failed|logged
  opens INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  first_opened_at TEXT,
  error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS forms (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  fields TEXT NOT NULL DEFAULT '[]',
  settings TEXT NOT NULL DEFAULT '{}', -- {assignment:{mode:'fixed'|'round_robin', user_id, team_id}, pipeline_id, create_deal, thank_you, redirect_url, consent_text}
  active INTEGER NOT NULL DEFAULT 1,
  submissions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS form_submissions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  contact_id TEXT,
  data TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  trigger TEXT NOT NULL, -- JSON {type, object, field?, value?, days?}
  conditions TEXT NOT NULL DEFAULT '{"logic":"and","conditions":[]}',
  actions TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  allow_reenroll INTEGER NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  object TEXT NOT NULL,
  record_id TEXT NOT NULL,
  status TEXT NOT NULL, -- ok | skipped | error
  log TEXT NOT NULL DEFAULT '[]',
  ran_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wruns_wf ON workflow_runs(workflow_id, ran_at);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- workflow_action | webhook_retry
  payload TEXT NOT NULL,
  run_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON scheduled_jobs(done_at, run_at);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|ok|failed
  attempts INTEGER NOT NULL DEFAULT 0,
  response_code INTEGER,
  error TEXT,
  next_retry_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT,
  object TEXT NOT NULL,
  record_id TEXT,
  action TEXT NOT NULL, -- create|update|delete|restore|login|export|merge|anonymize|permission|stage_change|login_failed
  changes TEXT NOT NULL DEFAULT '{}',
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_record ON audit_log(object, record_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_ws ON audit_log(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  object TEXT NOT NULL,
  file_name TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  created_ids TEXT NOT NULL DEFAULT '[]',
  errors TEXT NOT NULL DEFAULT '[]',
  reverted_at TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merges (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  object TEXT NOT NULL,
  survivor_id TEXT NOT NULL,
  merged_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gdpr_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  type TEXT NOT NULL, -- export | anonymize
  user_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scoring_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  label TEXT NOT NULL,
  field TEXT NOT NULL,
  op TEXT NOT NULL,
  value TEXT,
  points INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS counters (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS board_configs (
  workspace_id TEXT NOT NULL,
  object TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, object)
);

-- ===================== CLM (gestión del ciclo de vida del contrato) =====================
CREATE TABLE IF NOT EXISTS contract_types (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, family TEXT NOT NULL DEFAULT 'commercial',
  direction TEXT NOT NULL DEFAULT 'income', description TEXT, min_signature_level TEXT NOT NULL DEFAULT 'SES', retention_years INTEGER NOT NULL DEFAULT 6,
  retention_basis TEXT NOT NULL DEFAULT 'termination', number_prefix TEXT NOT NULL DEFAULT 'CTR', requires_dpa INTEGER NOT NULL DEFAULT 1,
  requires_kyc INTEGER NOT NULL DEFAULT 0, sla_hours INTEGER NOT NULL DEFAULT 72, self_service INTEGER NOT NULL DEFAULT 0, approval_rules TEXT NOT NULL DEFAULT '[]',
  default_template_id TEXT, default_playbook_id TEXT, color TEXT NOT NULL DEFAULT '#579bfc', position INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contract_types_ws ON contract_types(workspace_id, code);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, number TEXT NOT NULL, title TEXT NOT NULL, type_id TEXT NOT NULL,
  counterparty_company_id TEXT, deal_id TEXT, quote_id TEXT, owner_id TEXT, legal_owner_id TEXT, department TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT', substatus TEXT, prev_status TEXT, kind TEXT NOT NULL DEFAULT 'master', parent_id TEXT, amendment_seq INTEGER NOT NULL DEFAULT 0, amendment_type TEXT,
  paper_origin TEXT NOT NULL DEFAULT 'ours', language TEXT NOT NULL DEFAULT 'es', governing_law TEXT NOT NULL DEFAULT 'ES', jurisdiction TEXT, arbitration INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT, signed_at TEXT, effective_date TEXT, end_date TEXT, term_type TEXT NOT NULL DEFAULT 'fixed', term_months INTEGER,
  renewal_type TEXT NOT NULL DEFAULT 'none', renewal_period_months INTEGER, notice_period_days INTEGER, notice_deadline TEXT, next_renewal_date TEXT, max_renewals INTEGER, renewals_done INTEGER NOT NULL DEFAULT 0,
  total_value REAL NOT NULL DEFAULT 0, annual_value REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'EUR', value_basis TEXT NOT NULL DEFAULT 'fixed', payment_model TEXT NOT NULL DEFAULT 'one_off', payment_terms_days INTEGER NOT NULL DEFAULT 30,
  risk_level TEXT NOT NULL DEFAULT 'low', risk_score REAL NOT NULL DEFAULT 0, risk_factors TEXT NOT NULL DEFAULT '[]', risk_override TEXT, risk_override_reason TEXT,
  confidentiality TEXT NOT NULL DEFAULT 'normal', contains_personal_data INTEGER NOT NULL DEFAULT 0, data_role TEXT, international_transfer INTEGER NOT NULL DEFAULT 0, dora_in_scope INTEGER NOT NULL DEFAULT 0, public_sector INTEGER NOT NULL DEFAULT 0,
  current_version_id TEXT, signed_version_id TEXT, tags TEXT NOT NULL DEFAULT '[]', custom TEXT NOT NULL DEFAULT '{}', effective_values TEXT NOT NULL DEFAULT '{}', intake TEXT NOT NULL DEFAULT '{}',
  urgency TEXT NOT NULL DEFAULT 'normal', sla_due_at TEXT, sla_paused INTEGER NOT NULL DEFAULT 0, description TEXT, counterparty_outside_eea INTEGER NOT NULL DEFAULT 0,
  termination_date TEXT, termination_cause TEXT, retention_until TEXT, legal_hold INTEGER NOT NULL DEFAULT 0, legal_hold_reason TEXT, source TEXT NOT NULL DEFAULT 'intake',
  last_activity_at TEXT, deleted_at TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contracts_ws ON contracts(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_contracts_cp ON contracts(counterparty_company_id);
CREATE INDEX IF NOT EXISTS idx_contracts_parent ON contracts(parent_id);
CREATE INDEX IF NOT EXISTS idx_contracts_end ON contracts(workspace_id, end_date);

CREATE TABLE IF NOT EXISTS contract_versions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, contract_id TEXT NOT NULL, label TEXT NOT NULL, major INTEGER NOT NULL, minor INTEGER NOT NULL, branch TEXT NOT NULL DEFAULT 'internal',
  source TEXT NOT NULL DEFAULT 'generated', body TEXT NOT NULL DEFAULT '', file_name TEXT, sha256 TEXT NOT NULL, author_id TEXT, comment TEXT,
  is_current INTEGER NOT NULL DEFAULT 1, is_final INTEGER NOT NULL DEFAULT 0, is_signed INTEGER NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, template_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cversions ON contract_versions(contract_id, major, minor);

CREATE TABLE IF NOT EXISTS clauses (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL, variant_type TEXT NOT NULL DEFAULT 'standard',
  position TEXT NOT NULL DEFAULT 'preferred', direction TEXT NOT NULL DEFAULT 'both', body TEXT NOT NULL, risk_level TEXT NOT NULL DEFAULT 'low', status TEXT NOT NULL DEFAULT 'approved',
  usage_guide TEXT, negotiation_notes TEXT, approver_role TEXT, version INTEGER NOT NULL DEFAULT 1, usage_count INTEGER NOT NULL DEFAULT 0, language TEXT NOT NULL DEFAULT 'es', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clauses_ws ON clauses(workspace_id, category);

CREATE TABLE IF NOT EXISTS contract_clauses (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, contract_id TEXT NOT NULL, version_id TEXT NOT NULL, clause_id TEXT, category TEXT NOT NULL, heading TEXT,
  text_final TEXT, status TEXT NOT NULL DEFAULT 'standard', deviation_level TEXT NOT NULL DEFAULT 'none', deviation_summary TEXT, approver_role TEXT, suggested_clause_id TEXT,
  params TEXT NOT NULL DEFAULT '{}', source_text TEXT, confidence REAL NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cclauses ON contract_clauses(contract_id, version_id);

CREATE TABLE IF NOT EXISTS clm_templates (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, type_id TEXT, language TEXT NOT NULL DEFAULT 'es', body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'contract',
  status TEXT NOT NULL DEFAULT 'approved', version INTEGER NOT NULL DEFAULT 1, description TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playbooks (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, type_id TEXT, direction TEXT NOT NULL DEFAULT 'both', rules TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contract_approvals (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, contract_id TEXT NOT NULL, version_id TEXT NOT NULL, version_sha256 TEXT NOT NULL, step_order INTEGER NOT NULL, step_name TEXT NOT NULL,
  reason TEXT, approver_user_id TEXT, approver_role TEXT, status TEXT NOT NULL DEFAULT 'pending', decided_at TEXT, decided_by TEXT, comment TEXT, conditions TEXT, due_at TEXT, escalated_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capprovals ON contract_approvals(contract_id, status);

CREATE TABLE IF NOT EXISTS signature_envelopes (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, contract_id TEXT NOT NULL, version_id TEXT NOT NULL, version_sha256 TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'SES',
  status TEXT NOT NULL DEFAULT 'draft', message TEXT, sent_at TEXT, expires_at TEXT, completed_at TEXT, final_sha256 TEXT, evidence TEXT NOT NULL DEFAULT '{}', created_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS signers (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, envelope_id TEXT NOT NULL, contact_id TEXT, user_id TEXT, name TEXT NOT NULL, email TEXT NOT NULL, order_no INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL DEFAULT 'signer', party TEXT NOT NULL DEFAULT 'them', title TEXT, status TEXT NOT NULL DEFAULT 'pending', token TEXT NOT NULL, otp_code TEXT, otp_sent_at TEXT, otp_attempts INTEGER NOT NULL DEFAULT 0,
  viewed_at TEXT, signed_at TEXT, ip TEXT, user_agent TEXT, declined_reason TEXT, consent_text TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signers_token ON signers(token);
CREATE TABLE IF NOT EXISTS signature_events (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, envelope_id TEXT NOT NULL, signer_id TEXT, type TEXT NOT NULL, at TEXT NOT NULL, ip TEXT, meta TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS signature_authority (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, type_codes TEXT NOT NULL DEFAULT '[]', max_value REAL, requires_joint INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT, valid_to TEXT, power_ref TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS obligations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, contract_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, type TEXT NOT NULL DEFAULT 'other', obligor TEXT NOT NULL DEFAULT 'us',
  owner_id TEXT, due_date TEXT, recurrence TEXT NOT NULL DEFAULT 'none', status TEXT NOT NULL DEFAULT 'pending', amount REAL, currency TEXT, penalty_rule TEXT,
  evidence_required INTEGER NOT NULL DEFAULT 0, evidence_note TEXT, evidence_url TEXT, fulfilled_at TEXT, breached_at TEXT, breach_notes TEXT, survives_termination INTEGER NOT NULL DEFAULT 0, survival_until TEXT,
  ai_extracted INTEGER NOT NULL DEFAULT 0, source_clause TEXT, reminded_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obligations ON obligations(workspace_id, status, due_date);
CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, contract_id TEXT NOT NULL, type TEXT NOT NULL, label TEXT NOT NULL, date TEXT NOT NULL, computed INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT, alert_offsets TEXT NOT NULL DEFAULT '[30,7,1]', alerted TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'upcoming', actioned_at TEXT, action_taken TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_milestones ON milestones(workspace_id, date);
CREATE TABLE IF NOT EXISTS contract_comments (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, contract_id TEXT NOT NULL, version_id TEXT, author_id TEXT, author_name TEXT, body TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'internal',
  anchor TEXT, resolved_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS renewal_decisions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, contract_id TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT, decided_by TEXT, decided_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_schedule (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, contract_id TEXT NOT NULL, label TEXT, due_date TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR',
  type TEXT NOT NULL DEFAULT 'recurring', status TEXT NOT NULL DEFAULT 'planned', invoice_ref TEXT, paid_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contract_timeline (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, contract_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT, actor_id TEXT, actor_name TEXT, actor_type TEXT NOT NULL DEFAULT 'user', meta TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ctimeline ON contract_timeline(contract_id, at);

-- ===================== Modelo de columnas y motor de automatizaciones v2 =====================
CREATE TABLE IF NOT EXISTS label_sets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  labels TEXT NOT NULL DEFAULT '[]', -- [{id,label,color,done}] (ids estables: el valor guardado es el id)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS automation_schedule (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  object TEXT NOT NULL,
  record_id TEXT NOT NULL,
  basis TEXT NOT NULL,      -- valor de la fecha que originó la programación
  fire_at TEXT NOT NULL,
  fired_at TEXT,
  UNIQUE(workflow_id, record_id, basis)
);
CREATE INDEX IF NOT EXISTS idx_asched_due ON automation_schedule(fired_at, fire_at);
CREATE TABLE IF NOT EXISTS automation_approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  object TEXT NOT NULL,
  record_id TEXT NOT NULL,
  approver_id TEXT,
  title TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|expired
  payload TEXT NOT NULL DEFAULT '{}',      -- {then, else, rest, depth}
  comment TEXT,
  decided_by TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_aappr_user ON automation_approvals(approver_id, status);

-- ---------------------------------------------------------------- analítica: informes, paneles, programación, alertas, cuotas
CREATE TABLE IF NOT EXISTS saved_reports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_id TEXT,
  team_id TEXT,
  role_key TEXT,
  name TEXT NOT NULL,
  description TEXT,
  object TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  visibility TEXT NOT NULL DEFAULT 'private', -- private|team|all|role
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sreports_ws ON saved_reports(workspace_id, owner_id);
CREATE TABLE IF NOT EXISTS dashboards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_id TEXT,
  team_id TEXT,
  role_key TEXT,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private', -- private|team|all|role
  is_default INTEGER NOT NULL DEFAULT 0,
  widgets TEXT NOT NULL DEFAULT '[]',
  filters TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dash_ws ON dashboards(workspace_id);
CREATE TABLE IF NOT EXISTS report_schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  frequency TEXT NOT NULL, -- daily|weekly|monthly
  hour INTEGER NOT NULL DEFAULT 8,
  weekday INTEGER NOT NULL DEFAULT 1,
  monthday INTEGER NOT NULL DEFAULT 1,
  recipients TEXT NOT NULL DEFAULT '[]',
  period_days INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  last_period_key TEXT,
  last_run_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS metric_alerts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  name TEXT NOT NULL,
  metric TEXT NOT NULL,
  report_id TEXT,
  period TEXT NOT NULL DEFAULT 'week',
  op TEXT NOT NULL,
  threshold REAL NOT NULL,
  notify_user_ids TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  last_value REAL,
  last_checked_at TEXT,
  last_triggered_key TEXT,
  last_triggered_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_quotas (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,
  amount REAL NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, month)
);

-- Listas de valores personalizadas (etiquetas de los campos del sistema con su comportamiento)
CREATE TABLE IF NOT EXISTS picklist_options (
  workspace_id TEXT NOT NULL,
  picklist TEXT NOT NULL,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#c4c4c4',
  role TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (workspace_id, picklist, id)
);
-- ---------- objetos personalizados (Proyectos, Inmuebles, Pedidos…) ----------
CREATE TABLE IF NOT EXISTS custom_objects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,                    -- o_<slug>: es el «objeto» en campos, celdas, permisos y automatizaciones
  name TEXT NOT NULL,                   -- singular: Proyecto
  plural TEXT NOT NULL,                 -- plural: Proyectos
  icon TEXT NOT NULL DEFAULT 'box',
  color TEXT NOT NULL DEFAULT '#579bfc',
  primary_label TEXT NOT NULL DEFAULT 'Nombre',
  number_prefix TEXT,                   -- PRY → PRY-0001 (null = sin numeración)
  number_pad INTEGER NOT NULL DEFAULT 4,
  has_owner INTEGER NOT NULL DEFAULT 1,
  statuses TEXT NOT NULL DEFAULT '[]',  -- [{id, label, color, done}]
  relations TEXT NOT NULL DEFAULT '[]', -- [{key, label, target, many, inverse_label}]
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, key)
);
CREATE TABLE IF NOT EXISTS custom_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  name TEXT NOT NULL,
  number TEXT,
  owner_id TEXT,
  status TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  custom TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_custom_records_obj ON custom_records(workspace_id, object_key, deleted_at);
CREATE TABLE IF NOT EXISTS custom_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  record_id TEXT NOT NULL,              -- registro del objeto personalizado que define la relación
  object_key TEXT NOT NULL,
  relation_key TEXT NOT NULL,
  target_object TEXT NOT NULL,          -- contact | company | deal | contract | ticket | o_<otro>
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(record_id, relation_key, target_id)
);
CREATE INDEX IF NOT EXISTS idx_custom_links_target ON custom_links(target_object, target_id);
-- Diseño de fichas por objeto (y opcionalmente por rol)
CREATE TABLE IF NOT EXISTS layouts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  object TEXT NOT NULL,
  role_id TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_layouts ON layouts(workspace_id, object, COALESCE(role_id, ''));

-- Seguridad por campo y rol: read = solo lectura, hidden = oculto (sin fila = editable)
CREATE TABLE IF NOT EXISTS field_permissions (
  workspace_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  object TEXT NOT NULL,
  field TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('read','hidden')),
  PRIMARY KEY (workspace_id, role_id, object, field)
);

-- Registros compartidos con un usuario o un equipo más allá de la visibilidad del rol
CREATE TABLE IF NOT EXISTS record_shares (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  object TEXT NOT NULL,
  record_id TEXT NOT NULL,
  user_id TEXT,
  team_id TEXT,
  access TEXT NOT NULL DEFAULT 'read' CHECK (access IN ('read','edit')),
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_record_shares ON record_shares(workspace_id, object, record_id);
CREATE INDEX IF NOT EXISTS idx_record_shares_user ON record_shares(workspace_id, user_id);
