ALTER TABLE "audit_events" ALTER COLUMN "entity_id" SET DEFAULT coalesce(nullif(current_setting('app.entity_id', true), ''), 'OM-01');--> statement-breakpoint
ALTER TABLE "compliance_overrides" ALTER COLUMN "entity_id" SET DEFAULT coalesce(nullif(current_setting('app.entity_id', true), ''), 'OM-01');--> statement-breakpoint
ALTER TABLE "leave_periods" ALTER COLUMN "entity_id" SET DEFAULT coalesce(nullif(current_setting('app.entity_id', true), ''), 'OM-01');--> statement-breakpoint
ALTER TABLE "sites" ALTER COLUMN "entity_id" SET DEFAULT coalesce(nullif(current_setting('app.entity_id', true), ''), 'OM-01');--> statement-breakpoint
ALTER TABLE "worker_documents" ALTER COLUMN "entity_id" SET DEFAULT coalesce(nullif(current_setting('app.entity_id', true), ''), 'OM-01');--> statement-breakpoint
ALTER TABLE "workers" ALTER COLUMN "entity_id" SET DEFAULT coalesce(nullif(current_setting('app.entity_id', true), ''), 'OM-01');