CREATE TABLE IF NOT EXISTS "code_index" (
	"repo" text NOT NULL,
	"sha" text NOT NULL,
	"files" jsonb NOT NULL,
	"imports" jsonb NOT NULL,
	"routes" jsonb NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "code_index_repo_sha_pk" PRIMARY KEY("repo","sha")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "code_index_built_at" ON "code_index" USING btree ("built_at");