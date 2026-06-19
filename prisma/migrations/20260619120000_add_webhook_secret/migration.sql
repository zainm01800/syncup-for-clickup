-- AlterTable
-- Nullable so the column can be added over existing platform_connections rows.
-- NULL means the connection predates inbound-webhook auth and must be reconnected.
ALTER TABLE "platform_connections" ADD COLUMN "webhook_secret" TEXT;

-- CreateIndex
-- Postgres treats multiple NULLs as distinct, so existing rows (NULL) coexist fine.
CREATE UNIQUE INDEX "platform_connections_webhook_secret_key" ON "platform_connections"("webhook_secret");
