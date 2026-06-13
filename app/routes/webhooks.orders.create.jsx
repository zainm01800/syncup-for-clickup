import { authenticate } from "../shopify.server";
import {
  getConnection,
  createTask,
  recordOrderTask,
  withRetry,
  logActivity,
} from "../clickup.server";
import { getOrCreateSubscription, isWithinLimit, incrementOrderCount } from "../billing.server";

export const action = async ({ request }) => {
  function buildTaskDescription(order, adminOrderUrl) {
    const lines = [];

    lines.push("📦 Line items:");
    if (order.line_items?.length > 0) {
      for (const item of order.line_items) {
        const variant = item.variant_title ? ` (${item.variant_title})` : "";
        lines.push(`  • ${item.quantity}x ${item.title}${variant}`);
      }
    } else {
      lines.push("  (no items)");
    }

    lines.push("");

    const currency = order.currency || "";
    const subtotal = order.subtotal_price ?? "0.00";
    const shipping =
      order.shipping_lines?.reduce(
        (sum, s) => sum + parseFloat(s.price || "0"),
        0
      ).toFixed(2) ?? "0.00";
    const total = order.total_price ?? "0.00";

    lines.push(`💰 Subtotal: ${currency} ${subtotal}`);
    lines.push(`🚚 Shipping: ${currency} ${shipping}`);
    lines.push(`   Total:    ${currency} ${total}`);
    lines.push("");

    const email = order.customer?.email || order.email || null;
    if (email) lines.push(`📧 Customer: ${email}`);

    const addr = order.shipping_address;
    if (addr) {
      const addrParts = [
        addr.address1,
        addr.address2,
        [addr.city, addr.province_code || addr.province, addr.zip]
          .filter(Boolean)
          .join(", "),
        addr.country,
      ].filter(Boolean);
      lines.push(`📍 Ship to: ${addrParts.join(", ")}`);
    }

    lines.push("");
    lines.push(`🔗 View order: ${adminOrderUrl}`);

    return lines.join("\n");
  }

  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const subscription = await getOrCreateSubscription(shop);
  if (!isWithinLimit(subscription)) {
    console.log(`Free tier limit reached for ${shop}; skipping order ${payload.id}`);
    return new Response();
  }

  const connection = await getConnection(shop);
  if (!connection?.accessToken || !connection.listId) {
    console.log(`No ClickUp list configured for ${shop}; skipping order ${payload.id}`);
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

  const storeHandle = shop.replace(/\.myshopify\.com$/, "");
  const adminOrderUrl = `https://admin.shopify.com/store/${storeHandle}/orders/${order.id}`;
  const taskName = `Order #${orderNumber} — ${customerName}`;
  const description = buildTaskDescription(order, adminOrderUrl);

  try {
    const task = await withRetry(
      () =>
        createTask(connection.accessToken, connection.listId, {
          name: taskName,
          description,
        }),
      1,    // one retry
      1000  // 1-second delay (5-second delay would exceed Shopify's 5s limit)
    );
    await recordOrderTask(shop, String(order.id), task.id, "synced");
    await incrementOrderCount(shop);
    logActivity(
      shop,
      "order_synced",
      `Order #${orderNumber} (${customerName}) synced to ClickUp`
    );
    console.log(`Created ClickUp task ${task.id} for order ${order.id}`);
  } catch (error) {
    console.error(`Failed to create ClickUp task for order ${order.id}:`, error);
    // Record a failed task entry so we have a trace
    await recordOrderTask(shop, String(order.id), "failed", "failed").catch(() => {});
    logActivity(
      shop,
      "sync_failed",
      `Order #${orderNumber} (${customerName}) — sync failed: ${error.message}`
    );
  }

  return new Response();
};
