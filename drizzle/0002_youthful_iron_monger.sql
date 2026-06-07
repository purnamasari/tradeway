CREATE TABLE "market_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"open" real,
	"high" real,
	"low" real,
	"close" real,
	"volume" real,
	"open_interest" real,
	"funding_rate" real
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_market_symbol_time" ON "market_history" USING btree ("symbol","timestamp");