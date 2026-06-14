import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { PLANS } from "../plans";
import { logActivity, handleDowngradeToListLimit } from "../clickup.server";

const PLAN_NAME_MAP = {
  "SyncUp Starter Monthly": "starter_monthly",
  "SyncUp Starter Annual": "starter_annual",
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
    const isDowngrade = sub && sub.planName.startsWith("growth") && planKey.startsWith("starter");

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
      },
    });

    logActivity(shop, "plan_activated", `Plan "${plan.name}" activated successfully`);

    // Clean up lists if currently connected count exceeds new plan limit
    const newListLimit = plan.listLimit || 1;
    const removedListNames = await handleDowngradeToListLimit(shop, newListLimit);
    if (removedListNames) {
      console.log(`Plan change list limit enforcement: Removed lists: ${removedListNames}`);
    }
  } else if (shopifyStatus === "CANCELLED" || shopifyStatus === "EXPIRED" || shopifyStatus === "DECLINED") {
    // Only pause/cancel if the charge matches the active subscription charge ID to prevent racing webhooks
    if (sub && sub.shopifyChargeId === chargeId) {
      const { downgradeToFree } = await import("../billing.server");
      await downgradeToFree(shop);
      logActivity(shop, "plan_cancelled", `Subscription cancelled (Status: ${shopifyStatus}); transitioned to Free Plan`);
    }
  }

  return new Response();
};
