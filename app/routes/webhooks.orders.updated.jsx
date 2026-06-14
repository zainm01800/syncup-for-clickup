import { authenticate } from "../shopify.server";
import {
  getConnection,
  findOrderTask,
  completeTask,
  updateOrderTaskStatus,
  withRetry,
  logActivity,
  scheduleFulfillmentRetry,
} from "../clickup.server";
import { getOrCreateSubscription, isSubscriptionActive } from "../billing.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

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

  const record = await findOrderTask(shop, String(order.id));
  if (!record || record.clickupTaskId === "failed" || record.clickupTaskId === "pending") {
    console.log(`No ClickUp task recorded for order ${order.id}; skipping`);
    return new Response();
  }

  const orderNumber = String(order.order_number ?? order.number ?? order.id);

  try {
    await withRetry(
      () => completeTask(connection.accessToken, record.clickupTaskId),
      1,
      1000
    );
    await updateOrderTaskStatus(shop, String(order.id), "fulfilled");
    logActivity(
      shop,
      "order_fulfilled",
      `Order #${orderNumber} marked complete in ClickUp`,
      String(order.id),
      record.clickupTaskId
    );
    console.log(
      `Marked ClickUp task ${record.clickupTaskId} complete for order ${order.id}`
    );
  } catch (error) {
    console.error(
      `Failed to complete ClickUp task ${record.clickupTaskId} for order ${order.id}:`,
      error
    );

    const isGrowth = subscription.planName.startsWith("growth");
    if (isGrowth) {
      logActivity(
        shop,
        "sync_retried",
        `Order #${orderNumber} fulfillment sync failed; retrying in 60 seconds...`,
        String(order.id),
        record.clickupTaskId
      );
      scheduleFulfillmentRetry(shop, String(order.id), record.clickupTaskId, orderNumber);
    } else {
      logActivity(
        shop,
        "sync_failed",
        `Order #${orderNumber} fulfillment sync failed: ${error.message}`,
        String(order.id),
        record.clickupTaskId
      );
    }
  }

  return new Response();
};
