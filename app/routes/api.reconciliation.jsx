import prisma from "../db.server";

/**
 * SECURE CRON ENDPOINT: /api/reconciliation
 * Triggered via Vercel Crons, GitHub Actions, or scheduled events.
 * 
 * Supports two processing modes:
 * 1. Global Scan: Reconciles all active storefront subscriptions in batches.
 * 2. Targeted Scan: Pass ?shop=mystore.myshopify.com to reconcile a single shop.
 */
export const loader = async ({ request }) => {
  return handleReconciliation(request);
};

export const action = async ({ request }) => {
  return handleReconciliation(request);
};

async function handleReconciliation(request) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") || request.headers.get("Authorization")?.replace("Bearer ", "");

  // 1. Authenticate the cron scheduler against your API secret key
  if (!secret || secret !== process.env.SHOPIFY_API_SECRET) {
    return Response.json({ ok: false, error: "Unauthorized access" }, { status: 401 });
  }

  const shopParam = url.searchParams.get("shop");
  let shopsToProcess = [];

  try {
    if (shopParam) {
      // Run targeted reconciliation for a single shop
      shopsToProcess = [shopParam];
    } else {
      // Query active, paying subscriptions to optimize system resources
      const activeSubscriptions = await prisma.subscription.findMany({
        where: {
          status: "active",
          OR: [
            { planName: { not: "trial" } },
            { trialEndDate: { gte: new Date() } }
          ]
        },
        select: { shopDomain: true },
        take: 50 // Safe batch size limit to avoid Vercel execution timeouts
      });
      shopsToProcess = activeSubscriptions.map((s) => s.shopDomain);
    }

    if (shopsToProcess.length === 0) {
      return Response.json({ ok: true, message: "No active storefronts found for reconciliation." });
    }

    const summary = [];

    // 2. Loop through eligible shops sequentially
    for (const shopDomain of shopsToProcess) {
      try {
        const result = await reconcileShopStorefront(shopDomain);
        summary.push({ shop: shopDomain, ...result });
      } catch (shopErr) {
        console.error(`Reconciliation failed for ${shopDomain}:`, shopErr);
        summary.push({ shop: shopDomain, success: false, error: shopErr.message });
        
        // Mark integration health as degraded to notify the merchant via the UI
        await prisma.platformConnection.updateMany({
          where: { shopDomain, isActive: true },
          data: { healthStatus: "degraded", lastHealthCheck: new Date() }
        });
      }
    }

    // 3. Kick off the queue runner to execute any newly recovered sync jobs immediately
    const host = request.headers.get("host");
    const protocol = host.includes("localhost") || host.includes("127.0.0.1") ? "http" : "https";
    const triggerUrl = `${protocol}://${host}/api/jobs/process?secret=${process.env.SHOPIFY_API_SECRET}`;
    
    // Await background fetch to ensure it completes before Vercel terminates the execution context
    await fetch(triggerUrl, { method: "POST", headers: { "Content-Type": "application/json" } }).catch(console.error);

    return Response.json({ ok: true, processed: summary.length, results: summary });
  } catch (globalErr) {
    console.error("Global reconciliation engine crash:", globalErr);
    return Response.json({ ok: false, error: globalErr.message }, { status: 500 });
  }
}

/**
 * Reconciles e-commerce transactions for a single store from the last 24 hours.
 */
async function reconcileShopStorefront(shopDomain) {
  // Fetch shop session credentials
  const session = await prisma.session.findFirst({
    where: { shop: shopDomain, isOnline: false },
    select: { accessToken: true }
  });

  if (!session?.accessToken) {
    throw new Error("No offline access credentials available.");
  }

  // Fetch active sync mapping parameters
  const subscription = await prisma.subscription.findUnique({
    where: { shopDomain }
  });

  const syncTrigger = subscription?.syncTrigger || "payment_confirmed";

  // Calculate the 24-hour timestamp window
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const createdAtMin = oneDayAgo.toISOString(); // ISO 8601 string format

  // 4. Request the last 24 hours of orders from Shopify using October25 API Version
  // Fields filter dramatically reduces payload size and execution overhead
  const queryFields = "id,order_number,number,financial_status,fulfillment_status,created_at,line_items,customer,email,shipping_lines,total_price,currency,note";
  const shopifyUrl = `https://${shopDomain}/admin/api/2025-10/orders.json?status=any&created_at_min=${createdAtMin}&fields=${queryFields}&limit=250`;

  const response = await fetch(shopifyUrl, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": session.accessToken,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Shopify API retrieval error: ${response.status} ${response.statusText}`);
  }

  const { orders } = await response.json();
  if (!orders || orders.length === 0) {
    return { success: true, message: "No recent orders to reconcile." };
  }

  const orderIds = orders.map((o) => String(o.id));

  // 5. Query DB to identify existing executions
  const [existingRecords, existingJobs] = await Promise.all([
    prisma.orderSyncRecord.findMany({
      where: { shopDomain, shopifyOrderId: { in: orderIds } },
      select: { shopifyOrderId: true }
    }),
    prisma.syncJob.findMany({
      where: { shopDomain, shopifyOrderId: { in: orderIds } },
      select: { shopifyOrderId: true }
    })
  ]);

  const existingRecordSet = new Set(existingRecords.map((r) => r.shopifyOrderId));
  const existingJobSet = new Set(existingJobs.map((j) => j.shopifyOrderId));

  let enqueuedCount = 0;

  // 6. Cross-reference fetched orders to find dropped webhooks
  for (const order of orders) {
    const orderIdStr = String(order.id);

    // Skip if the transaction has already been synced or is actively waiting in the queue
    if (existingRecordSet.has(orderIdStr) || existingJobSet.has(orderIdStr)) {
      continue;
    }

    // Verify if the order satisfies the merchant's active trigger constraints
    let triggerMatches = false;
    if (syncTrigger === "payment_confirmed" && order.financial_status === "paid") {
      triggerMatches = true;
    } else if (syncTrigger === "on_fulfillment_start" && order.fulfillment_status) {
      triggerMatches = true;
    } else if (syncTrigger === "on_create") {
      triggerMatches = true;
    }

    if (triggerMatches) {
      // 7. Inject recovered order into the processing queue
      await prisma.syncJob.create({
        data: {
          shopDomain,
          shopifyOrderId: orderIdStr,
          payload: JSON.stringify(order),
          status: "pending"
        }
      });

      // Log the event with dynamic, clear messaging for the merchant feed
      await prisma.activityLog.create({
        data: {
          shopDomain,
          eventType: "order_reconciled",
          description: `[Reconciliation Engine] Automatically recovered dropped webhook for Order #${order.order_number || orderIdStr}.`,
          shopifyOrderId: orderIdStr,
          syncStatus: "synced"
        }
      });

      enqueuedCount++;
    }
  }

  // Update integration connection status as healthy
  await prisma.platformConnection.updateMany({
    where: { shopDomain, isActive: true },
    data: { healthStatus: "healthy", lastHealthCheck: new Date() }
  });

  return { success: true, totalFound: orders.length, recovered: enqueuedCount };
}
