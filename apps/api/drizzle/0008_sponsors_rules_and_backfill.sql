-- Sponsors and outsourced workers (PRD 4.18, A21-A24): rules Drizzle cannot express, row-level
-- security, permissions, and every existing worker recorded as the company's own.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
-- One sponsorship per worker per day (open-ended rows run to infinity).
ALTER TABLE worker_sponsorships ADD CONSTRAINT worker_sponsorships_no_overlap
  EXCLUDE USING gist (worker_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&);
--> statement-breakpoint
-- One rate per agreement, trade and hour type on any day.
ALTER TABLE supply_rate_lines ADD CONSTRAINT supply_rate_lines_no_overlap
  EXCLUDE USING gist (supply_agreement_id WITH =, trade WITH =, hour_type WITH =, daterange(valid_from, valid_to, '[]') WITH &&);
--> statement-breakpoint
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY entity_scope ON suppliers
  USING (entity_id = current_setting('app.entity_id', true)) WITH CHECK (entity_id = current_setting('app.entity_id', true));
--> statement-breakpoint
ALTER TABLE sponsors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY entity_scope ON sponsors
  USING (entity_id = current_setting('app.entity_id', true)) WITH CHECK (entity_id = current_setting('app.entity_id', true));
--> statement-breakpoint
ALTER TABLE supply_agreements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY entity_scope ON supply_agreements
  USING (entity_id = current_setting('app.entity_id', true)) WITH CHECK (entity_id = current_setting('app.entity_id', true));
--> statement-breakpoint
ALTER TABLE supply_rate_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY entity_scope ON supply_rate_lines
  USING (entity_id = current_setting('app.entity_id', true)) WITH CHECK (entity_id = current_setting('app.entity_id', true));
--> statement-breakpoint
ALTER TABLE worker_sponsorships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY entity_scope ON worker_sponsorships
  USING (entity_id = current_setting('app.entity_id', true)) WITH CHECK (entity_id = current_setting('app.entity_id', true));
--> statement-breakpoint
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY entity_scope ON settings
  USING (entity_id = current_setting('app.entity_id', true)) WITH CHECK (entity_id = current_setting('app.entity_id', true));
--> statement-breakpoint
-- Permissions (src/auth/permissions.ts lists the same keys). Who records, who approves (four eyes),
-- and who alone may approve an unauthorised engagement or change that policy (the owner, A22).
INSERT INTO permissions (key, description) VALUES
  ('sponsors.read', 'See sponsors, supply agreements and how many workers each sponsor holds'),
  ('sponsors.manage', 'Record sponsors and set a worker''s sponsor and engagement'),
  ('supply.manage', 'Record supply agreements and their rates'),
  ('supply.approve', 'Approve a supply agreement (not one you recorded)'),
  ('outsourcing.policy', 'Change whether unauthorised engagements are allowed with the owner''s approval or blocked'),
  ('overrides.approve_unauthorised', 'Approve an override for an unauthorised engagement');
--> statement-breakpoint
INSERT INTO role_permissions (role_key, permission_key) VALUES
  ('owner', 'sponsors.read'), ('owner', 'supply.approve'), ('owner', 'outsourcing.policy'), ('owner', 'overrides.approve_unauthorised'),
  ('ops_manager', 'sponsors.read'), ('ops_manager', 'sponsors.manage'), ('ops_manager', 'supply.manage'),
  ('hr_pro', 'sponsors.read'), ('hr_pro', 'sponsors.manage'),
  ('finance', 'sponsors.read'), ('finance', 'supply.manage'), ('finance', 'supply.approve'),
  ('payroll', 'sponsors.read');
--> statement-breakpoint
-- The company itself as the own sponsor of every entity that has workers (OM-01 always). The legal
-- name is a placeholder until HR records the real one on the Sponsors screen (S-42).
INSERT INTO sponsors (id, entity_id, kind, legal_name, created_by, updated_by)
SELECT gen_random_uuid(), e.entity_id, 'own', 'Own company (record the legal name)', 'system:migration', 'system:migration'
FROM (SELECT DISTINCT entity_id FROM workers UNION SELECT 'OM-01') e;
--> statement-breakpoint
-- Every existing worker becomes the company's own from the day they joined (or were recorded).
INSERT INTO worker_sponsorships (id, entity_id, worker_id, sponsor_id, engagement, valid_from, created_by)
SELECT gen_random_uuid(), w.entity_id, w.id, s.id, 'own', coalesce(w.joined_on, w.created_at::date), 'system:migration'
FROM workers w JOIN sponsors s ON s.entity_id = w.entity_id AND s.kind = 'own';
--> statement-breakpoint
-- A22: unauthorised engagements are allowed with the owner's approval until the company changes it.
INSERT INTO settings (entity_id, key, value, updated_by)
SELECT DISTINCT entity_id, 'outsourcing.unauthorised', '"allow_with_owner_approval"'::jsonb, 'system:migration (A22)'
FROM sponsors WHERE kind = 'own';
