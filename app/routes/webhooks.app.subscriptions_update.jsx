import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { PLANS } from "../plans";
import { logActivity, handleDowngradeToListLimit } from "../clickup.server";
import { isPromoActiveGlobally } from "../billing.server";

const PLAN_NAME_MAP = {
  "SyncUp Starter Monthly": "starter_monthly",
  "SyncUp Starter Annual": "starter_annual",
  "SyncUp Standard Monthly": "standard_monthly",
  "SyncUp Standard Annual": "standard_annual",
  "SyncUp Growth Monthly": "growth_monthly",
  "SyncUp Growth Annual": "growth_annual",
  "SyncUp Pro Monthly": "pro_monthly",
  "SyncUp Pro Annual": "pro_annual",
};

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}:`, JSON.stringify(payload));

  const appSub = payload.app_subscription;
  if (!appSub) {
    return new Response("Missing app_subscription", { status: 400 });
  }

  const shopifyStatus = appSub.status; // e.g. ACTIVE, CANCELLED, EXPIRED, DECLINED
  const shopifyName = appSub.name;
  const chargeId = appSub.admin_graphql_api_id;

  const sub = await prisma.subscription.findUnique({
    where: { shopDomain: shop },
  });

  if (shopifyStatus === "ACTIVE") {
    const planKey = PLAN_NAME_MAP[shopifyName];
    if (!planKey) {
      console.error(`Unknown plan name received: ${shopifyName}`);
      return new Response("Unknown plan name", { status: 400 });
    }

    const plan = PLANS[planKey];

    // If this matches a pending scheduled upgrade (APPLY_ON_NEXT_BILLING_CYCLE),
    // keep the current planName and store the new one as pending — don't switch yet.
    if (sub && sub.pendingPlanName === planKey) {
      await prisma.subscription.update({
        where: { shopDomain: shop },
        data: {
          pendingShopifyChargeId: chargeId,
          // Keep planName unchanged — the new plan will become active when the
          // current billing cycle ends and Shopify cancels the old subscription.
        },
      });
      logActivity(shop, "plan_upgrade_scheduled", `Plan "${plan.name}" scheduled to activate on next billing cycle`);
      return new Response();
    }

    const promoLocked = await isPromoActiveGlobally();

    await prisma.subscription.upsert({
      where: { shopDomain: shop },
      update: {
        planName: planKey,
        shopifyChargeId: chargeId,
        shopifyChargeStatus: "active",
        isTrialActive: false,
        status: "active",
        billingCycleStart: new Date(),
        annualBilling: plan.annual,
        pendingPlanName: null,
        pendingShopifyChargeId: null,
        isPromoLocked: promoLocked,
      },
      create: {
        shopDomain: shop,
        planName: planKey,
        shopifyChargeId: chargeId,
        shopifyChargeStatus: "active",
        isTrialActive: false,
        status: "active",
        billingCycleStart: new Date(),
        annualBilling: plan.annual,
        trialStartDate: new Date(),
        trialEndDate: new Date(),
        isPromoLocked: promoLocked,
      },
    });

    logActivity(shop, "plan_activated", `Plan "${plan.name}" activated successfully`);

    // Clean up lists if currently connected count exceeds new plan limit
    const newListLimit = plan.listLimit || 1;
    const removedListNames = await handleDowngradeToListLimit(shop, newListLimit);
    if (removedListNames) {
      console.log(`Plan change list limit enforcement: Removed lists: ${removedListNames}`);
    }
  } else if (shopifyStatus === "CANCELLED") {
    // Only pause/cancel if the charge matches the active subscription charge ID to prevent racing webhooks
    if (sub && sub.shopifyChargeId === chargeId) {
      await prisma.subscription.update({
        where: { shopDomain: shop },
        data: { shopifyChargeStatus: "cancelled" },
      });
      logActivity(shop, "plan_cancellation_scheduled", "Subscription cancellation scheduled; active until billing cycle ends");
    } else if (sub && sub.pendingShopifyChargeId === chargeId) {
      await prisma.subscription.update({
        where: { shopDomain: shop },
        data: {
          pendingPlanName: null,
          pendingShopifyChargeId: null,
        },
      });
      logActivity(shop, "plan_upgrade_cancelled", "Scheduled plan upgrade was cancelled before starting");
    }
  } else if (shopifyStatus === "EXPIRED" || shopifyStatus === "DECLINED") {
    if (sub && sub.shopifyChargeId === chargeId) {
      const { downgradeToFree } = await import("../billing.server");
      await downgradeToFree(shop);
      logActivity(shop, "plan_expired", `Subscription payment failed or expired (Status: ${shopifyStatus}); transitioned to Free Plan`);
    } else if (sub && sub.pendingShopifyChargeId === chargeId) {
      await prisma.subscription.update({
        where: { shopDomain: shop },
        data: {
          pendingPlanName: null,
          pendingShopifyChargeId: null,
        },
      });
      logActivity(shop, "plan_upgrade_declined", `Scheduled plan upgrade was declined or expired (Status: ${shopifyStatus})`);
    }
  }

  return new Response();
};
