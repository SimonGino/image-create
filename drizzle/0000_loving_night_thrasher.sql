CREATE TABLE `generation_images` (
	`id` text PRIMARY KEY NOT NULL,
	`generation_id` text NOT NULL,
	`idx` integer NOT NULL,
	`file_path` text NOT NULL,
	`thumb_path` text,
	`width` integer,
	`height` integer,
	`mime_type` text NOT NULL,
	FOREIGN KEY (`generation_id`) REFERENCES `generations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gen_images_generation_idx` ON `generation_images` (`generation_id`);--> statement-breakpoint
CREATE TABLE `generation_ref_images` (
	`id` text PRIMARY KEY NOT NULL,
	`generation_id` text NOT NULL,
	`idx` integer NOT NULL,
	`file_path` text NOT NULL,
	`role` text DEFAULT 'image' NOT NULL,
	FOREIGN KEY (`generation_id`) REFERENCES `generations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gen_ref_images_generation_idx` ON `generation_ref_images` (`generation_id`);--> statement-breakpoint
CREATE TABLE `generations` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`mode` text NOT NULL,
	`prompt` text NOT NULL,
	`size_spec` text NOT NULL,
	`quality` text,
	`output_format` text,
	`n_requested` integer DEFAULT 1 NOT NULL,
	`provider_params` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_code` text,
	`timing_ms` integer,
	`text_input_tokens` integer,
	`image_input_tokens` integer,
	`image_output_tokens` integer,
	`cost_usd` real,
	`cost_source` text
);
--> statement-breakpoint
CREATE INDEX `gen_created_idx` ON `generations` (`created_at`);--> statement-breakpoint
CREATE INDEX `gen_provider_model_idx` ON `generations` (`provider_id`,`model_id`);--> statement-breakpoint
CREATE INDEX `gen_mode_idx` ON `generations` (`mode`);--> statement-breakpoint
CREATE INDEX `gen_status_idx` ON `generations` (`status`);--> statement-breakpoint
CREATE TABLE `prompt_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`favorite` integer DEFAULT false NOT NULL,
	`variables` text,
	`default_provider_id` text,
	`default_model_id` text,
	`created_at` integer NOT NULL
);
