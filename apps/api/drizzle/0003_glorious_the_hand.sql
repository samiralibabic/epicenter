ALTER TABLE "asset" RENAME COLUMN "user_id" TO "owner_id";--> statement-breakpoint
ALTER TABLE "durable_object_instance" RENAME COLUMN "user_id" TO "owner_id";--> statement-breakpoint
ALTER TABLE "asset" DROP CONSTRAINT "asset_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "durable_object_instance" DROP CONSTRAINT "durable_object_instance_user_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "asset_user_id_idx";--> statement-breakpoint
DROP INDEX "doi_user_id_idx";--> statement-breakpoint
CREATE INDEX "asset_owner_id_idx" ON "asset" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "doi_owner_id_idx" ON "durable_object_instance" USING btree ("owner_id");