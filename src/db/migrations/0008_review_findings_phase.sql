ALTER TABLE "uemaster_job_attempts" DROP CONSTRAINT "uemaster_job_attempts_phase_check";--> statement-breakpoint
ALTER TABLE "uemaster_job_attempts" ADD CONSTRAINT "uemaster_job_attempts_phase_check" CHECK ("uemaster_job_attempts"."phase" in ('flow', 'pages', 'build', 'locate', 'verify', 'findings'));
