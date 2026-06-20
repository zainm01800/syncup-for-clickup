/* global process */

export const loader = async ({ request }) => {
  return handleJobProcess(request);
};

export const action = async ({ request }) => {
  return handleJobProcess(request);
};

// Boundary-aware, case-insensitive match for a single keyword token against a
// field value. "cat" matches "cat toy", "cat-toy", "red cat", "TSHIRT-CAT-001"
// but NOT "category", "education", or "scat" — boundaries are start/end of string
// or any non-alphanumeric character (spaces, hyphens, slashes, parentheses, …).
function keywordMatches(kw, text) {
  if (!kw || !text) return false;
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

// Helper function to check if order satisfies routing constraints
function satisfiesRoutingConstraints(targetConn, order) {
  // 1. Tag constraint
  if (targetConn.routingTag && targetConn.routingTag.trim()) {
    const tag = targetConn.routingTag.trim().toLowerCase();
    
    // Check order tags (comma separated string)
    const orderTags = order.tags ? order.tags.split(",").map(t => t.trim().toLowerCase()) : [];
    const hasOrderTagMatch = orderTags.includes(tag);
    
    // Check line items product tags if available
    const lineItems = order.line_items || [];
    const hasLineTagMatch = lineItems.some(
      (item) =>
        item.product_tags &&
        String(item.product_tags).toLowerCase().includes(tag)
    );
    
    if (!hasOrderTagMatch && !hasLineTagMatch) return false;
  }

  // 2. Location constraint
  if (targetConn.routingLocationId && targetConn.routingLocationId.trim()) {
    const locId = targetConn.routingLocationId.trim();
    const lineItems = order.line_items || [];
    const hasLocationMatch = lineItems.some(
      (item) => String(item.location_id) === locId
    );
    if (!hasLocationMatch) return false;
  }

  // 3. Keyword constraint — comma-separated terms (OR'd), boundary-aware match.
  if (targetConn.keyword && targetConn.keyword.trim()) {
    const terms = targetConn.keyword
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    const lineItems = order.line_items || [];
    const hasKeywordMatch =
      terms.length > 0 &&
      lineItems.some((item) => {
        const title = (item.title || "").toLowerCase();
        const vendor = (item.vendor || "").toLowerCase();
        const sku = (item.sku || "").toLowerCase();
        return terms.some((kw) => keywordMatches(kw, title) || keywordMatches(kw, vendor) || keywordMatches(kw, sku));
      });
    if (!hasKeywordMatch) return false;
  }

  return true;
}

// Custom safe dependency-free liquid template compiler
function compileLiquidTemplate(template, order, customerName, orderNumber, shippingMethod, itemCount, orderTotal, paymentStatus, adminOrderUrl) {
  if (!template) return "";

  let compiled = template;

  // 1. Pre-process line item loops: {% for item in line_items %} ... {% endfor %}
  const loopRegex = /\{%\s*for\s+(\w+)\s+in\s+line_items\s*%\}([\s\S]*?)\{%\s*endfor\s*%\}/g;
  compiled = compiled.replace(loopRegex, (_, varName, loopContent) => {
    const items = order.line_items || [];
    return items.map((item) => {
      const variant = item.variant_title ? ` (${item.variant_title})` : "";
      const sku = item.sku ? ` [${item.sku}]` : "";
      
      return loopContent
        .replace(new RegExp(`{{\\s*${varName}\\.title\\s*}}`, "g"), item.title || "")
        .replace(new RegExp(`{{\\s*${varName}\\.quantity\\s*}}`, "g"), String(item.quantity || 1))
        .replace(new RegExp(`{{\\s*${varName}\\.sku\\s*}}`, "g"), item.sku || "")
        .replace(new RegExp(`{{\\s*${varName}\\.variant\\s*}}`, "g"), variant)
        .replace(new RegExp(`{{\\s*${varName}\\.price\\s*}}`, "g"), item.price || "0.00");
    }).join("");
  });

  // 2. Resolve global order variables
  const variables = {
    "order.order_number": orderNumber,
    "order.customer_name": customerName,
    "order.email": order.customer?.email || order.email || "",
    "order.phone": order.customer?.phone || order.billing_address?.phone || order.shipping_address?.phone || "",
    "order.total": orderTotal,
    "order.shipping_method": shippingMethod,
    "order.item_count": String(itemCount),
    "order.payment_status": paymentStatus,
    "order.notes": order.note || "",
    "order.admin_url": adminOrderUrl,
    "order.shipping_address": order.shipping_address 
      ? [order.shipping_address.address1, order.shipping_address.city, order.shipping_address.province, order.shipping_address.zip, order.shipping_address.country].filter(Boolean).join(", ")
      : ""
  };

  for (const [key, val] of Object.entries(variables)) {
    const reg = new RegExp(`{{\\s*${key}\\s*}}`, "g");
    compiled = compiled.replace(reg, val);
  }

  return compiled;
}

async function syncToPlatformConnection({
  prisma,
  connection,
  subscription,
  order,
  orderNumber,
  customerName,
  shippingMethodName,
  itemCount,
  orderTotal,
  paymentStatus,
  adminOrderUrl,
  assetLinks,
  incrementOrderCount,
  logActivity,
  compileMarkdownTable,
  ClickUpAdapter,
  MondayAdapter,
  NotionAdapter
}) {
  const shopDomain = connection.shopDomain;
  const isGrowthOrPro = subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial";

  // 1. Determine target list ID using routing constraints
  let targetListId = null;
  let targetListName = null;

  if (connection.listConnections && connection.listConnections.length > 0) {
    let matchedTarget = null;
    if (isGrowthOrPro) {
      // Evaluate more-specific targets first (those with a keyword/tag/location
      // constraint) so routing rules win over generic catch-all lists. Stable sort
      // preserves the merchant's configured order within the same specificity.
      const hasConstraint = (t) =>
        (t.keyword && t.keyword.trim()) ||
        (t.routingTag && t.routingTag.trim()) ||
        (t.routingLocationId && t.routingLocationId.trim())
          ? 1
          : 0;
      const ordered = [...connection.listConnections].sort(
        (a, b) => hasConstraint(b) - hasConstraint(a)
      );
      matchedTarget = ordered.find((tc) => satisfiesRoutingConstraints(tc, order));
    }
    if (matchedTarget) {
      targetListId = matchedTarget.id;
      targetListName = matchedTarget.name;
    } else {
      // Fallback: the first configured list acts as the catch-all for unmatched orders.
      targetListId = connection.listConnections[0].id;
      targetListName = connection.listConnections[0].name;
    }
  } else {
    targetListId = connection.listId;
    targetListName = connection.listName;
  }

  if (!targetListId) {
    return { success: false, error: `No target list or board configured for platform ${connection.selectedPlatform}` };
  }

  // 2. Check Idempotency: Has this order already synced to this target?
  const existingRecord = await prisma.orderSyncRecord.findFirst({
    where: {
      shopDomain,
      shopifyOrderId: String(order.id),
      syncTarget: {
        connectionId: connection.id,
        targetResourceId: targetListId
      }
    }
  });

  if (existingRecord) {
    return { success: true, skipped: true, reason: "already_synced", targetRecordId: existingRecord.targetRecordId };
  }

  // 3. Resolve task name template
  const resolveTemplate = (template, vals) =>
    template
      .replace(/{order_number}/g, vals.orderNumber)
      .replace(/{customer_name}/g, vals.customerName)
      .replace(/{order_total}/g, vals.orderTotal)
      .replace(/{shipping_method}/g, vals.shippingMethod)
      .replace(/{item_count}/g, vals.itemCount)
      .replace(/{payment_status}/g, vals.paymentStatus);

  const taskName = subscription.taskNameTemplate
    ? resolveTemplate(subscription.taskNameTemplate, {
        orderNumber,
        customerName,
        orderTotal,
        shippingMethod: shippingMethodName,
        itemCount: String(itemCount),
        paymentStatus,
      })
    : `Order #${orderNumber} — ${customerName}`;

  // 4. Build description (using custom template if Pro/Growth and configured, otherwise rich markdown)
  let description = "";
  
  if (isGrowthOrPro && subscription.taskDescriptionTemplate?.trim()) {
    description = compileLiquidTemplate(
      subscription.taskDescriptionTemplate,
      order,
      customerName,
      orderNumber,
      shippingMethodName,
      itemCount,
      orderTotal,
      paymentStatus,
      adminOrderUrl
    );
  } else {
    // Rich markdown fallback
    const lines = [];
    lines.push("👤 Customer:");
    lines.push(`   Name:  ${customerName}`);
    const email = order.customer?.email || order.email;
    if (email) lines.push(`   Email: ${email}`);
    const phone = order.customer?.phone || order.billing_address?.phone || order.shipping_address?.phone;
    if (phone) lines.push(`   Phone: ${phone}`);
    lines.push("");

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

    const currency = order.currency || "";
    const subtotal = order.subtotal_price ?? "0.00";
    const shippingCost = order.shipping_lines?.reduce((sum, s) => sum + parseFloat(s.price || "0"), 0).toFixed(2) ?? "0.00";
    const total = order.total_price ?? "0.00";

    lines.push(`💰 Subtotal: ${currency} ${subtotal}`);
    lines.push(`🚚 Shipping: ${currency} ${shippingCost}`);
    lines.push(`   Total:    ${currency} ${total}`);

    if (paymentStatus) {
      const payEmoji = paymentStatus === "paid" ? "✅" : "⏳";
      lines.push(`${payEmoji} Payment: ${paymentStatus}`);
    }
    lines.push("");

    if (order.shipping_lines?.length > 0) {
      const method = order.shipping_lines[0].title;
      if (method) lines.push(`📬 Ship via: ${method}`);
    }

    const addr = order.shipping_address;
    if (addr) {
      const addrParts = [
        addr.address1,
        addr.address2,
        [addr.city, addr.province_code || addr.province, addr.zip].filter(Boolean).join(", "),
        addr.country,
      ].filter(Boolean);
      lines.push(`📍 Ship to: ${addrParts.join(", ")}`);
    }

    if (order.note?.trim()) {
      lines.push("");
      lines.push(`📝 Notes: ${order.note.trim()}`);
    }

    if (assetLinks.length > 0) {
      lines.push("");
      lines.push("🎨 Production Assets:");
      for (const asset of assetLinks) {
        lines.push(`  • ${asset.itemName} (${asset.propName}):`);
        lines.push(`    🔗 ${asset.url}`);
      }
    }

    lines.push("");
    lines.push(`🔗 View order: ${adminOrderUrl}`);
    description = lines.join("\n");
  }

  // 5. Bypassing Custom Field API writes entirely on ClickUp Free plan using a compiled Markdown table
  if (connection.isFreePlan && isGrowthOrPro && connection.fieldMappings) {
    try {
      const mappings = JSON.parse(connection.fieldMappings);
      if (Array.isArray(mappings) && mappings.length > 0) {
        const mdTable = compileMarkdownTable(order, mappings, customerName, orderNumber);
        description = `${description}\n${mdTable}`;
      }
    } catch (e) {
      console.error("Free Plan mapping builder failed:", e);
    }
  }

  const orderCreatedAt = order.created_at ? new Date(order.created_at).getTime() : Date.now();
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

  // Compile subtask names (only if enabled by plan + subscription setting)
  const subtasksEnabled = isGrowthOrPro && subscription.subtasksEnabled;
  const subtaskNames = [];
  if (order.line_items?.length > 0) {
    for (const item of order.line_items) {
      const subtaskName = `${item.quantity}x ${item.title}${item.variant_title ? ` (${item.variant_title})` : ""}`;
      subtaskNames.push(subtaskName);
    }
  }

  // Compile attachment assets (Growth & Pro plans only)
  const attachmentAssets = [];
  if (isGrowthOrPro && assetLinks.length > 0) {
    for (const asset of assetLinks) {
      const urlParts = asset.url.split("/");
      let filename = urlParts[urlParts.length - 1].split("?")[0] || "design_file.pdf";
      filename = `${asset.itemName.replace(/[^a-zA-Z0-9.-]/g, "_")}_${filename}`;
      attachmentAssets.push({ url: asset.url, filename });
    }
  }

  // Instantiate adapter
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
    throw new Error(`Unsupported selectedPlatform integration: ${platform}`);
  }

  // Sync record creation through adapter
  const targetRecordId = await adapter.createRecord(targetListId, {
    name: taskName,
    description,
    priority: 3,
    startDate: orderCreatedAt,
    dueDate: orderCreatedAt + twoDaysMs,
    tags: ["shopify-order"],
    rawOrder: order,
    customerName,
    shippingCost: order.shipping_lines?.reduce((sum, s) => sum + parseFloat(s.price || "0"), 0).toFixed(2) ?? "0.00",
    fieldMappings: isGrowthOrPro ? connection.fieldMappings : null,
    isFreePlan: connection.isFreePlan,
    subtasks: subtaskNames,
    attachments: attachmentAssets
  });

  // Record in database
  const activeConn = await prisma.platformConnection.findFirst({
    where: { shopDomain, id: connection.id }
  });
  if (activeConn) {
    const syncTarget = await prisma.syncTarget.upsert({
      where: {
        connectionId_targetResourceId: {
          connectionId: activeConn.id,
          targetResourceId: targetListId
        }
      },
      update: {},
      create: {
        connectionId: activeConn.id,
        targetResourceId: targetListId,
        targetResourceName: targetListName || "Active Target"
      }
    });

    await prisma.orderSyncRecord.create({
      data: {
        shopDomain,
        shopifyOrderId: String(order.id),
        syncTargetId: syncTarget.id,
        targetRecordId: targetRecordId,
        syncStatus: "synced",
        orderNumber: orderNumber
      }
    });
    await incrementOrderCount(shopDomain);

    // Tag the Shopify order
    try {
      const { default: shopifyPrisma } = await import("../db.server");
      const sessionRec = await shopifyPrisma.session.findFirst({
        where: { shop: shopDomain, isOnline: false },
      });
      if (sessionRec?.accessToken) {
        const tagMutation = `mutation tagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`;
        const shopifyAdminUrl = `https://${shopDomain}/admin/api/2024-01/graphql.json`;
        await fetch(shopifyAdminUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": sessionRec.accessToken,
          },
          body: JSON.stringify({
            query: tagMutation,
            variables: {
              id: `gid://shopify/Order/${order.id}`,
              tags: [`syncup-${platform}`],
            },
          }),
        }).catch((tagErr) => console.error("Order tagging failed:", tagErr));
      }
    } catch (tagErr) {
      console.error("Order tagging error:", tagErr);
    }
  }

  logActivity(
    shopDomain,
    "order_synced",
    `Order #${orderNumber} (${customerName}) synced to ${connection.selectedPlatform === "clickup" ? "ClickUp" : connection.selectedPlatform === "monday" ? "Monday.com" : "Notion"}`,
    String(order.id),
    targetRecordId
  );

  return { success: true, targetRecordId };
}

async function handleJobProcess(request) {
  // Dynamic imports to prevent server-only modules from leaking into client bundle builds
  const [
    { default: prisma },
    {
      getConnection,
      fetchShopifyCustomer,
      logActivity,
      compileMarkdownTable,
    },
    { getOrCreateSubscription, isSubscriptionActive, getInactiveReason, incrementOrderCount },
    { ClickUpAdapter, MondayAdapter, NotionAdapter }
  ] = await Promise.all([
    import("../db.server"),
    import("../clickup.server"),
    import("../billing.server"),
    import("../adapters/core.js")
  ]);

  // Validate authorization
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") || request.headers.get("Authorization")?.replace("Bearer ", "");
  
  if (!secret || secret !== process.env.SHOPIFY_API_SECRET) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // Get up to 5 pending or failed jobs to process
  const jobs = await prisma.syncJob.findMany({
    where: {
      status: { in: ["pending", "failed"] },
      attempts: { lt: 3 },
    },
    orderBy: { createdAt: "asc" },
    take: 5,
  });

  if (jobs.length === 0) {
    return Response.json({ ok: true, processed: 0 });
  }

  const results = [];

  for (const job of jobs) {
    // Claim job state to avoid race conditions
    try {
      const claimResult = await prisma.syncJob.updateMany({
        where: { id: job.id, status: job.status, attempts: job.attempts },
        data: { status: "processing" }
      });
      if (claimResult.count === 0) {
        continue; 
      }
    } catch (e) {
      continue;
    }

    try {
      const payload = JSON.parse(job.payload);
      const { shopDomain } = job;
      
      const subscription = await getOrCreateSubscription(shopDomain);
      if (!isSubscriptionActive(subscription)) {
        const reason = getInactiveReason(subscription);
        if (reason === "monthly_limit") {
          // Transient: the shop hit its monthly order cap. Park the job as
          // "waiting" (distinct from "failed") so it doesn't inflate the
          // dashboard's failed count or get churned by "retry all". It is
          // re-queued to "pending" automatically when the counter resets at
          // the start of the next billing cycle (see getOrCreateSubscription).
          await prisma.syncJob.update({
            where: { id: job.id },
            data: {
              status: "waiting",
              lastError: "Monthly order limit reached — will auto-sync when the plan resets",
            },
          });
          results.push({ jobId: job.id, success: false, skipped: true, reason: "monthly_limit" });
          continue;
        }
        throw new Error(`Subscription not active (${reason || "unknown"}) — skipping order`);
      }

      // Check sync trigger setting
      const syncTrigger = subscription.syncTrigger || "payment_confirmed";
      if (syncTrigger === "payment_confirmed" && payload.financial_status !== "paid") {
        // Delete (don't keep) — the order isn't ready yet. The orders/updated
        // webhook (or reconciliation) re-enqueues it once it becomes paid. Keeping
        // a row would retain customer PII and poison reconciliation's dedup.
        await prisma.syncJob.delete({ where: { id: job.id } });
        results.push({ jobId: job.id, success: true, skipped: true, reason: "trigger:not_paid" });
        continue;
      }
      if (syncTrigger === "on_fulfillment_start" && !payload.fulfillment_status) {
        await prisma.syncJob.delete({ where: { id: job.id } });
        results.push({ jobId: job.id, success: true, skipped: true, reason: "trigger:not_fulfilling" });
        continue;
      }

      // The dashboard enforces a single active provider per shop, so every tier
      // syncs through that one connection. (Pro's "unlimited connections" refers
      // to list/board targets via SyncTarget, not multiple providers at once.)
      const conn = await getConnection(shopDomain);
      const activeConnections = conn ? [conn] : [];

      if (activeConnections.length === 0) {
        throw new Error(`No active platform connections configured for ${shopDomain}`);
      }

      const order = payload;
      const orderNumber = String(order.order_number ?? order.number ?? order.id);

      let customerName =
        [order.customer?.first_name, order.customer?.last_name]
          .filter(Boolean).join(" ").trim() ||
        order.customer?.name ||
        [order.billing_address?.first_name, order.billing_address?.last_name]
          .filter(Boolean).join(" ").trim() ||
        [order.shipping_address?.first_name, order.shipping_address?.last_name]
          .filter(Boolean).join(" ").trim() ||
        order.billing_address?.name ||
        order.shipping_address?.name ||
        order.customer?.email ||
        order.email;

      if (!customerName && order.customer?.id) {
        const fullCustomer = await fetchShopifyCustomer(shopDomain, order.customer.id);
        if (fullCustomer) {
          customerName =
            [fullCustomer.first_name, fullCustomer.last_name].filter(Boolean).join(" ").trim() ||
            fullCustomer.email;
        }
      }

      customerName = customerName || "Guest";

      const storeHandle = shopDomain.replace(/\.myshopify\.com$/, "");
      const adminOrderUrl = `https://admin.shopify.com/store/${storeHandle}/orders/${order.id}`;

      const shippingMethodName = order.shipping_lines?.[0]?.title || "";
      const itemCount = (order.line_items || []).length;
      const orderTotal = `${order.currency || ""} ${order.total_price || "0.00"}`;
      const paymentStatus = order.financial_status || "";

      // Parse Line Items for custom properties (artwork)
      const assetLinks = [];
      if (order.line_items?.length > 0) {
        for (const item of order.line_items) {
          if (Array.isArray(item.properties)) {
            for (const prop of item.properties) {
              const val = String(prop.value || "").trim();
              const isUrl = val.startsWith("http://") || val.startsWith("https://");
              const isFile = /\.(jpg|jpeg|png|gif|pdf|svg|webp|tiff|zip|ai|psd|eps|csv|txt)/i.test(val);
              if (isUrl && isFile) {
                assetLinks.push({
                  itemName: item.title,
                  propName: prop.name,
                  url: val
                });
              }
            }
          }
        }
      }

      // Fan out sync requests to all active connections
      const syncPromises = activeConnections.map((connection) =>
        syncToPlatformConnection({
          prisma,
          connection,
          subscription,
          order,
          orderNumber,
          customerName,
          shippingMethodName,
          itemCount,
          orderTotal,
          paymentStatus,
          adminOrderUrl,
          assetLinks,
          incrementOrderCount,
          logActivity,
          compileMarkdownTable,
          ClickUpAdapter,
          MondayAdapter,
          NotionAdapter
        })
      );

      const syncResults = await Promise.allSettled(syncPromises);

      // Check if any errors occurred
      const errors = [];
      for (let i = 0; i < syncResults.length; i++) {
        const res = syncResults[i];
        if (res.status === "rejected") {
          errors.push(`[${activeConnections[i].selectedPlatform}] ${res.reason.message}`);
        } else if (res.value?.success === false) {
          errors.push(`[${activeConnections[i].selectedPlatform}] ${res.value.error}`);
        }
      }

      if (errors.length > 0) {
        throw new Error(errors.join(" | "));
      }

      // Delete completed job — the full order JSON in `payload` contains customer PII
      // (name, email, address). OrderSyncRecord already tracks what was synced.
      await prisma.syncJob.delete({ where: { id: job.id } });
      results.push({ jobId: job.id, success: true });


    } catch (err) {
      console.error(`Sync Job ${job.id} failed:`, err);
      await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          attempts: { increment: 1 },
          lastError: err.message,
        }
      });
      results.push({ jobId: job.id, success: false, error: err.message });
    }
  }

  return Response.json({ ok: true, processed: jobs.length, results });
}
