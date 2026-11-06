CREATE TABLE IF NOT EXISTS "uemaster_job_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"phase" text NOT NULL,
	"model" text NOT NULL,
	"prompt_chars" integer NOT NULL,
	"output_chars" integer NOT NULL,
	"error" text,
	"ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uemaster_job_attempts_phase_check" CHECK ("uemaster_job_attempts"."phase" in ('flow', 'pages', 'build'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "uemaster_job_attempts" ADD CONSTRAINT "uemaster_job_attempts_job_id_uemaster_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."uemaster_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "uemaster_job_attempts_job" ON "uemaster_job_attempts" USING btree ("job_id","id");