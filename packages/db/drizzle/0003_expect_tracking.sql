ALTER TYPE "public"."alert_kind" ADD VALUE 'tracking';--> statement-breakpoint
ALTER TABLE "monitor_state" ADD COLUMN "tracking_missing" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "expect_tracking" jsonb DEFAULT '[]'::jsonb NOT NULL;