CREATE TABLE IF NOT EXISTS "mcp_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"member_id" uuid NOT NULL,
	"label" text NOT NULL,
	"scopes" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "mcp_tokens_scopes_check" CHECK ("mcp_tokens"."scopes" in ('read', 'write', 'admin'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_tokens_hash_unique" ON "mcp_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_tokens_member" ON "mcp_tokens" USING btree ("member_id");
