CREATE TABLE "change_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"host" text NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopify_shops" (
	"shop_domain" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"host" text NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "change_events_store_idx" ON "change_events" USING btree ("workspace_id","host","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "change_events_external_idx" ON "change_events" USING btree ("source","external_id");