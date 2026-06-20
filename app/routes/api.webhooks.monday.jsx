const json = Response.json;
import prisma from "../db.server";
import { logActivity, findConnectionByWebhookSecret } from "../clickup.server";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  // Authenticate the callback via the per-connection secret embedded in the URL.
  // Monday POSTs (including the verification challenge) to the exact registered
  // endpoint, which includes ?token=<secret>.
  const token = new URL(request.url).searchParams.get("token");
  const connection = await findConnectionByWebhookSecret(token, "MONDAY");
  if (!connection) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = await request.json();

    // 1. Monday.com Webhook URL verification handshake
    if (payload.challenge) {
      return json({ challenge: payload.challenge });
    }

    const event = payload.event;
    if (!event) {
      return json({ ok: true, message: "No event payload found" });
    }

    const pulseId = String(event.pulseId || "");
    if (!pulseId) {
      return json({ ok: true, message: "No pulseId in event" });
    }

    // Determine status text
    let newStatusLabel = "";
    if (event.value?.label?.text) {
      newStatusLabel = String(event.value.label.text).toLowerCase();
    } else if (event.value?.text) {
      newStatusLabel = String(event.value.text).toLowerCase();
    }

    if (!newStatusLabel) {
      return json({ ok: true, message: "No status text resolved" });
    }

    // EXACT (case-insensitive) match against done-like status labels. Substring
    // matching is dangerous here — "incomplete", "undone", or "not done" would
    // all auto-fulfill the order (newStatusLabel is already lowercased above).
    const completeKeywords = ["complete", "completed", "closed", "done", "shipped", "fulfilled", "ready to ship", "delivered"];
    const isCompleted = completeKeywords.includes(newStatusLabel.trim());

    if (!isCompleted) {
      return json({ ok: true, message: `Status '${newStatusLabel}' is not a fulfillment trigger` });
    }

    // Look up OrderSyncRecord, scoped to the authenticated connection's shop so a
    // secret can't be used against another shop's records.
    const record = await prisma.orderSyncRecord.findFirst({
      where: { targetRecordId: pulseId, shopDomain: connection.shopDomain }
    });

    if (!record) {
      return json({ ok: true, message: `No Shopify order record mapped to Monday item ${pulseId}` });
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

    // Fetch fulfillment orders
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

    // Fulfill open fulfillment orders
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
                  fulfillmentOrderLineItems: []
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
      console.error(`Fulfillment userErrors for order ${record.shopifyOrderId}:`, collectedErrors);
      await logActivity(
        record.shopDomain,
        "sync_failed",
        `Monday.com marked item complete, but Shopify fulfillment failed for order #${record.orderNumber || record.shopifyOrderId}: ${collectedErrors.join("; ")}`
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
      `Order #${record.orderNumber || record.shopifyOrderId} automatically fulfilled via Monday.com status change to '${event.value?.label?.text || event.value?.text}'.`
    );

    return json({ ok: true, fulfilled: true });
  } catch (err) {
    console.error("Monday webhook handler error:", err);
    return json({ error: err.message }, { status: 500 });
  }
};
