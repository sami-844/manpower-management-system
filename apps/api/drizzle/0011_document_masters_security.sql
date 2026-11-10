-- Document masters (PRD 4.19, A26-A30): row-level security on the new business tables, files that
-- never change, and the permissions for who sees and maintains the masters.
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY entity_scope ON files
  USING (entity_id = current_setting('app.entity_id', true)) WITH CHECK (entity_id = current_setting('app.entity_id', true));
--> statement-breakpoint
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY entity_scope ON clients
  USING (entity_id = current_setting('app.entity_id', true)) WITH CHECK (entity_id = current_setting('app.entity_id', true));
--> statement-breakpoint
ALTER TABLE organisation_documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY entity_scope ON organisation_documents
  USING (entity_id = current_setting('app.entity_id', true)) WITH CHECK (entity_id = current_setting('app.entity_id', true));
--> statement-breakpoint
-- A stored file's bytes, name and hash never change; only its scan status moves (pending to clean or infected).
REVOKE UPDATE ON files FROM mms_app;
--> statement-breakpoint
GRANT UPDATE (scan_status) ON files TO mms_app;
--> statement-breakpoint
-- Permissions (src/auth/permissions.ts lists the same keys). A30: HR/PRO maintain every master,
-- operations also record client and sub-contractor papers and add clients (with finance); opening a
-- worker's document scan shows personal data, so it needs pii.view (TR-SEC-07).
INSERT INTO permissions (key, description) VALUES
  ('masters.read', 'See the document masters and their registers'),
  ('org_documents.manage', 'Record and renew the papers of the company, its sub-contractors and its clients, and upload their scans'),
  ('clients.read', 'See clients'),
  ('clients.manage', 'Add clients and change their details'),
  ('pii.view', 'See personal data in full, including the scans of workers'' documents');
--> statement-breakpoint
INSERT INTO role_permissions (role_key, permission_key) VALUES
  ('owner', 'masters.read'), ('owner', 'clients.read'), ('owner', 'pii.view'),
  ('ops_manager', 'masters.read'), ('ops_manager', 'org_documents.manage'), ('ops_manager', 'clients.read'), ('ops_manager', 'clients.manage'),
  ('hr_pro', 'masters.read'), ('hr_pro', 'org_documents.manage'), ('hr_pro', 'clients.read'), ('hr_pro', 'pii.view'),
  ('finance', 'masters.read'), ('finance', 'clients.read'), ('finance', 'clients.manage');
