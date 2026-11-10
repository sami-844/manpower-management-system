-- Review fixes for the document masters (A30, Backend Schema "files").
-- The company's own papers (masters 1-8) are HR/PRO's alone; operations keep client and sub-contractor papers.
INSERT INTO permissions (key, description) VALUES
  ('company_documents.manage', 'Record and renew the company''s own papers and upload their scans');
--> statement-breakpoint
INSERT INTO role_permissions (role_key, permission_key) VALUES ('hr_pro', 'company_documents.manage');
--> statement-breakpoint
-- A scan's status only ever moves forward, once: pending to clean or infected. Nothing un-cleans or re-cleans a file.
CREATE FUNCTION files_scan_status_moves() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scan_status IS DISTINCT FROM OLD.scan_status
     AND NOT (OLD.scan_status = 'pending' AND NEW.scan_status IN ('clean', 'infected')) THEN
    RAISE EXCEPTION 'A scan status only moves from pending to clean or infected (was %, now %)', OLD.scan_status, NEW.scan_status;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER files_scan_status_moves BEFORE UPDATE ON files FOR EACH ROW EXECUTE FUNCTION files_scan_status_moves();
