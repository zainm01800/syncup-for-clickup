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
    const trialEnd = new Date(trialStart.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days trial duration
    sub = await prisma.subscription.create({
      data: {
        shopDomain: shop,
        planName: "trial",
        trialStartDate: trialStart,
        trialEndDate: trialEnd,
        isTrialActive: true,
        status: "active",
        twoWaySyncEnabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await logActivity(shop, "trial_started", "7-day free trial started");
    return sub;
  }

  // Handle expired cancelled subscriptions
  if (sub.shopifyChargeStatus === "cancelled" && sub.planName !== "free" && sub.planName !== "trial") {
    const now = new Date();
    const cycleStart = sub.billingCycleStart || sub.createdAt;
    const durationDays = sub.annualBilling ? 365 : 30;
    const expirationDate = new Date(new Date(cycleStart).getTime() + durationDays * 24 * 60 * 60 * 1000);
    if (now > expirationDate) {
      if (sub.pendingPlanName) {
        const plan = PLANS[sub.pendingPlanName];
        
        // Enforce list limit downgrade for the pending plan if it's a downgrade
        const getLimitForPlan = (planName) => {
          if (planName === "trial") return 5;
          const p = PLANS[planName];
          return p ? p.listLimit : 1;
        };
        const currentLimit = getLimitForPlan(sub.planName);
        const newLimit = getLimitForPlan(sub.pendingPlanName);

        if (newLimit < currentLimit) {
          try {
            const { handleDowngradeToListLimit } = await import("./clickup.server");
            await handleDowngradeToListLimit(shop, newLimit);
          } catch (e) {
            console.error("Failed to trim lists on pending plan activation:", e);
          }
        }

        sub = await prisma.subscription.update({
          where: { shopDomain: shop },
          data: {
            planName: sub.pendingPlanName,
            shopifyChargeId: sub.pendingShopifyChargeId,
            shopifyChargeStatus: "active",
            status: "active",
            billingCycleStart: now,
            annualBilling: plan.annual,
            pendingPlanName: null,
            pendingShopifyChargeId: null,
            ordersSyncedThisMonth: 0,
          },
        });
        await logActivity(shop, "plan_activated", `Scheduled plan "${plan.name}" is now active`);
      } else {
        sub = await downgradeToFree(shop);
        await logActivity(shop, "plan_expired", "Grace period ended; transitioned to Free Plan");
      }
    }
  }

  // Handle monthly resetting of the order counter. Track the reset independently
  // (lastCounterReset) so we never overwrite billingCycleStart — that column is
  // the anchor for grace-period / expiry date math and must stay at the real
  // cycle start. Falls back to billingCycleStart for rows created before this
  // column existed.
  const resetAnchor = sub.lastCounterReset || sub.billingCycleStart;
  if (resetAnchor && isNewMonth(resetAnchor)) {
    sub = await prisma.subscription.update({
      where: { shopDomain: shop },
      data: { ordersSyncedThisMonth: 0, lastCounterReset: new Date() },
    });
    // New month = order cap reset. Re-queue any jobs that were waiting on the
    // limit so they sync now (they're excluded from the normal failed/pending
    // poll and only reactivated here).
    await prisma.syncJob.updateMany({
      where: { shopDomain: shop, status: "waiting" },
      data: { status: "pending" },
    }).catch((e) => console.error("Failed to requeue waiting jobs on reset:", e));
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

// Increment only the all-time counter on a successful sync. The monthly counter
// is managed atomically by tryReserveOrderSlot/releaseOrderSlot so burst orders
// can't exceed the plan's monthly limit (a read-then-increment in the job loop
// would race under concurrency).
export async function incrementAllTimeCount(shop) {
  await prisma.subscription.update({
    where: { shopDomain: shop },
    data: {
      ordersSyncedAllTime: { increment: 1 },
    },
  });
}

// Atomically reserve one monthly-order slot. Returns true if reserved, false if
// the shop is at its monthly cap. For capped plans the conditional UPDATE
// serializes at the row level so concurrent jobs can't overshoot the limit.
// Unlimited (Pro) and trial plans have no cap, so they always succeed — but we
// still increment the counter so the merchant's "synced this month" metric is
// accurate. Pair every successful reserve with releaseOrderSlot on failure, and
// with incrementAllTimeCount on success.
export async function tryReserveOrderSlot(shop) {
  const sub = await prisma.subscription.findUnique({ where: { shopDomain: shop } });
  if (!sub) return true;
  const plan = PLANS[sub.planName];
  const isCapped = sub.planName !== "trial" && plan && plan.monthlyOrderLimit !== null;
  if (!isCapped) {
    // Unlimited / trial: no cap to enforce, but still count the sync.
    await prisma.subscription.update({
      where: { shopDomain: shop },
      data: { ordersSyncedThisMonth: { increment: 1 } },
    });
    return true;
  }
  const result = await prisma.subscription.updateMany({
    where: { shopDomain: shop, ordersSyncedThisMonth: { lt: plan.monthlyOrderLimit } },
    data: { ordersSyncedThisMonth: { increment: 1 } },
  });
  return result.count > 0;
}

// Release a previously-reserved slot when a sync fails, so failed orders don't
// consume monthly quota. Guarded so it can never push the counter below 0.
export async function releaseOrderSlot(shop) {
  await prisma.subscription.updateMany({
    where: { shopDomain: shop, ordersSyncedThisMonth: { gt: 0 } },
    data: { ordersSyncedThisMonth: { decrement: 1 } },
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

// Returns the reason a subscription is inactive, or null if it is active.
// Mirrors isSubscriptionActive so callers (e.g. the sync job processor) can tell
// "monthly_limit" (transient — retry automatically when the counter resets) apart
// from genuinely inactive states (trial expired, cancelled, etc.).
export function getInactiveReason(subscription) {
  if (
    subscription.status === "paused" ||
    subscription.status === "expired" ||
    subscription.status === "cancelled" ||
    subscription.planName === "expired" ||
    subscription.planName === "cancelled"
  ) {
    return "inactive";
  }
  if (subscription.planName === "trial") {
    if (new Date() > new Date(subscription.trialEndDate)) return "trial_expired";
    return null;
  }
  const plan = PLANS[subscription.planName];
  if (plan && plan.monthlyOrderLimit !== null && subscription.ordersSyncedThisMonth >= plan.monthlyOrderLimit) {
    return "monthly_limit";
  }
  return null;
}

export function getTrialBannerStatus(subscription) {
  if (!subscription) return null;

  if (subscription.shopifyChargeStatus === "cancelled" && subscription.planName !== "free" && subscription.planName !== "trial") {
    const now = new Date();
    const cycleStart = subscription.billingCycleStart || subscription.createdAt;
    const durationDays = subscription.annualBilling ? 365 : 30;
    const expirationDate = new Date(new Date(cycleStart).getTime() + durationDays * 24 * 60 * 60 * 1000);
    const msRemaining = expirationDate.getTime() - now.getTime();
    const daysRemaining = Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));
    return {
      expired: false,
      color: "orange",
      message: `Your subscription is cancelled and will expire in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} on ${expirationDate.toLocaleDateString()}.`,
    };
  }

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

  const msRemaining = trialEnd.getTime() - now.getTime();
  const hoursRemaining = msRemaining / (1000 * 60 * 60);

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

export async function createShopifySubscription(admin, shop, planKey, replacementBehavior = "APPLY_IMMEDIATELY") {
  const plan = PLANS[planKey];
  if (!plan) throw new Error("Plan not found");

  const currentSub = await prisma.subscription.findUnique({
    where: { shopDomain: shop }
  });

  const chargedPrice = plan.price;

  // Calculate remaining trial days if they are upgrading from the free trial
  let trialDays = 0;
  if (currentSub && currentSub.planName === "trial" && currentSub.trialEndDate) {
    const diffMs = new Date(currentSub.trialEndDate).getTime() - Date.now();
    if (diffMs > 0) {
      trialDays = Math.max(1, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
    }
  }

  const returnUrl = `${process.env.SHOPIFY_APP_URL}/app/billing?shop=${encodeURIComponent(shop)}&activated=${planKey}&replacement_behavior=${replacementBehavior}`;
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
                ...(trialDays > 0 ? { trialDays } : {}),
              },
            },
          },
        ],
        returnUrl,
        // Use real charges in production. Set SHOPIFY_BILLING_TEST=true in .env for local sandbox testing.
        test: process.env.SHOPIFY_BILLING_TEST === "true" || shop === "syncup-test-store.myshopify.com",
        replacementBehavior: replacementBehavior,
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

  const currentSub = await prisma.subscription.findUnique({
    where: { shopDomain: shop }
  });

  let billingCycleStart = now;
  if (currentSub && currentSub.planName === "trial" && currentSub.trialEndDate && new Date(currentSub.trialEndDate) > now) {
    billingCycleStart = new Date(currentSub.trialEndDate);
  }

  return prisma.subscription.upsert({
    where: { shopDomain: shop },
    update: {
      planName: planKey,
      shopifyChargeId: chargeId,
      shopifyChargeStatus: "active",
      isTrialActive: false,
      status: "active",
      billingCycleStart: billingCycleStart,
      annualBilling: plan.annual,
      pendingPlanName: null,
      pendingShopifyChargeId: null,
    },
    create: {
      shopDomain: shop,
      planName: planKey,
      shopifyChargeId: chargeId,
      shopifyChargeStatus: "active",
      isTrialActive: false,
      status: "active",
      billingCycleStart: billingCycleStart,
      annualBilling: plan.annual,
      trialStartDate: now,
      trialEndDate: now,
      pendingPlanName: null,
      pendingShopifyChargeId: null,
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
      subtasksEnabled: false,
      twoWaySyncEnabled: false,
      taskDescriptionTemplate: null,
    },
  });
}
