const json = Response.json;
import prisma from "../db.server";
import { logActivity, findConnectionByWebhookSecret } from "../clickup.server";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  // Authenticate the callback via the per-connection secret embedded in the URL.
  // ClickUp POSTs to the exact registered endpoint, which includes ?token=<secret>.
  const token = new URL(request.url).searchParams.get("token");
  const connection = await findConnectionByWebhookSecret(token, "CLICKUP");
  if (!connection) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = await request.json();

    const taskId = payload.task_id;
    if (!taskId) {
      return json({ ok: true, message: "No task_id in payload" });
    }

    // Find history status change
    const statusChange = payload.history_items?.find(item => item.field === "status");
    if (!statusChange) {
      return json({ ok: true, message: "No status change in payload" });
    }

    const afterStatus = String(statusChange.after || "").toLowerCase().trim();
    // EXACT (case-insensitive) match against done-like status names. Substring
    // matching here is dangerous — "incomplete", "undone", or "not done" would
    // all trigger an auto-fulfill (charging the customer + shipping). Merchants
    // should name their ClickUp "done" status to match one of these (a
    // configurable completion status is a future enhancement).
    const completeKeywords = ["complete", "completed", "closed", "done", "shipped", "fulfilled", "ready to ship", "delivered"];
    const isCompleted = completeKeywords.includes(afterStatus);

    if (!isCompleted) {
      return json({ ok: true, message: `Status '${afterStatus}' is not a fulfillment trigger` });
    }

    // Look up OrderSyncRecord, scoped to the authenticated connection's shop so a
    // secret can't be used against another shop's records.
    const record = await prisma.orderSyncRecord.findFirst({
      where: { targetRecordId: taskId, shopDomain: connection.shopDomain }
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

    let hadUserErrors = false;
    const collectedErrors = [];
    for (const fo of openFulfillmentOrders) {
      const fulfillRes = await fetch(shopifyAdminUrl, {
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
      const fulfillJson = await fulfillRes.json().catch(() => ({}));
      const userErrors = fulfillJson?.data?.fulfillmentCreateV2?.userErrors || [];
      if (userErrors.length > 0) {
        hadUserErrors = true;
        collectedErrors.push(...userErrors.map((e) => e.message));
      }
    }

    if (hadUserErrors) {
      // Do NOT mark the record fulfilled — the Shopify mutation rejected it.
      console.error(`Fulfillment userErrors for order ${record.shopifyOrderId}:`, collectedErrors);
      await logActivity(
        record.shopDomain,
        "sync_failed",
        `ClickUp marked task complete, but Shopify fulfillment failed for order #${record.orderNumber || record.shopifyOrderId}: ${collectedErrors.join("; ")}`
      );
      return json({ ok: false, error: "Fulfillment rejected by Shopify", details: collectedErrors }, { status: 500 });
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
