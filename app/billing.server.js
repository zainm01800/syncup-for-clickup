import prisma from "./db.server";
export { PLANS } from "./plans";

function isNewMonth(date) {
  const now = new Date();
  const d = new Date(date);
  return (
    now.getMonth() !== d.getMonth() || now.getFullYear() !== d.getFullYear()
  );
}

export async function getOrCreateSubscription(shop) {
  let sub = await prisma.subscription.findUnique({
    where: { shopDomain: shop },
  });

  if (!sub) {
    sub = await prisma.subscription.create({
      data: { shopDomain: shop, billingCycleStart: new Date() },
    });
    return sub;
  }

  if (isNewMonth(sub.billingCycleStart)) {
    sub = await prisma.subscription.update({
      where: { shopDomain: shop },
      data: { ordersThisMonth: 0, billingCycleStart: new Date() },
    });
  }

  return sub;
}

export async function incrementOrderCount(shop) {
  await prisma.subscription.upsert({
    where: { shopDomain: shop },
    update: { ordersThisMonth: { increment: 1 } },
    create: {
      shopDomain: shop,
      ordersThisMonth: 1,
      billingCycleStart: new Date(),
    },
  });
}

export function isWithinLimit(subscription) {
  const plan = PLANS[subscription.planName] ?? PLANS.free;
  if (plan.monthlyOrderLimit === null) return true;
  return subscription.ordersThisMonth < plan.monthlyOrderLimit;
}

export async function createShopifySubscription(admin, shop, planKey) {
  const plan = PLANS[planKey];
  if (!plan || plan.price === 0)
    throw new Error("Cannot create a charge for the Free plan.");

  const returnUrl = `${process.env.SHOPIFY_APP_URL}/app/billing?activated=${planKey}`;

  const res = await admin.graphql(
    `#graphql
    mutation CreateSubscription(
      $name: String!
      $lineItems: [AppSubscriptionLineItemInput!]!
      $returnUrl: URL!
      $test: Boolean
    ) {
      appSubscriptionCreate(
        name: $name
        lineItems: $lineItems
        returnUrl: $returnUrl
        test: $test
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
                price: { amount: plan.price.toFixed(2), currencyCode: "USD" },
                interval: "EVERY_30_DAYS",
              },
            },
          },
        ],
        returnUrl,
        test: false,
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
  return prisma.subscription.upsert({
    where: { shopDomain: shop },
    update: { planName: planKey, shopifyChargeId: chargeId, status: "active" },
    create: {
      shopDomain: shop,
      planName: planKey,
      shopifyChargeId: chargeId,
      status: "active",
      billingCycleStart: new Date(),
    },
  });
}

export async function downgradeToFree(shop) {
  return prisma.subscription.upsert({
    where: { shopDomain: shop },
    update: { planName: "free", shopifyChargeId: null, status: "active" },
    create: {
      shopDomain: shop,
      planName: "free",
      status: "active",
      billingCycleStart: new Date(),
    },
  });
}
