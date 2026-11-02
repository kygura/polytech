CREATE TABLE IF NOT EXISTS `agent_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pod_id` text NOT NULL,
	`role` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`output_json` text,
	`usage` text,
	`duration_s` real,
	`started_at` integer,
	`finished_at` integer,
	`tool_calls` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`condition_id` text,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`data` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`acked_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `alerts_acked_created` ON `alerts` (`acked_at`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `autonomy_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`from_mode` text NOT NULL,
	`to_mode` text NOT NULL,
	`scope` text DEFAULT 'global' NOT NULL,
	`reason` text NOT NULL,
	`actor` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pod_id` text NOT NULL,
	`agent_role` text NOT NULL,
	`url` text NOT NULL,
	`quote` text NOT NULL,
	`published_at` integer,
	`retrieved_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`claim` text NOT NULL,
	`direction` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `fills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`ts` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`price` real NOT NULL,
	`size` real NOT NULL,
	`fee` real DEFAULT 0 NOT NULL,
	`tx_hash` text,
	`paper` integer DEFAULT true NOT NULL,
	`trade_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `fills_trade_id_unique` ON `fills` (`trade_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `journal` (
	`thesis_id` text PRIMARY KEY NOT NULL,
	`condition_id` text NOT NULL,
	`category` text,
	`model` text,
	`p_hat` real,
	`p_pre` real,
	`mid_at` real,
	`liquidity_at` real,
	`r` real,
	`side` text,
	`stake` real,
	`result` text,
	`resolved_at` integer,
	`brier_model` real,
	`brier_market` real,
	`brier_pre` real,
	`log_loss` real,
	`drift_24h` real,
	`drift_7d` real,
	`paper_pnl` real
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`expires_at` integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `market_flags` (
	`condition_id` text PRIMARY KEY NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`muted` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `market_latest` (
	`condition_id` text PRIMARY KEY NOT NULL,
	`ts` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`mid` real,
	`best_bid` real,
	`best_ask` real,
	`spread` real,
	`depth_1c` real,
	`depth_2c` real,
	`depth_5c` real,
	`exit_depth` real,
	`capacity` real,
	`book_hash` text,
	`mid_changed_at` integer,
	`holder_count` integer,
	`holder_hhi` real,
	`top1_share` real,
	`top5_share` real,
	`flow_24h` real,
	`trade_median` real,
	`large_trade_24h` integer,
	`last_trade_ts` integer,
	`priority` real,
	`structural` text,
	`opportunity` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `markets` (
	`condition_id` text PRIMARY KEY NOT NULL,
	`event_id` text,
	`question` text NOT NULL,
	`category` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`end_date` integer,
	`neg_risk_group` text,
	`fee_rate` real,
	`fee_exponent` real,
	`status` text DEFAULT 'active' NOT NULL,
	`pm_id` text,
	`yes_token_id` text,
	`no_token_id` text,
	`vol_24h` real,
	`tick_size` real,
	`liquidity` real,
	`rules_hash` text,
	`heuristic_r` real,
	`resolution_source` text,
	`neg_risk_augmented` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`thesis_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`condition_id` text NOT NULL,
	`token_id` text NOT NULL,
	`side` text NOT NULL,
	`limit_price` real NOT NULL,
	`size` real NOT NULL,
	`mode_at_send` text NOT NULL,
	`approval` text,
	`status` text NOT NULL,
	`clob_order_id` text,
	`expires_at` integer,
	`paper` integer DEFAULT true NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`set_id` text,
	`proposal_id` text,
	FOREIGN KEY (`set_id`) REFERENCES `proposal_sets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `orders_idempotency_key_unique` ON `orders` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `outcomes` (
	`condition_id` text PRIMARY KEY NOT NULL,
	`resolved_at` integer NOT NULL,
	`result` text NOT NULL,
	`brier` real,
	`log_loss` real
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `paper_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`condition_id` text NOT NULL,
	`token_id` text NOT NULL,
	`outcome` text NOT NULL,
	`side` text NOT NULL,
	`kind` text NOT NULL,
	`limit_price` real,
	`stop_price` real,
	`usd` real,
	`shares` real,
	`filled_shares` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'working' NOT NULL,
	`reason` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`triggered_at` integer,
	`book_ts` integer,
	`closed_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `paper_orders_status_idx` ON `paper_orders` (`status`,`condition_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pods` (
	`id` text PRIMARY KEY NOT NULL,
	`condition_id` text NOT NULL,
	`started_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`trigger` text NOT NULL,
	`cost_sandbox_s` real DEFAULT 0 NOT NULL,
	`profile_id` text,
	`steering` text,
	`cancel_requested_at` integer,
	`stage` text,
	`error` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`condition_id` text NOT NULL,
	`token_id` text NOT NULL,
	`size` real NOT NULL,
	`avg_cost` real NOT NULL,
	`realized_pnl` real DEFAULT 0 NOT NULL,
	`opened_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`closed_at` integer,
	`paper` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `proposal_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`legs` text NOT NULL,
	`shares` real NOT NULL,
	`total_cost` real NOT NULL,
	`edge` real NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_at` integer,
	`decided_via` text,
	`approve_token_hash` text NOT NULL,
	`reject_token_hash` text NOT NULL,
	`failed_leg` integer,
	`error` text,
	`fallback_reason` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `proposal_sets_status` ON `proposal_sets` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `proposal_sets_one_pending_per_event` ON `proposal_sets` (`event_id`) WHERE status = 'pending';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`thesis_id` text NOT NULL,
	`condition_id` text NOT NULL,
	`token_id` text NOT NULL,
	`side` text NOT NULL,
	`kind` text NOT NULL,
	`size_usd` real NOT NULL,
	`shares` real NOT NULL,
	`limit_price` real NOT NULL,
	`expected_profit` real NOT NULL,
	`price_at_proposal` real NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_at` integer,
	`decided_via` text,
	`approve_token_hash` text NOT NULL,
	`reject_token_hash` text NOT NULL,
	`order_id` text,
	`error` text,
	`fallback_reason` text,
	`exit_reason` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `proposals_status` ON `proposals` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `proposals_one_pending_per_thesis` ON `proposals` (`thesis_id`) WHERE status = 'pending';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `reconciliations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`ok` integer NOT NULL,
	`baseline` integer DEFAULT false NOT NULL,
	`positions` text DEFAULT '{}' NOT NULL,
	`usdc_ledger` real NOT NULL,
	`usdc_exchange` real NOT NULL,
	`mismatches` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `research_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`filter` text NOT NULL,
	`steering` text NOT NULL,
	`every_min` integer,
	`last_run_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `research_profiles_name_unique` ON `research_profiles` (`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `rr_cache` (
	`condition_id` text NOT NULL,
	`rules_hash` text NOT NULL,
	`r` real NOT NULL,
	`detail` text,
	PRIMARY KEY(`condition_id`, `rules_hash`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `screens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`condition_id` text NOT NULL,
	`ts` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`r` real,
	`i` real,
	`l` real,
	`t` real,
	`c` real,
	`priority` real,
	`tier` text,
	`structural_flag` integer DEFAULT false NOT NULL,
	`structural_detail` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `screens_cond_ts` ON `screens` (`condition_id`,`ts`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`condition_id` text NOT NULL,
	`ts` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`mid` real,
	`best_bid` real,
	`best_ask` real,
	`depth_5c_usd` real,
	`vol_24h` real,
	`oi` real,
	`top10_share` real,
	`last_trade_ts` integer,
	`book` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `snapshots_cond_ts` ON `snapshots` (`condition_id`,`ts`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `spend` (
	`day` text PRIMARY KEY NOT NULL,
	`anthropic_usd` real DEFAULT 0 NOT NULL,
	`exa_calls` integer DEFAULT 0 NOT NULL,
	`sandbox_s` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `theses` (
	`id` text PRIMARY KEY NOT NULL,
	`condition_id` text NOT NULL,
	`pod_id` text NOT NULL,
	`p_hat` real NOT NULL,
	`c` real NOT NULL,
	`p_post` real NOT NULL,
	`side` text NOT NULL,
	`edge_c` real NOT NULL,
	`size_usd` real NOT NULL,
	`r_ann` real,
	`rank` real,
	`catalysts` text DEFAULT '[]' NOT NULL,
	`kill_criteria` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL,
	`expires_at` integer,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `theses_cond` ON `theses` (`condition_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `triage` (
	`condition_id` text PRIMARY KEY NOT NULL,
	`verdict` text NOT NULL,
	`score` real NOT NULL,
	`reason` text NOT NULL,
	`failed_rules` text DEFAULT '[]' NOT NULL,
	`model` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `views` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`query` text NOT NULL,
	`columns` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5) * 86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `views_name_unique` ON `views` (`name`);