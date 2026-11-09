-- Audit events are scoped by entity like every business table (TR-SEC-05): a request reads only
-- its own entity's history. The hash chain stays one chain across entities.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY entity_scope ON audit_events
  USING (entity_id = current_setting('app.entity_id', true))
  WITH CHECK (entity_id = current_setting('app.entity_id', true));
--> statement-breakpoint
-- The last hash of the whole chain, readable by mms_app without seeing any row: SECURITY DEFINER
-- runs as the owner, past row-level security. It reveals one hash, never an event's contents.
CREATE FUNCTION audit_last_hash() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1 $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_last_hash() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit_last_hash() TO mms_app;
