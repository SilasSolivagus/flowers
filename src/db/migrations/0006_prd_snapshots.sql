CREATE TABLE IF NOT EXISTS "prd_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid NOT NULL,
	"url" text NOT NULL,
	"markdown" text NOT NULL,
	"hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "prd_snapshots" ADD CONSTRAINT "prd_snapshots_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prd_snapshots_req" ON "prd_snapshots" USING btree ("requirement_id","fetched_at");