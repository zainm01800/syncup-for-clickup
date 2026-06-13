import { authenticate } from "../shopify.server";
import { getConnection, createTask, recordOrderTask } from "../clickup.server";
import {
  getOrCreateSubscription,
  isWithinLimit,
  incrementOrderCount,
} from "../billing.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const subscription = await getOrCreateSubscription(shop);
  if (!isWithinLimit(subscription)) {
    console.log(
      `Free tier limit reached for ${shop}; skipping order ${payload.id}`
    );
    return new Response();
  }

  const connection = await getConnection(shop);
  if (!connection?.accessToken || !connection.listId) {
    console.log(
      `No ClickUp list configured for ${shop}; skipping order ${payload.id}`
    );
    return new Response();
  }

  const order = payload;
  const orderNumber = order.order_number ?? order.number ?? order.id;
  const customerName =
    [order.customer?.first_name, order.customer?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    order.billing_address?.name ||
    order.shipping_address?.name ||
    order.email ||
    "Guest";

  const lineItems = (order.line_items || [])
    .map((item) => `- ${item.quantity}x ${item.title}`)
    .join("\n");

  const storeHandle = shop.replace(/\.myshopify\.com$/, "");
  const adminOrderUrl = `https://admin.shopify.com/store/${storeHandle}/orders/${order.id}`;

  const taskName = `Order #${orderNumber} - ${customerName}`;
  const description = [
    "Line items:",
    lineItems || "- (none)",
    "",
    `Order total: ${order.total_price ?? "0.00"} ${order.currency || ""}`.trim(),
    "",
    `View order: ${adminOrderUrl}`,
  ].join("\n");

  try {
    const task = await createTask(connection.accessToken, connection.listId, {
      name: taskName,
      description,
    });
    await recordOrderTask(shop, String(order.id), task.id);
    await incrementOrderCount(shop);
    console.log(`Created ClickUp task ${task.id} for order ${order.id}`);
  } catch (error) {
    console.error(
      `Failed to create ClickUp task for order ${order.id}:`,
      error
    );
  }

  return new Response();
};
