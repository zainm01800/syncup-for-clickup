const json = Response.json;
import prisma from "../db.server";
import { logActivity, findConnectionByWebhookSecret } from "../clickup.server";
import { fulfillShopifyOrder } from "../fulfill.server";

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

    // Fulfill the order in Shopify via the shared routine.
    const statusLabel = event.value?.label?.text || event.value?.text;
    const result = await fulfillShopifyOrder(record.shopDomain, record.shopifyOrderId);
    if (result.ok === false && result.error === "no_token") {
      return json({ error: "No Shopify access token found" }, { status: 400 });
    }
    if (result.ok === false && result.error === "shopify_rejected") {
      console.error(`Fulfillment userErrors for order ${record.shopifyOrderId}:`, result.details);
      await logActivity(
        record.shopDomain,
        "sync_failed",
        `Monday.com marked item complete, but Shopify fulfillment failed for order #${record.orderNumber || record.shopifyOrderId}: ${result.details.join("; ")}`
      );
      return json({ ok: false, error: "Fulfillment rejected by Shopify", details: result.details }, { status: 500 });
    }
    if (result.skipped === "no_open_orders") {
      return json({ ok: true, message: "Order is already fulfilled or has no open fulfillment orders" });
    }

    // Fulfilled — update the mapping record and log.
    await prisma.orderSyncRecord.update({
      where: { id: record.id },
      data: { syncStatus: "fulfilled" }
    });

    await logActivity(
      record.shopDomain,
      "order_fulfilled",
      `Order #${record.orderNumber || record.shopifyOrderId} automatically fulfilled via Monday.com status change to '${statusLabel}'.`
    );

    return json({ ok: true, fulfilled: true });
  } catch (err) {
    console.error("Monday webhook handler error:", err);
    return json({ error: err.message }, { status: 500 });
  }
};
