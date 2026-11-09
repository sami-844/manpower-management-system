CREATE TABLE "settings" (
	"entity_id" text DEFAULT coalesce(nullif(current_setting('app.entity_id', true), ''), 'OM-01') NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "settings_entity_id_key_pk" PRIMARY KEY("entity_id","key")
);
--> statement-breakpoint
CREATE TABLE "sponsors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_id" text DEFAULT coalesce(nullif(current_setting('app.entity_id', true), ''), 'OM-01') NOT NULL,
	"kind" text NOT NULL,
	"legal_name" text NOT NULL,
	"cr_number" text,
	"mol_establishment_no" text,
	"supplier_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "sponsors_kind_ck" CHECK ("sponsors"."kind" in ('own','external')),
	CONSTRAINT "sponsors_status_ck" CHECK ("sponsors"."status" in ('active','archived'))
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_id" text DEFAULT coalesce(nullif(current_setting('app.entity_id', true), ''), 'OM-01') NOT NULL,
	"name" text NOT NULL,
	"vat_number" text,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "suppliers_terms_ck" CHECK ("suppliers"."payment_terms_days" between 0 and 365)
);
--> statement-breakpoint
CREATE TABLE "supply_agreements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_id" text DEFAULT coalesce(nullif(current_setting('app.entity_id', true), ''), 'OM-01') NOT NULL,
	"payee" text NOT NULL,
	"sponsor_id" uuid,
	"supplier_id" uuid,
	"worker_id" uuid,
	"reference" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"min_billable_days" integer,
	"inclusions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "supply_agreements_payee_ck" CHECK ("supply_agreements"."payee" in ('sponsor','middleman','worker')),
	CONSTRAINT "supply_agreements_status_ck" CHECK ("supply_agreements"."status" in ('draft','approved')),
	CONSTRAINT "supply_agreements_dates_ck" CHECK ("supply_agreements"."end_date" is null or "supply_agreements"."end_date" >= "supply_agreements"."start_date"),
	CONSTRAINT "supply_agreements_payee_columns_ck" CHECK (("supply_agreements"."payee" = 'sponsor' and "supply_agreements"."sponsor_id" is not null and "supply_agreements"."supplier_id" is not null and "supply_agreements"."worker_id" is null)
       or ("supply_agreements"."payee" = 'middleman' and "supply_agreements"."supplier_id" is not null and "supply_agreements"."worker_id" is null)
       or ("supply_agreements"."payee" = 'worker' and "supply_agreements"."worker_id" is not null and "supply_agreements"."supplier_id" is null)),
	CONSTRAINT "supply_agreements_four_eyes_ck" CHECK ("supply_agreements"."approved_by" is null or "supply_agreements"."approved_by" <> "supply_agreements"."created_by"),
	CONSTRAINT "supply_agreements_approved_ck" CHECK (("supply_agreements"."status" = 'approved') = ("supply_agreements"."approved_by" is not null and "supply_agreements"."approved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "supply_rate_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_id" text DEFAULT coalesce(nullif(current_setting('app.entity_id', true), ''), 'OM-01') NOT NULL,
	"supply_agreement_id" uuid NOT NULL,
	"trade" text NOT NULL,
	"hour_type" text NOT NULL,
	"unit" text NOT NULL,
	"rate" numeric(14, 3) NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "supply_rate_lines_hour_type_ck" CHECK ("supply_rate_lines"."hour_type" in ('normal','overtime','rest_day','holiday','night')),
	CONSTRAINT "supply_rate_lines_unit_ck" CHECK ("supply_rate_lines"."unit" in ('hour','day','month')),
	CONSTRAINT "supply_rate_lines_rate_ck" CHECK ("supply_rate_lines"."rate" >= 0),
	CONSTRAINT "supply_rate_lines_dates_ck" CHECK ("supply_rate_lines"."valid_to" is null or "supply_rate_lines"."valid_to" >= "supply_rate_lines"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "worker_sponsorships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_id" text DEFAULT coalesce(nullif(current_setting('app.entity_id', true), ''), 'OM-01') NOT NULL,
	"worker_id" uuid NOT NULL,
	"sponsor_id" uuid,
	"engagement" text NOT NULL,
	"supply_agreement_id" uuid,
	"authorisation_ref" text,
	"authorisation_file_id" uuid,
	"consent_file_id" uuid,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "worker_sponsorships_engagement_ck" CHECK ("worker_sponsorships"."engagement" in ('own','supplied','transferred','free_visa')),
	CONSTRAINT "worker_sponsorships_sponsor_ck" CHECK ("worker_sponsorships"."sponsor_id" is not null or "worker_sponsorships"."engagement" = 'free_visa'),
	CONSTRAINT "worker_sponsorships_own_ck" CHECK ("worker_sponsorships"."engagement" <> 'own' or ("worker_sponsorships"."supply_agreement_id" is null and "worker_sponsorships"."authorisation_ref" is null)),
	CONSTRAINT "worker_sponsorships_dates_ck" CHECK ("worker_sponsorships"."valid_to" is null or "worker_sponsorships"."valid_to" >= "worker_sponsorships"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "hash_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sponsors" ADD CONSTRAINT "sponsors_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_agreements" ADD CONSTRAINT "supply_agreements_sponsor_id_sponsors_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_agreements" ADD CONSTRAINT "supply_agreements_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_agreements" ADD CONSTRAINT "supply_agreements_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_rate_lines" ADD CONSTRAINT "supply_rate_lines_supply_agreement_id_supply_agreements_id_fk" FOREIGN KEY ("supply_agreement_id") REFERENCES "public"."supply_agreements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_sponsorships" ADD CONSTRAINT "worker_sponsorships_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_sponsorships" ADD CONSTRAINT "worker_sponsorships_sponsor_id_sponsors_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_sponsorships" ADD CONSTRAINT "worker_sponsorships_supply_agreement_id_supply_agreements_id_fk" FOREIGN KEY ("supply_agreement_id") REFERENCES "public"."supply_agreements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sponsors_one_own_uq" ON "sponsors" USING btree ("entity_id") WHERE "sponsors"."kind" = 'own';--> statement-breakpoint
CREATE UNIQUE INDEX "sponsors_cr_uq" ON "sponsors" USING btree ("entity_id",lower("cr_number")) WHERE "sponsors"."cr_number" is not null;--> statement-breakpoint
CREATE INDEX "supply_rate_lines_agreement_idx" ON "supply_rate_lines" USING btree ("supply_agreement_id");--> statement-breakpoint
CREATE INDEX "worker_sponsorships_worker_idx" ON "worker_sponsorships" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "worker_sponsorships_sponsor_idx" ON "worker_sponsorships" USING btree ("sponsor_id");