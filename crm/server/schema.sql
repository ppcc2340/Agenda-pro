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
