CREATE TYPE "public"."alert_kind" AS ENUM('failure', 'recovery', 'slow');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."monitor_health" AS ENUM('unknown', 'passing', 'failing');--> statement-breakpoint
CREATE TYPE "public"."requested_platform" AS ENUM('auto', 'shopify', 'woocommerce');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'passed', 'failed', 'error');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('schedule', 'manual');--> statement-breakpoint
CREATE TABLE "alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" "alert_kind" NOT NULL,
	"channel_index" integer NOT NULL,
	"channel_type" text NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"response_status" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "monitor_state" (
	"monitor_id" uuid PRIMARY KEY NOT NULL,
	"health" "monitor_health" DEFAULT 'unknown' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"slow_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_run_id" uuid,
	"last_run_status" "run_status",
	"last_run_at" timestamp with time zone,
	"health_changed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"platform" "requested_platform" DEFAULT 'auto' NOT NULL,
	"devices" jsonb NOT NULL,
	"schedule" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"slow_step_ms" integer NOT NULL,
	"alert_after_failures" integer NOT NULL,
	"alerts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"trigger" "run_trigger" NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"detected_platform" text,
	"failed_step" text,
	"error" text,
	"result" jsonb
);
--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_state" ADD CONSTRAINT "monitor_state_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_deliveries_run_kind_channel_uq" ON "alert_deliveries" USING btree ("run_id","kind","channel_index");--> statement-breakpoint
CREATE INDEX "monitors_created_at_idx" ON "monitors" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "runs_monitor_started_idx" ON "runs" USING btree ("monitor_id","started_at" DESC NULLS LAST);