ALTER TABLE "asset" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
CREATE INDEX "asset_visibility_idx" ON "asset" USING btree ("visibility");