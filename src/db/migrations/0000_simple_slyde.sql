CREATE TABLE IF NOT EXISTS "events" (
	"seq" integer PRIMARY KEY NOT NULL,
	"requirement_id" uuid,
	"actor" text NOT NULL,
	"type" text NOT NULL,
	"payload" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"release_date" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"state" text NOT NULL,
	"state_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requester" text NOT NULL,
	"owner_member_id" uuid,
	"prd_url" text,
	"skip_reason" text,
	"release_id" uuid,
	"commit_test_at" timestamp with time zone,
	"commit_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid NOT NULL,
	"reviewer_member_id" uuid NOT NULL,
	"verdict" text,
	"reason" text,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "requirements" ADD CONSTRAINT "requirements_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "requirements" ADD CONSTRAINT "requirements_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_reviewer_member_id_members_id_fk" FOREIGN KEY ("reviewer_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "requirements_number_unique" ON "requirements" USING btree ("number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_assignments_req" ON "review_assignments" USING btree ("requirement_id");