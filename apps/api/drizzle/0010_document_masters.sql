CREATE SEQUENCE "public"."client_code_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_id" text DEFAULT coalesce(nullif(current_setting('app.entity_id', true), ''), 'OM-01') NOT NULL,
	"code" text DEFAULT 'C-' || lpad(nextval('client_code_seq')::text, 5, '0') NOT NULL,
	"legal_name" text NOT NULL,
	"cr_number" text,
	"vat_number" text,
	"credit_limit" numeric(14, 3),
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "clients_status_ck" CHECK ("clients"."status" in ('prospect','active','on_hold')),
	CONSTRAINT "clients_terms_ck" CHECK ("clients"."payment_terms_days" between 0 and 365),
	CONSTRAINT "clients_credit_ck" CHECK ("clients"."credit_limit" is null or "clients"."credit_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_id" text DEFAULT coalesce(nullif(current_setting('app.entity_id', true), ''), 'OM-01') NOT NULL,
	"s3_key" text NOT NULL,
	"original_name" text NOT NULL,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"scan_status" text DEFAULT 'pending' NOT NULL,
	"uploaded_by" text NOT NULL,
	"object_lock_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_mime_ck" CHECK ("files"."mime" in ('application/pdf','image/jpeg','image/png','image/heic')),
	CONSTRAINT "files_bytes_ck" CHECK ("files"."bytes" between 1 and 15728640),
	CONSTRAINT "files_scan_status_ck" CHECK ("files"."scan_status" in ('pending','clean','infected')),
	CONSTRAINT "files_sha256_ck" CHECK ("files"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "files_name_ck" CHECK (length("files"."original_name") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "organisation_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_id" text DEFAULT coalesce(nullif(current_setting('app.entity_id', true), ''), 'OM-01') NOT NULL,
	"sponsor_id" uuid,
	"client_id" uuid,
	"type" text NOT NULL,
	"number" text,
	"issue_date" date,
	"expiry_date" date,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"file_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "organisation_documents_owner_ck" CHECK (("organisation_documents"."sponsor_id" is null) <> ("organisation_documents"."client_id" is null)),
	CONSTRAINT "organisation_documents_type_ck" CHECK ("organisation_documents"."type" in ('commercial_registration','chamber_certificate','tax_card','vat_certificate','activity_licence','tenancy_agreement','municipality_licence','labour_authorisation')),
	CONSTRAINT "organisation_documents_dates_ck" CHECK ("organisation_documents"."issue_date" is null or "organisation_documents"."expiry_date" is null or "organisation_documents"."issue_date" <= "organisation_documents"."expiry_date"),
	CONSTRAINT "organisation_documents_verified_ck" CHECK (not "organisation_documents"."verified" or ("organisation_documents"."verified_by" is not null and "organisation_documents"."verified_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "worker_documents" DROP CONSTRAINT "worker_documents_type_ck";--> statement-breakpoint
ALTER TABLE "worker_documents" ADD COLUMN "file_id" uuid;--> statement-breakpoint
ALTER TABLE "organisation_documents" ADD CONSTRAINT "organisation_documents_sponsor_id_sponsors_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_documents" ADD CONSTRAINT "organisation_documents_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_documents" ADD CONSTRAINT "organisation_documents_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_code_uq" ON "clients" USING btree ("entity_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_cr_uq" ON "clients" USING btree ("entity_id",lower("cr_number")) WHERE "clients"."cr_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "files_s3_key_uq" ON "files" USING btree ("s3_key");--> statement-breakpoint
CREATE INDEX "organisation_documents_sponsor_idx" ON "organisation_documents" USING btree ("sponsor_id");--> statement-breakpoint
CREATE INDEX "organisation_documents_client_idx" ON "organisation_documents" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "organisation_documents_expiry_idx" ON "organisation_documents" USING btree ("expiry_date");--> statement-breakpoint
ALTER TABLE "worker_documents" ADD CONSTRAINT "worker_documents_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_documents" ADD CONSTRAINT "worker_documents_type_ck" CHECK ("worker_documents"."type" in ('passport','residence_visa','labour_card','civil_id','medical','driving_licence','trade_certificate','insurance','medical_insurance','sohar_gate_pass'));