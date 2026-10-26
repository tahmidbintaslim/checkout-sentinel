ALTER TABLE "runs" ADD COLUMN "job_id" text;--> statement-breakpoint
CREATE INDEX "runs_running_job_idx" ON "runs" USING btree ("job_id") WHERE "runs"."status" = 'running';