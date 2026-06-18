const json = Response.json;
import prisma from "../db.server";
import { logActivity } from "../clickup.server";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const payload = await request.json();
    console.log("Received ClickUp webhook payload:", JSON.stringify(payload));

    const taskId = payload.task_id;
    if (!taskId) {
      return json({ ok: true, message: "No task_id in payload" });
    }

    // Find history status change
    const statusChange = payload.history_items?.find(item => item.field === "status");
    if (!statusChange) {
      return json({ ok: true, message: "No status change in payload" });
    }

    const afterStatus = String(statusChange.after || "").toLowerCase();
    const completeKeywords = ["complete", "closed", "done", "shipped", "fulfilled", "ready to ship"];
    const isCompleted = completeKeywords.some(kw => afterStatus.includes(kw));

    if (!isCompleted) {
      return json({ ok: true, message: `Status '${afterStatus}' is not a fulfillment trigger` });
    }

    // Look up OrderSyncRecord
    const record = await prisma.orderSyncRecord.findFirst({
      where: { targetRecordId: taskId }
    });

    if (!record) {
      return json({ ok: true, message: `No Shopify order record mapped to ClickUp task ${taskId}` });
    }

    // Check subscription plan & two-way sync toggle
    const sub = await prisma.subscription.findUnique({
      where: { shopDomain: record.shopDomain }
    });

    const isGrowthOrPro = sub && (sub.planName.startsWith("growth") || sub.planName.startsWith("pro") || sub.planName === "trial");
    if (!sub || !isGrowthOrPro || !sub.twoWaySyncEnabled) {
      return json({ ok: true, message: "Two-way sync is not enabled or supported by your current plan" });
    }

    // Fulfill order in Shopify
    const sessionRec = await prisma.session.findFirst({
      where: { shop: record.shopDomain, isOnline: false }
    });

    if (!sessionRec?.accessToken) {
      return json({ error: "No Shopify access token found" }, { status: 400 });
    }

    const shopifyAdminUrl = `https://${record.shopDomain}/admin/api/2024-01/graphql.json`;

    // 1. Fetch fulfillment orders
    const getFulfillmentOrdersQuery = `
      query getFulfillmentOrders($orderId: ID!) {
        order(id: $orderId) {
          fulfillmentOrders(first: 5) {
            nodes {
              id
              status
            }
          }
        }
      }
    `;

    const getRes = await fetch(shopifyAdminUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": sessionRec.accessToken
      },
      body: JSON.stringify({
        query: getFulfillmentOrdersQuery,
        variables: { orderId: `gid://shopify/Order/${record.shopifyOrderId}` }
      })
    });

    const getResJson = await getRes.json();
    const nodes = getResJson.data?.order?.fulfillmentOrders?.nodes || [];
    const openFulfillmentOrders = nodes.filter(fo => ["OPEN", "IN_PROGRESS"].includes(fo.status));

    if (openFulfillmentOrders.length === 0) {
      return json({ ok: true, message: "Order is already fulfilled or has no open fulfillment orders" });
    }

    // 2. Fulfill each open fulfillment order
    const fulfillMutation = `
      mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
        fulfillmentCreateV2(fulfillment: $fulfillment) {
          fulfillment {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    for (const fo of openFulfillmentOrders) {
      await fetch(shopifyAdminUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": sessionRec.accessToken
        },
        body: JSON.stringify({
          query: fulfillMutation,
          variables: {
            fulfillment: {
              lineItemsByFulfillmentOrder: [
                {
                  fulfillmentOrderId: fo.id,
                  fulfillmentOrderLineItems: [] // empty fulfills all
                }
              ]
            }
          }
        })
      });
    }

    // Update status & log
    await prisma.orderSyncRecord.update({
      where: { id: record.id },
      data: { syncStatus: "fulfilled" }
    });

    await logActivity(
      record.shopDomain,
      "order_fulfilled",
      `Order #${record.orderNumber || record.shopifyOrderId} automatically fulfilled via ClickUp status change to '${statusChange.after}'.`
    );

    return json({ ok: true, fulfilled: true });
  } catch (err) {
    console.error("ClickUp webhook handler error:", err);
    return json({ error: err.message }, { status: 500 });
  }
};
