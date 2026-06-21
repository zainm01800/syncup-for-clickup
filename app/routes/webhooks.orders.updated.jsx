import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // Dynamic imports for server-only modules
  const [
    { default: prisma },
    {
      getConnection,
      withRetry,
      logActivity,
      scheduleFulfillmentRetry,
    },
    { getOrCreateSubscription, isSubscriptionActive },
    { ClickUpAdapter, MondayAdapter, NotionAdapter }
  ] = await Promise.all([
    import("../db.server"),
    import("../clickup.server"),
    import("../billing.server"),
    import("../adapters/core.js")
  ]);

  const subscription = await getOrCreateSubscription(shop);
  if (!isSubscriptionActive(subscription)) {
    console.log(`Subscription is inactive for ${shop}; skipping fulfillment sync`);
    return new Response();
  }

  const order = payload;

  const connection = await getConnection(shop);
  if (!connection?.accessToken) {
    console.log(`No integration connection for ${shop}; skipping`);
    return new Response();
  }

  const record = await prisma.orderSyncRecord.findFirst({
    where: { shopDomain: shop, shopifyOrderId: String(order.id) },
    orderBy: { createdAt: "desc" }
  });

  const syncTrigger = subscription.syncTrigger || "payment_confirmed";

  if (!record) {
    // Check if we should trigger sync now based on updated order details
    let shouldSync = false;
    if (syncTrigger === "payment_confirmed" && order.financial_status === "paid") {
      shouldSync = true;
    } else if (syncTrigger === "on_fulfillment_start" && order.fulfillment_status) {
      shouldSync = true;
    } else if (syncTrigger === "on_create") {
      shouldSync = true;
    }

    if (shouldSync) {
      console.log(`Order ${order.id} matches sync trigger "${syncTrigger}" on update; creating sync job.`);
      try {
        const existingJob = await prisma.syncJob.findFirst({
          where: {
            shopDomain: shop,
            shopifyOrderId: String(order.id),
          }
        });
        if (!existingJob) {
          await prisma.syncJob.create({
            data: {
              shopDomain: shop,
              shopifyOrderId: String(order.id),
              payload: JSON.stringify(order),
              status: "pending",
            }
          });

          const host = request.headers.get("host");
          const protocol = host.includes("localhost") || host.includes("127.0.0.1") ? "http" : "https";
          const triggerUrl = `${protocol}://${host}/api/jobs/process`;

          fetch(triggerUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${process.env.SHOPIFY_API_SECRET}`
            }
          }).catch((err) => {
            console.error("Failed to trigger background jobs process:", err);
          });
        }
      } catch (dbErr) {
        console.error("Failed to create sync job on order update:", dbErr);
      }
    }
    return new Response();
  }

  if (
    record.targetRecordId === "failed" ||
    record.targetRecordId === "pending"
  ) {
    console.log(
      `Order ${order.id} has no active integration record; skipping`
    );
    return new Response();
  }

  const orderNumber = String(order.order_number ?? order.number ?? order.id);

  let adapter;
  const platform = connection.selectedPlatform || "clickup";
  if (platform === "clickup") {
    adapter = new ClickUpAdapter(connection.accessToken);
  } else if (platform === "monday") {
    adapter = new MondayAdapter(connection.accessToken);
  } else if (platform === "notion") {
    adapter = new NotionAdapter(connection.accessToken);
  }

  if (!adapter) {
    console.error(`Unsupported selectedPlatform: ${platform}`);
    return new Response();
  }

  // 1. Handle Full Fulfillment
  if (order.fulfillment_status === "fulfilled" && record.syncStatus !== "fulfilled") {
    try {
      await withRetry(
        () => adapter.completeRecord(record.targetRecordId),
        1,
        1000
      );

      try {
        await adapter.postComment(record.targetRecordId, "📦 Shopify Order fully fulfilled. Task marked complete.");
      } catch (commentErr) {
        console.error("Failed to post full fulfillment comment:", commentErr);
      }

      // Update refactored status
      try {
        await prisma.orderSyncRecord.updateMany({
          where: { shopDomain: shop, shopifyOrderId: String(order.id) },
          data: { syncStatus: "fulfilled" }
        });
      } catch (dbErr) {
        console.error("Failed to update OrderSyncRecord status:", dbErr);
      }

      logActivity(
        shop,
        "order_fulfilled",
        `Order #${orderNumber} marked complete in ${platform === "clickup" ? "ClickUp" : platform === "monday" ? "Monday.com" : "Notion"}`,
        String(order.id),
        record.targetRecordId
      );
      console.log(
        `Marked ${platform} record ${record.targetRecordId} complete for order ${order.id}`
      );

      // Mutate local status to prevent later checks from firing
      record.syncStatus = "fulfilled";
    } catch (error) {
      console.error(
        `Failed to complete record ${record.targetRecordId} for order ${order.id}:`,
        error
      );

      const hasRetryFeature = subscription.planName === "trial" || subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro");
      if (hasRetryFeature) {
        logActivity(
          shop,
          "sync_retried",
          `Order #${orderNumber} fulfillment sync failed; retrying in 60 seconds...`,
          String(order.id),
          record.targetRecordId
        );
        scheduleFulfillmentRetry(shop, String(order.id), record.targetRecordId, orderNumber);
      } else {
        logActivity(
          shop,
          "sync_failed",
          `Order #${orderNumber} fulfillment sync failed: ${error.message}`,
          String(order.id),
          record.targetRecordId
        );
      }
    }
  }
  // 2. Handle Partial Fulfillment
  else if (order.fulfillment_status === "partial" && record.syncStatus !== "partially_fulfilled" && record.syncStatus !== "fulfilled") {
    try {
      try {
        await adapter.postComment(record.targetRecordId, "📦 Shopify Order is partially fulfilled.");
      } catch (commentErr) {
        console.error("Failed to post partial fulfillment comment:", commentErr);
      }

      try {
        await prisma.orderSyncRecord.updateMany({
          where: { shopDomain: shop, shopifyOrderId: String(order.id) },
          data: { syncStatus: "partially_fulfilled" }
        });
      } catch (dbErr) {
        console.error("Failed to update OrderSyncRecord status to partially_fulfilled:", dbErr);
      }

      logActivity(
        shop,
        "order_partially_fulfilled",
        `Order #${orderNumber} partial fulfillment comment posted in ${platform === "clickup" ? "ClickUp" : platform === "monday" ? "Monday.com" : "Notion"}`,
        String(order.id),
        record.targetRecordId
      );

      record.syncStatus = "partially_fulfilled";
    } catch (error) {
      console.error(`Failed to post partial fulfillment comment for order ${order.id}:`, error);
    }
  }

  // 3. Handle Refunded
  if (order.financial_status === "refunded" && record.syncStatus !== "refunded") {
    try {
      try {
        await adapter.postComment(record.targetRecordId, "💳 Shopify Order refund processed.");
      } catch (commentErr) {
        console.error("Failed to post refund comment:", commentErr);
      }

      try {
        await prisma.orderSyncRecord.updateMany({
          where: { shopDomain: shop, shopifyOrderId: String(order.id) },
          data: { syncStatus: "refunded" }
        });
      } catch (dbErr) {
        console.error("Failed to update OrderSyncRecord status to refunded:", dbErr);
      }

      logActivity(
        shop,
        "order_refunded",
        `Order #${orderNumber} refund comment posted in ${platform === "clickup" ? "ClickUp" : platform === "monday" ? "Monday.com" : "Notion"}`,
        String(order.id),
        record.targetRecordId
      );

      record.syncStatus = "refunded";
    } catch (error) {
      console.error(`Failed to post refund comment for order ${order.id}:`, error);
    }
  }
  // 4. Handle Partially Refunded
  else if (order.financial_status === "partially_refunded" && record.syncStatus !== "partially_refunded" && record.syncStatus !== "refunded") {
    try {
      try {
        await adapter.postComment(record.targetRecordId, "💳 Shopify Order partial refund processed.");
      } catch (commentErr) {
        console.error("Failed to post partial refund comment:", commentErr);
      }

      try {
        await prisma.orderSyncRecord.updateMany({
          where: { shopDomain: shop, shopifyOrderId: String(order.id) },
          data: { syncStatus: "partially_refunded" }
        });
      } catch (dbErr) {
        console.error("Failed to update OrderSyncRecord status to partially_refunded:", dbErr);
      }

      logActivity(
        shop,
        "order_partially_refunded",
        `Order #${orderNumber} partial refund comment posted in ${platform === "clickup" ? "ClickUp" : platform === "monday" ? "Monday.com" : "Notion"}`,
        String(order.id),
        record.targetRecordId
      );

      record.syncStatus = "partially_refunded";
    } catch (error) {
      console.error(`Failed to post partial refund comment for order ${order.id}:`, error);
    }
  }

  return new Response();
};
