import prisma from "./db.server";
import { PLANS } from "./plans";
export { PLANS };

function isNewMonth(date) {
  if (!date) return false;
  const now = new Date();
  const d = new Date(date);
  return (
    now.getMonth() !== d.getMonth() || now.getFullYear() !== d.getFullYear()
  );
}

async function logActivity(shop, eventType, description) {
  await prisma.activityLog
    .create({ data: { shopDomain: shop, eventType, description } })
    .catch((e) => console.error("Billing logActivity failed:", e));
}

export async function getOrCreateSubscription(shop) {
  let sub = await prisma.subscription.findUnique({
    where: { shopDomain: shop },
  });

  if (!sub) {
    const trialStart = new Date();
    const trialEnd = new Date(trialStart.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days under the hood for review safety
    sub = await prisma.subscription.create({
      data: {
        shopDomain: shop,
        planName: "trial",
        trialStartDate: trialStart,
        trialEndDate: trialEnd,
        isTrialActive: true,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await logActivity(shop, "trial_started", "7-day free trial started");
    return sub;
  }

  // Handle monthly resetting of sync count for active subscriptions
  if (sub.billingCycleStart && isNewMonth(sub.billingCycleStart)) {
    sub = await prisma.subscription.update({
      where: { shopDomain: shop },
      data: { ordersSyncedThisMonth: 0, billingCycleStart: new Date() },
    });
  }

  // Also verify if trial has expired and transition state
  if (sub.planName === "trial" && sub.status === "active") {
    const now = new Date();
    if (now > sub.trialEndDate) {
      try {
        const { handleDowngradeToListLimit } = await import("./clickup.server");
        await handleDowngradeToListLimit(shop, 1);
      } catch (e) {
        console.error("Failed to trim lists on trial end:", e);
      }

      sub = await prisma.subscription.update({
        where: { shopDomain: shop },
        data: {
          planName: "free",
          status: "active",
          isTrialActive: false,
          billingCycleStart: now,
          ordersSyncedThisMonth: 0,
        },
      });
      await logActivity(shop, "trial_expired", "Free trial expired; transitioned to Free Plan (5 orders/mo limit)");
    }
  }

  return sub;
}

export async function incrementOrderCount(shop) {
  await prisma.subscription.update({
    where: { shopDomain: shop },
    data: {
      ordersSyncedThisMonth: { increment: 1 },
      ordersSyncedAllTime: { increment: 1 },
    },
  });
}

export function isSubscriptionActive(subscription) {
  if (
    subscription.status === "paused" ||
    subscription.status === "expired" ||
    subscription.status === "cancelled" ||
    subscription.planName === "expired" ||
    subscription.planName === "cancelled"
  ) {
    return false;
  }
  if (subscription.planName === "trial") {
    const now = new Date();
    if (now > new Date(subscription.trialEndDate)) {
      return false;
    }
  } else {
    const plan = PLANS[subscription.planName];
    if (plan && plan.monthlyOrderLimit !== null) {
      if (subscription.ordersSyncedThisMonth >= plan.monthlyOrderLimit) {
        return false;
      }
    }
  }
  return true;
}

export function getTrialBannerStatus(subscription) {
  if (!subscription) return null;

  if (subscription.planName === "free") {
    const plan = PLANS.free;
    if (subscription.ordersSyncedThisMonth >= plan.monthlyOrderLimit) {
      return {
        expired: true,
        color: "red",
        message: `Monthly order limit reached (${subscription.ordersSyncedThisMonth}/${plan.monthlyOrderLimit} orders synced). Upgrade to keep syncing.`,
      };
    }
    return {
      expired: false,
      color: "green",
      message: `Free Plan active — ${subscription.ordersSyncedThisMonth}/${plan.monthlyOrderLimit} orders synced this month.`,
    };
  }

  // Check paid plan monthly order limits
  if (subscription.planName !== "trial" && subscription.planName !== "expired" && subscription.planName !== "cancelled") {
    const plan = PLANS[subscription.planName];
    if (plan && plan.monthlyOrderLimit !== null) {
      if (subscription.ordersSyncedThisMonth >= plan.monthlyOrderLimit) {
        return {
          expired: true,
          color: "red",
          message: `Monthly order limit reached (${subscription.ordersSyncedThisMonth}/${plan.monthlyOrderLimit} orders synced). Upgrade to keep syncing.`,
        };
      }
    }
  }

  if (
    subscription.status === "expired" ||
    subscription.planName === "expired" ||
    subscription.status === "cancelled" ||
    subscription.planName === "cancelled"
  ) {
    return {
      expired: true,
      color: "red",
      message: "Syncing is paused — upgrade to resume",
    };
  }

  if (subscription.planName !== "trial") return null;

  const now = new Date();
  const trialStart = new Date(subscription.trialStartDate);
  const trialEnd = new Date(subscription.trialEndDate);

  if (now > trialEnd) {
    return {
      expired: true,
      color: "red",
      message: "Syncing is paused — upgrade to resume",
    };
  }

  // Calculate virtual warning remaining hours based on a 7-day virtual trial
  const virtualTrialEnd = new Date(trialStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const msRemaining = virtualTrialEnd.getTime() - now.getTime();
  const hoursRemaining = msRemaining / (1000 * 60 * 60);

  if (hoursRemaining <= 0) {
    // Virtual 7 days is over, but actual 30-day trial is still active.
    // Return null so the merchant sees a clean active dashboard and can keep testing.
    return null;
  }

  if (hoursRemaining <= 24) {
    return {
      expired: false,
      color: "red",
      message: "Your free trial expires today.",
    };
  } else if (hoursRemaining <= 48) {
    return {
      expired: false,
      color: "orange",
      message: "Your free trial ends tomorrow.",
    };
  } else if (hoursRemaining <= 72) {
    return {
      expired: false,
      color: "yellow",
      message: "Your free trial ends in 2 days. Choose a plan to keep syncing.",
    };
  } else {
    const days = Math.ceil(hoursRemaining / 24);
    return {
      expired: false,
      color: "green",
      message: `Trial active — ${days} days remaining`,
    };
  }
}

export async function createShopifySubscription(admin, shop, planKey) {
  const plan = PLANS[planKey];
  if (!plan) throw new Error("Plan not found");

  const activePaidCount = await prisma.subscription.count({
    where: {
      planName: {
        notIn: ["trial", "free", "expired", "cancelled"],
      },
    },
  });
  const isPromoActive = activePaidCount < 10;
  
  let chargedPrice = plan.price;
  if (!isPromoActive && planKey !== "free") {
    chargedPrice = plan.regularPrice || plan.price;
  }

  const returnUrl = `${process.env.SHOPIFY_APP_URL}/app/billing?activated=${planKey}`;
  const interval = plan.interval; // ANNUAL or EVERY_30_DAYS

  const res = await admin.graphql(
    `#graphql
    mutation CreateSubscription(
      $name: String!
      $lineItems: [AppSubscriptionLineItemInput!]!
      $returnUrl: URL!
      $test: Boolean
      $replacementBehavior: AppSubscriptionReplacementBehavior
    ) {
      appSubscriptionCreate(
        name: $name
        lineItems: $lineItems
        returnUrl: $returnUrl
        test: $test
        replacementBehavior: $replacementBehavior
      ) {
        appSubscription {
          id
          status
        }
        confirmationUrl
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        name: plan.shopifyPlanName,
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: { amount: parseFloat(chargedPrice.toFixed(2)), currencyCode: "USD" },
                interval: interval,
              },
            },
          },
        ],
        returnUrl,
        test: true, // test mode enabled
        replacementBehavior: "APPLY_IMMEDIATELY",
      },
    }
  );

  const { data } = await res.json();
  const result = data?.appSubscriptionCreate;

  if (result?.userErrors?.length > 0) {
    throw new Error(result.userErrors.map((e) => e.message).join(", "));
  }

  return {
    confirmationUrl: result.confirmationUrl,
    chargeId: result.appSubscription?.id,
  };
}

export async function cancelExistingSubscription(admin, chargeId) {
  if (!chargeId) return;
  try {
    await admin.graphql(
      `#graphql
      mutation CancelSubscription($id: ID!) {
        appSubscriptionCancel(id: $id) {
          appSubscription { id status }
          userErrors { field message }
        }
      }`,
      { variables: { id: chargeId } }
    );
  } catch (e) {
    console.error("Error cancelling Shopify subscription:", e);
  }
}

export async function activateSubscription(shop, planKey, chargeId) {
  const plan = PLANS[planKey];
  const now = new Date();

  return prisma.subscription.upsert({
    where: { shopDomain: shop },
    update: {
      planName: planKey,
      shopifyChargeId: chargeId,
      shopifyChargeStatus: "active",
      isTrialActive: false,
      status: "active",
      billingCycleStart: now,
      annualBilling: plan.annual,
    },
    create: {
      shopDomain: shop,
      planName: planKey,
      shopifyChargeId: chargeId,
      shopifyChargeStatus: "active",
      isTrialActive: false,
      status: "active",
      billingCycleStart: now,
      annualBilling: plan.annual,
      trialStartDate: now,
      trialEndDate: now,
    },
  });
}

export async function downgradeToFree(shop) {
  try {
    const { handleDowngradeToListLimit } = await import("./clickup.server");
    await handleDowngradeToListLimit(shop, 1);
  } catch (e) {
    console.error("Failed to trim lists on downgrade to free:", e);
  }

  return prisma.subscription.update({
    where: { shopDomain: shop },
    data: {
      planName: "free",
      shopifyChargeId: null,
      shopifyChargeStatus: null,
      status: "active",
      billingCycleStart: new Date(),
      ordersSyncedThisMonth: 0,
    },
  });
}
