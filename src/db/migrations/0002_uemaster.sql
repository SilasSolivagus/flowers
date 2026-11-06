CREATE TABLE IF NOT EXISTS "uemaster_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"url" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uemaster_artifacts_stage_check" CHECK ("uemaster_artifacts"."stage" in ('evaluate', 'review', 'inspect'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "uemaster_artifacts" ADD CONSTRAINT "uemaster_artifacts_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "uemaster_artifacts_req" ON "uemaster_artifacts" USING btree ("requirement_id","stage","created_at" DESC NULLS LAST);