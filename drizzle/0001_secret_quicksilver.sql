CREATE TABLE "signal_outcomes" (
	"id" serial PRIMARY KEY NOT NULL,
	"signal_id" integer NOT NULL,
	"symbol" text NOT NULL,
	"strategy" text NOT NULL,
	"direction" text NOT NULL,
	"status" text DEFAULT 'PENDING_ENTRY' NOT NULL,
	"entry_price" real NOT NULL,
	"entry_low" real NOT NULL,
	"entry_high" real NOT NULL,
	"sl" real NOT NULL,
	"tp" real NOT NULL,
	"hit_price" real,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_outcome_status" ON "signal_outcomes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_outcome_signal_id" ON "signal_outcomes" USING btree ("signal_id");