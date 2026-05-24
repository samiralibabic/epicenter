DELETE FROM "durable_object_instance"
WHERE "do_type" IN ('workspace', 'document');
--> statement-breakpoint
ALTER TABLE "durable_object_instance" DROP COLUMN "do_type";
