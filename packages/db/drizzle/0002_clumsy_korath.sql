CREATE TYPE "public"."source_status" AS ENUM('uploaded', 'indexing', 'ready', 'error');--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"r2_key" text NOT NULL,
	"ai_search_item_id" text,
	"chunk_count" integer,
	"status" "source_status" DEFAULT 'uploaded' NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sources_tenant_created_idx" ON "sources" USING btree ("tenant_id","created_at" DESC NULLS LAST);