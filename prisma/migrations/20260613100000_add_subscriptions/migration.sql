-- CreateTable
CREATE TABLE "subscriptions" (
    "shop_domain" TEXT NOT NULL,
    "plan_name" TEXT NOT NULL DEFAULT 'free',
    "shopify_charge_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "orders_this_month" INTEGER NOT NULL DEFAULT 0,
    "billing_cycle_start" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("shop_domain")
);
