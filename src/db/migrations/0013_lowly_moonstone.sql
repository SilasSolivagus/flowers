CREATE TABLE IF NOT EXISTS "notify_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"event_seq" integer NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notify_deliveries_channel_check" CHECK ("notify_deliveries"."channel" in ('site', 'wecom')),
	CONSTRAINT "notify_deliveries_status_check" CHECK ("notify_deliveries"."status" in ('sent', 'failed', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "wecom_userid" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "wecom_lookup_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notify_deliveries" ADD CONSTRAINT "notify_deliveries_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notify_deliveries_once_unique" ON "notify_deliveries" USING btree ("member_id","event_seq","channel");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notify_deliveries_member" ON "notify_deliveries" USING btree ("member_id","status");