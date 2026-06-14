-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clickup_connections" (
    "shop_domain" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "workspace_name" TEXT,
    "list_id" TEXT,
    "list_name" TEXT,
    "list_connections" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clickup_connections_pkey" PRIMARY KEY ("shop_domain")
);

-- CreateTable
CREATE TABLE "order_tasks" (
    "id" SERIAL NOT NULL,
    "shopify_order_id" TEXT NOT NULL,
    "clickup_task_id" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'synced',
    "order_number" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "shop_domain" TEXT NOT NULL,
    "plan_name" TEXT NOT NULL DEFAULT 'trial',
    "shopify_charge_id" TEXT,
    "shopify_charge_status" TEXT,
    "trial_start_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trial_end_date" TIMESTAMP(3) NOT NULL,
    "is_trial_active" BOOLEAN NOT NULL DEFAULT true,
    "billing_cycle_start" TIMESTAMP(3),
    "annual_billing" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "orders_synced_this_month" INTEGER NOT NULL DEFAULT 0,
    "orders_synced_all_time" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("shop_domain")
);

-- CreateTable
CREATE TABLE "activity_log" (
    "id" SERIAL NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "shopify_order_id" TEXT,
    "clickup_task_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_tasks_shop_domain_shopify_order_id_key" ON "order_tasks"("shop_domain", "shopify_order_id");

-- CreateIndex
CREATE INDEX "activity_log_shop_domain_created_at_idx" ON "activity_log"("shop_domain", "created_at" DESC);
