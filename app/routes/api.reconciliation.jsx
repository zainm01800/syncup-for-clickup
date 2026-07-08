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

  // 1.5 GDPR: Purge stuck sync jobs older than 7 days to protect customer PII.
  // Covers both "failed" and "waiting" (over-limit) jobs — both hold the full
  // Shopify order payload (name, email, address) and must not linger.
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const purgeResult = await prisma.syncJob.deleteMany({
      where: {
        status: { in: ["failed", "waiting"] },
        updatedAt: { lt: sevenDaysAgo }
      }
    });
    if (purgeResult.count > 0) {
      console.log(`[GDPR Cleanup] Purged ${purgeResult.count} failed sync jobs older than 7 days containing PII.`);
    }
  } catch (purgeErr) {
    console.error("Failed to run GDPR PII cleanup for failed jobs:", purgeErr);
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
      const shopResult = { shop: shopDomain, success: true };
      
      try {
        const reconResult = await reconcileShopStorefront(shopDomain);
        Object.assign(shopResult, reconResult);
      } catch (shopErr) {
        console.error(`Reconciliation failed for ${shopDomain}:`, shopErr);
        shopResult.success = false;
        shopResult.error = shopErr.message;
        
        // Mark integration health as degraded to notify the merchant via the UI
        await prisma.platformConnection.updateMany({
          where: { shopDomain, isActive: true },
          data: { healthStatus: "degraded", lastHealthCheck: new Date() }
        });
      }

      try {
        await pollNotionFulfillments(shopDomain);
      } catch (notionErr) {
        console.error(`Notion polling failed for ${shopDomain}:`, notionErr);
      }

      summary.push(shopResult);
    }

    // 3. Kick off the queue runner to execute any newly recovered sync jobs immediately
    const host = request.headers.get("host");
    const protocol = host.includes("localhost") || host.includes("127.0.0.1") ? "http" : "https";
    const triggerUrl = `${protocol}://${host}/api/jobs/process`;
    
    // Await background fetch to ensure it completes before Vercel terminates the execution context
    await fetch(triggerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.SHOPIFY_API_SECRET}`
      }
    }).catch(console.error);

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
      // Only in-flight jobs suppress re-enqueueing. Terminal/completed rows are
      // not created anymore (skipped jobs are deleted), but filtering here is
      // belt-and-suspenders so a stale row can't hide a dropped order.
      where: { shopDomain, shopifyOrderId: { in: orderIds }, status: { in: ["pending", "processing", "failed"] } },
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

/**
 * Polls connected Notion databases for completed orders and triggers Shopify fulfillment.
 */
async function pollNotionFulfillments(shopDomain) {
  // Check subscription plan & two-way sync toggle
  const sub = await prisma.subscription.findUnique({
    where: { shopDomain }
  });
  const isGrowthOrPro = sub && (sub.planName.startsWith("growth") || sub.planName.startsWith("pro") || sub.planName === "trial");
  if (!sub || !isGrowthOrPro || !sub.twoWaySyncEnabled) {
    return;
  }

  // 1. Fetch active Notion connection for this shop
  const connection = await prisma.platformConnection.findFirst({
    where: { shopDomain, provider: "NOTION", isActive: true },
  });
  if (!connection) return;

  const { decryptToken } = await import("../crypto.server");
  const accessToken = await decryptToken(connection.encryptedAccessToken);
  if (!accessToken) return;

  const { IntegrationFactory } = await import("../adapters/factory");
  const { fulfillShopifyOrder } = await import("../fulfill.server");

  const adapter = await IntegrationFactory.getAdapter("notion", accessToken);

  // 2. Fetch all active sync targets (databases)
  const syncTargets = await prisma.syncTarget.findMany({
    where: { connectionId: connection.id, isActive: true },
  });

  for (const target of syncTargets) {
    const targetResourceId = target.targetResourceId;
    let completedPages = [];

    // Query Notion for completed tasks (Status = Done/Complete/Completed or checkbox = true)
    try {
      const queryRes = await adapter.notionFetch(`/databases/${targetResourceId}/query`, {
        method: "POST",
        body: JSON.stringify({
          filter: {
            or: [
              { property: "Status", status: { equals: "Done" } },
              { property: "Status", status: { equals: "Complete" } },
              { property: "Status", status: { equals: "Completed" } },
              { property: "Completed", checkbox: { equals: true } },
              { property: "Complete", checkbox: { equals: true } },
            ],
          },
          page_size: 50,
        }),
      });
      completedPages = queryRes.results || [];
    } catch (err) {
      console.warn(`Notion filtered query failed for database ${targetResourceId}, using unfiltered fallback:`, err.message);
      try {
        const unfilteredRes = await adapter.notionFetch(`/databases/${targetResourceId}/query`, {
          method: "POST",
          body: JSON.stringify({ page_size: 50 }),
        });
        completedPages = (unfilteredRes.results || []).filter((page) => {
          const props = page.properties || {};
          const statusProp = props.Status;
          if (statusProp?.type === "status") {
            const statusName = statusProp.status?.name;
            if (["Done", "Complete", "Completed"].includes(statusName)) return true;
          }
          const completedProp = props.Completed || props.Complete;
          if (completedProp?.type === "checkbox" && completedProp.checkbox === true) return true;
          return false;
        });
      } catch (fallbackErr) {
        console.error(`Notion fallback query failed for database ${targetResourceId}:`, fallbackErr);
      }
    }

    // Process each completed page
    for (const page of completedPages) {
      const record = await prisma.orderSyncRecord.findFirst({
        where: {
          shopDomain,
          targetRecordId: page.id,
          syncStatus: { not: "fulfilled" },
        },
      });

      if (record) {
        console.log(`[Notion Outbound Sync] Found completed Notion page ${page.id} for Order ID ${record.shopifyOrderId}`);
        
        // Trigger fulfillment on Shopify
        const fulfillRes = await fulfillShopifyOrder(shopDomain, record.shopifyOrderId);
        if (fulfillRes.ok || fulfillRes.skipped === "no_open_orders") {
          // Update database record status
          await prisma.orderSyncRecord.update({
            where: { id: record.id },
            data: { syncStatus: "fulfilled" },
          });

          // Log activity
          await prisma.activityLog.create({
            data: {
              shopDomain,
              eventType: "order_fulfilled",
              description: `Shopify Order #${record.orderNumber || record.shopifyOrderId} automatically fulfilled from Notion status change.`,
              shopifyOrderId: record.shopifyOrderId,
              syncStatus: "fulfilled",
            },
          });

          // Post confirmation comment on the Notion page
          try {
            await adapter.postComment(page.id, "✅ Shopify Order automatically fulfilled.");
          } catch (commentErr) {
            console.error(`Failed to post fulfillment comment to Notion page ${page.id}:`, commentErr);
          }
        } else {
          console.error(`Failed to fulfill Shopify order ${record.shopifyOrderId} from Notion trigger:`, fulfillRes.error);
        }
      }
    }
  }
}
