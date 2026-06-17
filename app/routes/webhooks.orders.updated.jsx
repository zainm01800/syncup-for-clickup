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

  if (order.fulfillment_status !== "fulfilled") {
    console.log(
      `Order ${order.id} not fulfilled (status: ${order.fulfillment_status}); skipping`
    );
    return new Response();
  }

  const connection = await getConnection(shop);
  if (!connection?.accessToken) {
    console.log(`No ClickUp connection for ${shop}; skipping`);
    return new Response();
  }

  const record = await prisma.orderSyncRecord.findFirst({
    where: { shopDomain: shop, shopifyOrderId: String(order.id) },
    orderBy: { createdAt: "desc" }
  });
  if (
    !record ||
    record.syncStatus === "fulfilled" ||
    record.targetRecordId === "failed" ||
    record.targetRecordId === "pending"
  ) {
    console.log(
      `Order ${order.id} is already fulfilled or has no active integration record; skipping`
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

  try {
    if (!adapter) {
      throw new Error(`Unsupported selectedPlatform: ${platform}`);
    }

    await withRetry(
      () => adapter.completeRecord(record.targetRecordId),
      1,
      1000
    );

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
      `Order #${orderNumber} marked complete in ${connection.selectedPlatform === "clickup" ? "ClickUp" : connection.selectedPlatform === "monday" ? "Monday.com" : "Notion"}`,
      String(order.id),
      record.targetRecordId
    );
    console.log(
      `Marked ${connection.selectedPlatform} record ${record.targetRecordId} complete for order ${order.id}`
    );
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

  return new Response();
};
