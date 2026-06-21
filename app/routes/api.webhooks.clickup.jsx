const json = Response.json;
import prisma from "../db.server";
import { logActivity, findConnectionByWebhookSecret } from "../clickup.server";
import { fulfillShopifyOrder } from "../fulfill.server";

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

    // Fulfill the order in Shopify via the shared routine.
    const result = await fulfillShopifyOrder(record.shopDomain, record.shopifyOrderId);
    if (result.ok === false && result.error === "no_token") {
      return json({ error: "No Shopify access token found" }, { status: 400 });
    }
    if (result.ok === false && result.error === "shopify_rejected") {
      console.error(`Fulfillment userErrors for order ${record.shopifyOrderId}:`, result.details);
      await logActivity(
        record.shopDomain,
        "sync_failed",
        `ClickUp marked task complete, but Shopify fulfillment failed for order #${record.orderNumber || record.shopifyOrderId}: ${result.details.join("; ")}`
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
      `Order #${record.orderNumber || record.shopifyOrderId} automatically fulfilled via ClickUp status change to '${statusChange.after}'.`
    );

    return json({ ok: true, fulfilled: true });
  } catch (err) {
    console.error("ClickUp webhook handler error:", err);
    return json({ error: err.message }, { status: 500 });
  }
};
