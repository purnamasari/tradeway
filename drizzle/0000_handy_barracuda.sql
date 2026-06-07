CREATE TABLE "metric_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"funding_rate" real,
	"open_interest" real,
	"atr" real,
	"adx" real,
	"volume_15m" real,
	"ema20" real,
	"ema50" real,
	"price" real NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regime_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"regime" text NOT NULL,
	"adx" real NOT NULL,
	"atr_percentile" real NOT NULL,
	"ema_spread_pct" real NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"strategy" text NOT NULL,
	"direction" text NOT NULL,
	"confidence" integer NOT NULL,
	"setup_quality" integer NOT NULL,
	"rr" real NOT NULL,
	"regime" text NOT NULL,
	"trend" text NOT NULL,
	"trend_source" text NOT NULL,
	"payload" jsonb NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_metric_symbol_time" ON "metric_history" USING btree ("symbol","recorded_at");--> statement-breakpoint
CREATE INDEX "idx_regime_symbol_time" ON "regime_log" USING btree ("symbol","computed_at");--> statement-breakpoint
CREATE INDEX "idx_signal_symbol_time" ON "signals" USING btree ("symbol","detected_at");--> statement-breakpoint
CREATE INDEX "idx_signal_strategy" ON "signals" USING btree ("strategy");