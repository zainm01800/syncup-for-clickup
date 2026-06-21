import prisma from "./db.server";

// Shared Shopify fulfillment routine used by the ClickUp and Monday.com two-way
// completion webhooks (external task marked done → fulfill the Shopify order).
// Centralized here so the GraphQL + userErrors handling can't drift between the
// two integrations.
//
// Returns:
//   { ok: true, fulfilled: true }                 — fulfilled successfully
//   { ok: true, skipped: "no_open_orders" }       — already fulfilled, nothing to do
//   { ok: false, error: "no_token" }              — no Shopify offline access token
//   { ok: false, error: "shopify_rejected", details: string[] } — mutation userErrors
export async function fulfillShopifyOrder(shop, shopifyOrderId) {
  const sessionRec = await prisma.session.findFirst({
    where: { shop, isOnline: false },
    select: { accessToken: true },
  });
  if (!sessionRec?.accessToken) {
    return { ok: false, error: "no_token" };
  }

  const shopifyAdminUrl = `https://${shop}/admin/api/2024-01/graphql.json`;
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": sessionRec.accessToken,
  };

  // 1. Fetch open fulfillment orders for this order.
  const getRes = await fetch(shopifyAdminUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: `
        query getFulfillmentOrders($orderId: ID!) {
          order(id: $orderId) {
            fulfillmentOrders(first: 5) { nodes { id status } }
          }
        }
      `,
      variables: { orderId: `gid://shopify/Order/${shopifyOrderId}` },
    }),
  });
  const getResJson = await getRes.json().catch(() => ({}));
  const nodes = getResJson.data?.order?.fulfillmentOrders?.nodes || [];
  const openFulfillmentOrders = nodes.filter((fo) =>
    ["OPEN", "IN_PROGRESS"].includes(fo.status)
  );
  if (openFulfillmentOrders.length === 0) {
    return { ok: true, skipped: "no_open_orders" };
  }

  // 2. Fulfill each open fulfillment order (empty line items = fulfill all).
  const fulfillMutation = `
    mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
      fulfillmentCreateV2(fulfillment: $fulfillment) {
        fulfillment { id }
        userErrors { field message }
      }
    }
  `;
  const collectedErrors = [];
  for (const fo of openFulfillmentOrders) {
    const fulfillRes = await fetch(shopifyAdminUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: fulfillMutation,
        variables: {
          fulfillment: {
            lineItemsByFulfillmentOrder: [
              { fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: [] },
            ],
          },
        },
      }),
    });
    const fulfillJson = await fulfillRes.json().catch(() => ({}));
    const userErrors = fulfillJson?.data?.fulfillmentCreateV2?.userErrors || [];
    if (userErrors.length > 0) {
      collectedErrors.push(...userErrors.map((e) => e.message));
    }
  }

  if (collectedErrors.length > 0) {
    return { ok: false, error: "shopify_rejected", details: collectedErrors };
  }
  return { ok: true, fulfilled: true };
}
