ALTER TABLE "members" ADD COLUMN "line" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "password_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "notify_prefs" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "members_name_unique" ON "members" USING btree ("name");--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_role_check" CHECK ("members"."role" in ('product_owner', 'feature_reviewer', 'commercial_reviewer', 'pm'));--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_line_check" CHECK ("members"."line" in ('feature', 'commercial'));