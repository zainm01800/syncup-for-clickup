import { authenticate } from "../shopify.server";
import {
  getConnection,
  createTask,
  recordOrderTask,
  claimOrderSlot,
  withRetry,
  logActivity,
} from "../clickup.server";
import { getOrCreateSubscription, isWithinLimit, incrementOrderCount } from "../billing.server";

export const action = async ({ request }) => {
  function buildTaskDescription(order, adminOrderUrl, customerName) {
    const lines = [];

    // Customer
    lines.push("👤 Customer:");
    lines.push(`   Name:  ${customerName}`);
    const email = order.customer?.email || order.email;
    if (email) lines.push(`   Email: ${email}`);
    const phone =
      order.customer?.phone ||
      order.billing_address?.phone ||
      order.shipping_address?.phone;
    if (phone) lines.push(`   Phone: ${phone}`);
    lines.push("");

    // Line items
    lines.push("📦 Items:");
    if (order.line_items?.length > 0) {
      for (const item of order.line_items) {
        const variant = item.variant_title ? ` (${item.variant_title})` : "";
        const sku = item.sku ? ` [${item.sku}]` : "";
        lines.push(`  • ${item.quantity}x ${item.title}${variant}${sku}`);
      }
    } else {
      lines.push("  (no items)");
    }
    lines.push("");

    // Pricing + payment
    const currency = order.currency || "";
    const subtotal = order.subtotal_price ?? "0.00";
    const shippingCost =
      order.shipping_lines?.reduce(
        (sum, s) => sum + parseFloat(s.price || "0"),
        0
      ).toFixed(2) ?? "0.00";
    const total = order.total_price ?? "0.00";

    lines.push(`💰 Subtotal: ${currency} ${subtotal}`);
    lines.push(`🚚 Shipping: ${currency} ${shippingCost}`);
    lines.push(`   Total:    ${currency} ${total}`);

    const paymentStatus = order.financial_status;
    if (paymentStatus) {
      const payEmoji = paymentStatus === "paid" ? "✅" : "⏳";
      lines.push(`${payEmoji} Payment: ${paymentStatus}`);
    }
    lines.push("");

    // Shipping method + address
    if (order.shipping_lines?.length > 0) {
      const method = order.shipping_lines[0].title;
      if (method) lines.push(`📬 Ship via: ${method}`);
    }

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

    // Order notes
    if (order.note?.trim()) {
      lines.push("");
      lines.push(`📝 Notes: ${order.note.trim()}`);
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

  const claimed = await claimOrderSlot(shop, String(order.id));
  if (!claimed) {
    console.log(`Order ${order.id} already claimed by another webhook; skipping`);
    return new Response();
  }

  const orderNumber = order.order_number ?? order.number ?? order.id;
  const customerName =
    [order.customer?.first_name, order.customer?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    order.customer?.name ||
    order.billing_address?.name ||
    order.shipping_address?.name ||
    order.customer?.email ||
    order.email ||
    "Guest";

  const storeHandle = shop.replace(/\.myshopify\.com$/, "");
  const adminOrderUrl = `https://admin.shopify.com/store/${storeHandle}/orders/${order.id}`;
  const taskName = `Order #${orderNumber} — ${customerName}`;
  const description = buildTaskDescription(order, adminOrderUrl, customerName);

  const orderCreatedAt = order.created_at ? new Date(order.created_at).getTime() : Date.now();
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

  try {
    const task = await withRetry(
      () =>
        createTask(connection.accessToken, connection.listId, {
          name: taskName,
          description,
          priority: 3,                          // normal
          startDate: orderCreatedAt,
          dueDate: orderCreatedAt + twoDaysMs,
          tags: ["shopify-order"],
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
