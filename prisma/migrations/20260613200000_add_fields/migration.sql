-- Add workspace_name to clickup_connections
ALTER TABLE "clickup_connections" ADD COLUMN "workspace_name" TEXT;

-- Add status to order_tasks
ALTER TABLE "order_tasks" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'synced';

-- Create activity_log table
CREATE TABLE "activity_log" (
    "id" SERIAL NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "activity_log_shop_domain_created_at_idx" ON "activity_log"("shop_domain", "created_at" DESC);
