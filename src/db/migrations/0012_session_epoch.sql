ALTER TABLE "members" ADD COLUMN "session_epoch" timestamp with time zone DEFAULT now() NOT NULL;
