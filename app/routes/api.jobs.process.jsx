// Helper function to sleep/delay execution
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      createTask,
      recordOrderTask,
      fetchShopifyCustomer,
      logActivity,
      setCustomFieldValue,
      formatFieldValueForClickUp,
      compileMarkdownTable,
      uploadTaskAttachment,
    },
    { getOrCreateSubscription, isSubscriptionActive, incrementOrderCount }
  ] = await Promise.all([
    import("../db.server"),
    import("../clickup.server"),
    import("../billing.server")
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
      const { shopDomain, shopifyOrderId } = job;
      
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
      const taskName = `Order #${orderNumber} — ${customerName}`;
      
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

      const paymentStatus = order.financial_status;
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

      // ClickUp Task Creation
      const task = await createTask(connection.accessToken, targetListId, {
        name: taskName,
        description,
        priority: 3,
        startDate: orderCreatedAt,
        dueDate: orderCreatedAt + twoDaysMs,
        tags: ["shopify-order"],
      });

      // Record in order task DB
      await recordOrderTask(shopDomain, String(order.id), task.id, "synced", orderNumber);

      // Upload production design files as task attachments (Growth & Pro plans only)
      const isGrowthOrPro = subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial";
      if (isGrowthOrPro && assetLinks.length > 0) {
        for (const asset of assetLinks) {
          try {
            const urlParts = asset.url.split("/");
            let filename = urlParts[urlParts.length - 1].split("?")[0] || "design_file.pdf";
            filename = `${asset.itemName.replace(/[^a-zA-Z0-9.-]/g, "_")}_${filename}`;
            await uploadTaskAttachment(connection.accessToken, task.id, asset.url, filename);
            await sleep(800); // Enforce rate limit delay
          } catch (uploadErr) {
            console.error(`Failed to upload attachment ${asset.url}:`, uploadErr);
          }
        }
      }

      // Create separate subtasks for each line item (bundle component) in ClickUp
      if (order.line_items?.length > 0) {
        for (const item of order.line_items) {
          try {
            const subtaskName = `${item.quantity}x ${item.title}${item.variant_title ? ` (${item.variant_title})` : ""}`;
            await createTask(connection.accessToken, targetListId, {
              name: subtaskName,
              parent: task.id,
              priority: 3,
            });
            await sleep(800); // Enforce rate limit delay
          } catch (subtaskErr) {
            console.error(`Failed to create subtask for item ${item.title}:`, subtaskErr);
          }
        }
      }

      // Custom Field Mapping (If Paid Plan and not ClickUp Free Plan)
      if (isGrowthOrPro && connection.fieldMappings && !connection.isFreePlan) {
        try {
          const mappings = JSON.parse(connection.fieldMappings);
          if (Array.isArray(mappings) && mappings.length > 0) {
            for (const mapping of mappings) {
              try {
                const rawValue = extractShopifyOrderFieldValue(
                  order,
                  mapping.shopifySourceField,
                  customerName,
                  orderNumber
                );
                const clickupValue = formatFieldValueForClickUp(rawValue, mapping.clickupFieldType);
                if (clickupValue !== null && clickupValue !== undefined) {
                  await setCustomFieldValue(
                    connection.accessToken,
                    task.id,
                    mapping.clickupFieldId,
                    clickupValue
                  );
                  // Token-Bucket Delay to stay under rate limits
                  await sleep(800);
                }
              } catch (fieldErr) {
                console.error(`Field sync error:`, fieldErr);
              }
            }
          }
        } catch (mappingParseErr) {
          console.error("Failed to parse field mappings:", mappingParseErr);
        }
      }

      logActivity(
        shopDomain,
        "order_synced",
        `Order #${orderNumber} (${customerName}) synced to ClickUp`,
        String(order.id),
        task.id
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

function extractShopifyOrderFieldValue(order, fieldId, customerName, orderNumber) {
  switch (fieldId) {
    case "order_number":
      return orderNumber;
    case "customer_name":
      return customerName;
    case "customer_email":
      return order.customer?.email || order.email || "";
    case "customer_phone":
      return (
        order.customer?.phone ||
        order.billing_address?.phone ||
        order.shipping_address?.phone ||
        ""
      );
    case "total_price":
      return order.total_price || "0.00";
    case "subtotal_price":
      return order.subtotal_price || "0.00";
    case "shipping_price": {
      const shippingCost = order.shipping_lines?.reduce(
        (sum, s) => sum + parseFloat(s.price || "0"),
        0
      );
      return shippingCost !== undefined ? shippingCost.toFixed(2) : "0.00";
    }
    case "shipping_address": {
      const addr = order.shipping_address;
      if (!addr) return "";
      return [
        addr.address1,
        addr.address2,
        addr.city,
        addr.province,
        addr.zip,
        addr.country,
      ]
        .filter(Boolean)
        .join(", ");
    }
    case "order_notes":
      return order.note || "";
    case "created_at":
      return order.created_at || "";
    default:
      return "";
  }
}
