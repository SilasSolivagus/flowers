CREATE TABLE IF NOT EXISTS "commit_history" (
	"repo" text NOT NULL,
	"commit_sha" text NOT NULL,
	"merged_at" timestamp with time zone NOT NULL,
	"branch" text,
	"message" text NOT NULL,
	"files" jsonb NOT NULL,
	CONSTRAINT "commit_history_repo_sha_pk" PRIMARY KEY("repo","commit_sha")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commit_history_merged_at" ON "commit_history" USING btree ("merged_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locate_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid,
	"stage" text NOT NULL,
	"outcome" text NOT NULL,
	"candidates" integer NOT NULL,
	"hit" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locate_runs_created_at" ON "locate_runs" USING btree ("created_at");
