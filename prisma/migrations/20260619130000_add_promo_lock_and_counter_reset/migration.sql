-- Add per-subscription promo lock. A merchant who subscribed while the launch
-- promo was active keeps seeing (and being charged) promo prices even after the
-- global 10-slot pool fills. Without this, the price shown on /app/billing flips
-- to regular pricing for everyone once 10 paid subs exist — including already
-- grandfathered merchants, whose displayed price would then disagree with what
-- Shopify is actually charging them.
ALTER TABLE "subscriptions" ADD COLUMN "is_promo_locked" BOOLEAN NOT NULL DEFAULT false;

-- Track the monthly order-counter reset independently of billing_cycle_start.
-- Previously billing_cycle_start was overwritten on the 1st of each month, which
-- also corrupted grace-period / expiry date calculations (those reuse the same
-- column). The counter reset now lives here so billing_cycle_start stays the real
-- cycle anchor. Nullable so the column can be added over existing rows.
ALTER TABLE "subscriptions" ADD COLUMN "last_counter_reset" TIMESTAMP;

-- Backfill: every currently-active paid subscription was created during the
-- pre-launch promo window, so mark them as promo-locked (grandfathered).
UPDATE "subscriptions"
SET "is_promo_locked" = true
WHERE "plan_name" IN ('standard_monthly','standard_annual','growth_monthly','growth_annual','pro_monthly','pro_annual')
  AND "shopify_charge_status" = 'active';
