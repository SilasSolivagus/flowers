CREATE TABLE IF NOT EXISTS "uemaster_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"artifact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "uemaster_jobs_status_check" CHECK ("uemaster_jobs"."status" in ('running', 'done', 'failed')),
	CONSTRAINT "uemaster_jobs_stage_check" CHECK ("uemaster_jobs"."stage" in ('evaluate', 'review', 'inspect'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "uemaster_jobs" ADD CONSTRAINT "uemaster_jobs_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "uemaster_jobs" ADD CONSTRAINT "uemaster_jobs_artifact_id_uemaster_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."uemaster_artifacts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uemaster_jobs_running_unique" ON "uemaster_jobs" USING btree ("requirement_id","stage") WHERE "uemaster_jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "uemaster_jobs_req" ON "uemaster_jobs" USING btree ("requirement_id","stage","created_at" DESC NULLS LAST);