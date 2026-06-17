/* global process */

export const loader = async ({ request }) => {
  return handleJobProcess(request);
};

export const action = async ({ request }) => {
  return handleJobProcess(request);
};

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
    { getOrCreateSubscription, isSubscriptionActive, incrementOrderCount },
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
        throw new Error(`Subscription inactive for ${shopDomain}`);
      }

      const connection = await getConnection(shopDomain);
      if (!connection?.accessToken || (!connection.listId && !connection.listConnections)) {
        throw new Error(`ClickUp list configuration missing for ${shopDomain}`);
      }

      const order = payload;
      const orderNumber = String(order.order_number ?? order.number ?? order.id);

      // Check sync trigger setting
      const syncTrigger = subscription.syncTrigger || "payment_confirmed";
      if (syncTrigger === "payment_confirmed" && order.financial_status !== "paid") {
        // Skip unpaid orders for this trigger
        await prisma.syncJob.update({
          where: { id: job.id },
          data: { status: "completed" }
        });
        results.push({ jobId: job.id, success: true, skipped: true, reason: "trigger:not_paid" });
        continue;
      }
      if (syncTrigger === "on_fulfillment_start" && !order.fulfillment_status) {
        await prisma.syncJob.update({
          where: { id: job.id },
          data: { status: "completed" }
        });
        results.push({ jobId: job.id, success: true, skipped: true, reason: "trigger:not_fulfilling" });
        continue;
      }

      // Determine target list ID using multi-list connection routing
      let targetListId = connection.listId;
      let targetListName = connection.listName;

      if (connection.listConnections) {
        try {
          const listConns = JSON.parse(connection.listConnections);
          if (listConns.length > 0) {
            const lineItems = order.line_items || [];
            let matched = false;
            for (const conn of listConns) {
              if (conn.keyword && conn.keyword.trim()) {
                const kw = conn.keyword.trim().toLowerCase();
                const hasMatch = lineItems.some(
                  (item) =>
                    (item.title && item.title.toLowerCase().includes(kw)) ||
                    (item.vendor && item.vendor.toLowerCase().includes(kw)) ||
                    (item.sku && item.sku.toLowerCase().includes(kw))
                );
                if (hasMatch) {
                  targetListId = conn.id;
                  targetListName = conn.name;
                  matched = true;
                  break;
                }
              }
            }
            if (!matched && listConns[0]) {
              targetListId = listConns[0].id;
              targetListName = listConns[0].name;
            }
          }
        } catch (e) {
          console.error("Failed to parse listConnections in job:", e);
        }
      }

      if (!targetListId) {
        throw new Error(`No target ClickUp list found for order ${order.id}`);
      }

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

      // Resolve task name from merchant template or fall back to default
      const resolveTemplate = (template, vals) =>
        template
          .replace(/{order_number}/g, vals.orderNumber)
          .replace(/{customer_name}/g, vals.customerName)
          .replace(/{order_total}/g, vals.orderTotal)
          .replace(/{shipping_method}/g, vals.shippingMethod)
          .replace(/{item_count}/g, vals.itemCount)
          .replace(/{payment_status}/g, vals.paymentStatus);

      const shippingMethodName = order.shipping_lines?.[0]?.title || "";
      const itemCount = (order.line_items || []).length;
      const orderTotal = `${order.currency || ""} ${order.total_price || "0.00"}`;
      const paymentStatus = order.financial_status || "";

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

      // Build description
      const lines = [];
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
      const shippingCost =
        order.shipping_lines?.reduce(
          (sum, s) => sum + parseFloat(s.price || "0"),
          0
        ).toFixed(2) ?? "0.00";
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
          [addr.city, addr.province_code || addr.province, addr.zip]
            .filter(Boolean)
            .join(", "),
          addr.country,
        ].filter(Boolean);
        lines.push(`📍 Ship to: ${addrParts.join(", ")}`);
      }

      if (order.note?.trim()) {
        lines.push("");
        lines.push(`📝 Notes: ${order.note.trim()}`);
      }

      // Append production assets if any
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
      
      let description = lines.join("\n");

      // Bypassing Custom Field API writes entirely on ClickUp Free plan using a compiled Markdown table
      if (connection.isFreePlan && connection.fieldMappings) {
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
      const isGrowthOrPro = subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial";
      const subtasksEnabled = isGrowthOrPro && subscription.subtasksEnabled;
      const subtaskNames = [];
      if (subtasksEnabled && order.line_items?.length > 0) {
        for (const item of order.line_items) {
          const subtaskName = `${item.quantity}x ${item.title}${item.variant_title ? ` (${item.variant_title})` : ""}`;
          subtaskNames.push(subtaskName);
        }
      } else if (isGrowthOrPro && !subtasksEnabled && order.line_items?.length > 0) {
        // Still include subtask names for adapters that always create them on Growth/Pro
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

      // Instantiate correct platform adapter
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

      // Sync record creation through adapter (custom mappings are formatted inside the adapter)
      const targetRecordId = await adapter.createRecord(targetListId, {
        name: taskName,
        description,
        priority: 3,
        startDate: orderCreatedAt,
        dueDate: orderCreatedAt + twoDaysMs,
        tags: ["shopify-order"],
        rawOrder: order,
        customerName,
        shippingCost,
        fieldMappings: connection.fieldMappings,
        isFreePlan: connection.isFreePlan,
        subtasks: subtaskNames,
        attachments: attachmentAssets
      });

      // Record in polymorphic OrderSyncRecord DB
      try {
        const activeConn = await prisma.platformConnection.findFirst({
          where: { shopDomain, isActive: true }
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

          // Phase 6: Tag the Shopify order with provider name for visibility in admin orders list
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
      } catch (dbErr) {
        console.error("Polymorphic OrderSyncRecord write failed:", dbErr);
      }

      logActivity(
        shopDomain,
        "order_synced",
        `Order #${orderNumber} (${customerName}) synced to ${connection.selectedPlatform === "clickup" ? "ClickUp" : connection.selectedPlatform === "monday" ? "Monday.com" : "Notion"}`,
        String(order.id),
        targetRecordId
      );

      // Complete job
      await prisma.syncJob.update({
        where: { id: job.id },
        data: { status: "completed" }
      });
      results.push({ jobId: job.id, success: true });

    } catch (err) {
      console.error(`Sync Job ${job.id} failed:`, err);
      // Mark job as failed, increment attempts
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


