ALTER TABLE "mcp_tokens" DROP CONSTRAINT "mcp_tokens_scopes_check";--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "goal" text;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "context" text;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "problem" text;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "surfaces" text;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "edge_cases" text;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "out_of_scope" text;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "uemaster_artifacts" ADD COLUMN "input_hash" text;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_scopes_check" CHECK ("mcp_tokens"."scopes" in ('read', 'write'));