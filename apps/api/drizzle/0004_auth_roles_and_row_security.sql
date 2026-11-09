-- Roles (PRD section 3), the permission catalogue and each role's grants (A25, TR-SEC-04).
-- src/auth/permissions.ts must list exactly these permission keys; test/auth.test.ts checks it.
INSERT INTO roles (key, name) VALUES
  ('owner', 'Owner / GM'),
  ('ops_manager', 'Operations manager'),
  ('hr_pro', 'HR / PRO officer'),
  ('payroll', 'Payroll officer'),
  ('finance', 'Accountant / finance'),
  ('supervisor', 'Site supervisor'),
  ('client', 'Client contact'),
  ('worker', 'Worker'),
  ('admin', 'System admin');
--> statement-breakpoint
INSERT INTO permissions (key, description) VALUES
  ('workers.read', 'See workers, their documents and leave'),
  ('workers.create', 'Create workers'),
  ('documents.create', 'Add worker documents'),
  ('documents.verify', 'Verify worker documents'),
  ('leave.create', 'Record leave'),
  ('compliance.check', 'Run the eligibility check'),
  ('compliance.renewals', 'See the renewals queue'),
  ('overrides.create', 'Approve compliance overrides'),
  ('dashboard.read', 'See the dashboard summary'),
  ('sites.read', 'See sites'),
  ('sites.create', 'Create sites'),
  ('audit.read', 'Read the audit trail of a record'),
  ('audit.verify', 'Verify the whole audit chain'),
  ('users.manage', 'Manage user accounts, roles and sign-in resets');
--> statement-breakpoint
INSERT INTO role_permissions (role_key, permission_key) VALUES
  ('owner', 'workers.read'), ('owner', 'compliance.check'), ('owner', 'compliance.renewals'),
  ('owner', 'overrides.create'), ('owner', 'dashboard.read'), ('owner', 'sites.read'),
  ('owner', 'audit.read'), ('owner', 'audit.verify'),
  ('ops_manager', 'workers.read'), ('ops_manager', 'compliance.check'), ('ops_manager', 'compliance.renewals'),
  ('ops_manager', 'overrides.create'), ('ops_manager', 'dashboard.read'), ('ops_manager', 'sites.read'),
  ('ops_manager', 'sites.create'), ('ops_manager', 'audit.read'),
  ('hr_pro', 'workers.read'), ('hr_pro', 'workers.create'), ('hr_pro', 'documents.create'),
  ('hr_pro', 'documents.verify'), ('hr_pro', 'leave.create'), ('hr_pro', 'compliance.check'),
  ('hr_pro', 'compliance.renewals'), ('hr_pro', 'dashboard.read'), ('hr_pro', 'sites.read'),
  ('hr_pro', 'audit.read'),
  ('payroll', 'workers.read'), ('payroll', 'dashboard.read'), ('payroll', 'sites.read'),
  ('finance', 'workers.read'), ('finance', 'dashboard.read'), ('finance', 'sites.read'),
  ('admin', 'users.manage'), ('admin', 'audit.read'), ('admin', 'audit.verify'), ('admin', 'sites.read');
--> statement-breakpoint
-- The role every API request runs as (SET LOCAL ROLE mms_app). It owns nothing, so row-level
-- security always applies to it. Cluster-wide, so it may already exist (test and dev databases).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mms_app') THEN
    CREATE ROLE mms_app NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO mms_app;
--> statement-breakpoint
-- No DELETE anywhere: records are archived, never deleted (Backend Schema conventions).
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO mms_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mms_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO mms_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO mms_app;
--> statement-breakpoint
-- The catalogue changes only by migration; the audit trail only grows.
REVOKE INSERT, UPDATE ON roles, permissions, role_permissions FROM mms_app;
--> statement-breakpoint
REVOKE UPDATE ON audit_events FROM mms_app;
--> statement-breakpoint
-- Row-level security by legal entity (TR-SEC-05). An unset app.entity_id matches no rows.
ALTER TABLE workers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY entity_scope ON workers
  USING (entity_id = current_setting('app.entity_id', true))
  WITH CHECK (entity_id = current_setting('app.entity_id', true));
--> statement-breakpoint
ALTER TABLE worker_documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY entity_scope ON worker_documents
  USING (entity_id = current_setting('app.entity_id', true))
  WITH CHECK (entity_id = current_setting('app.entity_id', true));
--> statement-breakpoint
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY entity_scope ON sites
  USING (entity_id = current_setting('app.entity_id', true))
  WITH CHECK (entity_id = current_setting('app.entity_id', true));
--> statement-breakpoint
ALTER TABLE compliance_overrides ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY entity_scope ON compliance_overrides
  USING (entity_id = current_setting('app.entity_id', true))
  WITH CHECK (entity_id = current_setting('app.entity_id', true));
--> statement-breakpoint
ALTER TABLE leave_periods ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY entity_scope ON leave_periods
  USING (entity_id = current_setting('app.entity_id', true))
  WITH CHECK (entity_id = current_setting('app.entity_id', true));
