import { useState, useEffect, useMemo } from "react";
import { Form, useLoaderData, useActionData, useNavigation, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getOrCreateSubscription, getTrialBannerStatus, isSubscriptionActive } from "../billing.server";
import { signState } from "../oauth-state.server";
import { PLANS, getTranslatedFeatures } from "../plans";
import prisma from "../db.server";

// Global API Cache to speed up navigation on and off other routes (like Billing)
if (!globalThis.apiCache) {
  globalThis.apiCache = {
    targets: new Map(),
    fields: new Map(),
    orders: new Map(),
  };
}
const CACHE_TTL = 3 * 60 * 1000; // 3 minutes
const CACHE_MAX = 500; // bound per-map size so stale (pre-reconnect) keys can't leak memory

// Bounded cache write: drops the oldest entry once a map reaches CACHE_MAX.
function cacheSet(map, key, value) {
  if (map.size >= CACHE_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const { getConnection, getRecentActivity } = await import("../clickup.server");

  const [connection, subscription, recentActivity] = await Promise.all([
    getConnection(shop),
    getOrCreateSubscription(shop),
    getRecentActivity(shop, 5),
  ]);

  let lists = [];
  let listError = null;
  let clickupFields = [];
  let fieldMappings = null;
  let latestOrder = null;

  let healthStatus = connection?.healthStatus || "healthy";
  if (connection?.accessToken) {
    // 1. Throttled connection health check (run at most once every 5 minutes in background)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    if (!connection.lastHealthCheck || new Date(connection.lastHealthCheck) < fiveMinutesAgo) {
      (async () => {
        try {
          let healthy = false;
          if (connection.selectedPlatform === "clickup") {
            const res = await fetch("https://api.clickup.com/api/v2/user", {
              headers: { Authorization: connection.accessToken },
            });
            healthy = res.status === 200;
          } else if (connection.selectedPlatform === "monday") {
            const res = await fetch("https://api.monday.com/v2", {
              method: "POST",
              headers: {
                Authorization: connection.accessToken,
                "Content-Type": "application/json",
                "API-Version": "2023-10",
              },
              body: JSON.stringify({ query: "{ me { id } }" }),
            });
            healthy = res.status === 200;
          } else if (connection.selectedPlatform === "notion") {
            const res = await fetch("https://api.notion.com/v1/users/me", {
              headers: {
                Authorization: `Bearer ${connection.accessToken}`,
                "Notion-Version": "2022-06-28",
              },
            });
            healthy = res.status === 200;
          }

          const updatedHealth = healthy ? "healthy" : "error";
          await prisma.platformConnection.update({
            where: { id: connection.id },
            data: {
              healthStatus: updatedHealth,
              lastHealthCheck: new Date(),
            },
          });
        } catch (err) {
          console.error("Background health check failed:", err);
          try {
            await prisma.platformConnection.update({
              where: { id: connection.id },
              data: { healthStatus: "error", lastHealthCheck: new Date() },
            });
          } catch (dbErr) {
            console.error("Failed to update health check error in DB:", dbErr);
          }
        }
      })();
    }

    // 2. Fetch targets, fields, and latest order concurrently (with caching)
    const cacheKeyTargets = `${shop}:${connection.selectedPlatform}:${connection.accessToken}`;
    const cacheKeyFields = `${shop}:${connection.selectedPlatform}:${connection.listId}:${connection.accessToken}`;
    const cacheKeyOrder = `${shop}`;
    const now = Date.now();

    const cachedTargets = globalThis.apiCache.targets.get(cacheKeyTargets);
    const cachedFields = globalThis.apiCache.fields.get(cacheKeyFields);
    const cachedOrder = globalThis.apiCache.orders.get(cacheKeyOrder);

    fieldMappings = connection.fieldMappings ? JSON.parse(connection.fieldMappings) : null;

    const promises = [];

    // Target Lists Fetch
    if (cachedTargets && (now - cachedTargets.timestamp < CACHE_TTL)) {
      lists = cachedTargets.data;
    } else {
      promises.push((async () => {
        try {
          const { IntegrationFactory } = await import("../adapters/factory");
          const adapter = await IntegrationFactory.getAdapter(connection.selectedPlatform, connection.accessToken);
          const data = await adapter.fetchTargets();
          cacheSet(globalThis.apiCache.targets, cacheKeyTargets, { data, timestamp: now });
          lists = data;
        } catch (error) {
          console.error(`Failed to load targets for ${shop}:`, error);
          listError = `We couldn't load your resources from ${connection.selectedPlatform === "clickup" ? "ClickUp" : connection.selectedPlatform === "monday" ? "Monday.com" : "Notion"}. Try disconnecting and reconnecting.`;
        }
      })());
    }

    // Destination Fields Fetch
    const isGrowthOrPro =
      subscription.planName.startsWith("growth") ||
      subscription.planName.startsWith("pro") ||
      subscription.planName === "trial";

    if (connection.listId && isGrowthOrPro) {
      if (cachedFields && (now - cachedFields.timestamp < CACHE_TTL)) {
        clickupFields = cachedFields.data;
      } else {
        promises.push((async () => {
          try {
            const { IntegrationFactory } = await import("../adapters/factory");
            const adapter = await IntegrationFactory.getAdapter(connection.selectedPlatform, connection.accessToken);
            const data = await adapter.fetchFields(connection.listId);
            cacheSet(globalThis.apiCache.fields, cacheKeyFields, { data, timestamp: now });
            clickupFields = data;
          } catch (e) {
            console.error("Failed to load destination fields in loader:", e);
          }
        })());
      }
    }

    // Shopify Latest Order Fetch
    if (cachedOrder && (now - cachedOrder.timestamp < CACHE_TTL)) {
      latestOrder = cachedOrder.data;
    } else {
      promises.push((async () => {
        try {
          const response = await admin.graphql(`#graphql
            query GetLatestOrderForPreview {
              orders(first: 1, reverse: true) {
                nodes {
                  id
                  name
                  totalPriceSet {
                    presentmentMoney {
                      amount
                      currencyCode
                    }
                  }
                  financialStatus
                  createdAt
                  customer {
                    firstName
                    lastName
                    email
                    phone
                  }
                  lineItems(first: 10) {
                    nodes {
                      id
                      title
                      quantity
                      sku
                    }
                  }
                  shippingLines(first: 1) {
                    nodes {
                      title
                    }
                  }
                }
              }
            }
          `);

          const responseJson = await response.json();
          const orderNode = responseJson.data?.orders?.nodes?.[0];
          if (orderNode) {
            const mappedOrder = {
              id: orderNode.id.split("/").pop(),
              order_number: orderNode.name.replace(/^#/, ""),
              number: orderNode.name,
              total_price: orderNode.totalPriceSet?.presentmentMoney?.amount || "0.00",
              currency: orderNode.totalPriceSet?.presentmentMoney?.currencyCode || "USD",
              created_at: orderNode.createdAt,
              financial_status: orderNode.financialStatus?.toLowerCase() || "",
              customer: orderNode.customer ? {
                first_name: orderNode.customer.firstName || "",
                last_name: orderNode.customer.lastName || "",
                email: orderNode.customer.email || "",
                phone: orderNode.customer.phone || "",
                name: [orderNode.customer.firstName, orderNode.customer.lastName].filter(Boolean).join(" ")
              } : null,
              line_items: orderNode.lineItems?.nodes?.map(li => ({
                id: li.id.split("/").pop(),
                title: li.title,
                quantity: li.quantity,
                sku: li.sku || ""
              })) || [],
              shipping_lines: orderNode.shippingLines?.nodes?.map(sl => ({
                title: sl.title
              })) || []
            };
            cacheSet(globalThis.apiCache.orders, cacheKeyOrder, { data: mappedOrder, timestamp: now });
            latestOrder = mappedOrder;
          }
        } catch (err) {
          console.error("Failed to query latest Shopify order via GraphQL:", err);
        }
      })());
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  const url = new URL(request.url);
  const billingSuccess = url.searchParams.get("billing_success") === "1";
  const clickupError = url.searchParams.get("clickup_error") || null;
  const removedLists = url.searchParams.get("removed_lists") || null;

  const trialBanner = getTrialBannerStatus(subscription);
  const isTrialOrSubscriptionActive = isSubscriptionActive(subscription);

  let syncStatus = "not_configured";
  if (connection?.accessToken && (connection?.listId || connection?.listConnections?.length > 0)) {
    syncStatus = isTrialOrSubscriptionActive ? "active" : "paused";
  }

  const totalSyncedMonth = subscription.ordersSyncedThisMonth || 0;
  const totalSyncedAllTime = subscription.ordersSyncedAllTime || 0;

  const totalTasks = await prisma.orderSyncRecord.count({ where: { shopDomain: shop } });
  const failedTasks = await prisma.orderSyncRecord.count({
    where: { shopDomain: shop, syncStatus: "failed" },
  });
  const successRate = totalTasks === 0 ? 100 : Math.round(((totalTasks - failedTasks) / totalTasks) * 100);

  // 1. Count failed jobs
  const failedJobsCount = await prisma.syncJob.count({
    where: { shopDomain: shop, status: "failed" },
  });

  // 2. Fetch last sync time
  const lastSyncRecord = await prisma.orderSyncRecord.findFirst({
    where: { shopDomain: shop, syncStatus: { in: ["synced", "fulfilled", "partially_fulfilled", "partially_refunded", "refunded"] } },
    orderBy: { createdAt: "desc" },
  });
  const lastSyncTime = lastSyncRecord ? lastSyncRecord.createdAt.toISOString() : null;

  // 3. Count orders synced today
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const syncedToday = await prisma.orderSyncRecord.count({
    where: {
      shopDomain: shop,
      createdAt: { gte: startOfToday },
      syncStatus: { in: ["synced", "fulfilled", "partially_fulfilled", "partially_refunded", "refunded"] },
    },
  });

  const recentTasks = await prisma.orderSyncRecord.findMany({
    where: { shopDomain: shop },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const plan = PLANS[subscription.planName] || (subscription.planName === "trial" ? { name: "Free Trial", listLimit: 5 } : { name: "Expired/Cancelled", listLimit: 1 });
  const listLimit = plan.listLimit || 1;

  if (!latestOrder) {
    latestOrder = {
      id: "999999999",
      order_number: "1001",
      number: "#1001",
      total_price: "159.50",
      currency: "USD",
      created_at: new Date().toISOString(),
      financial_status: "paid",
      customer: {
        first_name: "John",
        last_name: "Doe",
        email: "john.doe@example.com",
        phone: "+15559876543",
        name: "John Doe"
      },
      line_items: [
        { id: "101", title: "Premium Leather Boot", quantity: 1, sku: "BOOT-PREM-L" },
        { id: "102", title: "Organic Cotton Sock", quantity: 3, sku: "SOCK-ORG-C" }
      ],
      shipping_lines: [
        { title: "Standard Expedited Courier" }
      ]
    };
  }

  return {
    shop,
    email: session.email || null,
    clickupConnectState: await signState(shop),
    connected: Boolean(connection?.accessToken),
    healthStatus,
    selectedPlatform: connection?.selectedPlatform || "clickup",
    workspaceName: connection?.workspaceName || null,
    listConnections: connection?.listConnections || [],
    lists,
    listError,
    clickupFields,
    fieldMappings,
    latestOrder,
    // Merchant-configurable sync settings
    taskNameTemplate: subscription.taskNameTemplate || "",
    taskDescriptionTemplate: subscription.taskDescriptionTemplate || "",
    syncTrigger: subscription.syncTrigger || "payment_confirmed",
    subtasksEnabled: subscription.subtasksEnabled || false,
    twoWaySyncEnabled: subscription.twoWaySyncEnabled || false,
    subscription: {
      planName: subscription.planName,
      status: subscription.status,
      trialEndDate: subscription.trialEndDate ? subscription.trialEndDate.toISOString() : null,
      billingCycleStart: subscription.billingCycleStart ? subscription.billingCycleStart.toISOString() : null,
    },
    trialBanner,
    isTrialOrSubscriptionActive,
    syncStatus,
    billingSuccess,
    clickupError,
    removedLists,
    listLimit,
    isFreePlan: connection?.isFreePlan || false,
    failedJobsCount,
    lastSyncTime,
    syncedToday,
    analytics: {
      totalSyncedMonth,
      totalSyncedAllTime,
      successRate,
      recentTasks: recentTasks.map((t) => ({
        id: t.id,
        shopifyOrderId: t.shopifyOrderId,
        orderNumber: t.orderNumber || `#${t.shopifyOrderId.slice(-6)}`,
        status: t.syncStatus,
        createdAt: t.createdAt.toISOString(),
      })),
    },
    recentActivity: recentActivity.map((a) => ({
      id: a.id,
      eventType: a.eventType,
      description: a.description,
      createdAt: a.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  const { getConnection, disconnect, logActivity, saveListConnections, generateWebhookSecret } = await import("../clickup.server");

  if (intent === "join_waitlist") {
    const platform = formData.get("platform");
    const waitlistEmail = formData.get("email") || "";
    await prisma.activityLog.create({
      data: {
        shopDomain: shop,
        eventType: "waitlist_joined",
        description: `Joined ${platform === "monday" ? "Monday.com" : "Notion"} integration private beta waitlist (${waitlistEmail})`
      }
    });
    return { ok: true, joinedWaitlist: platform, waitlistEmail };
  }

  if (intent === "disconnect") {
    const connection = await getConnection(shop);
    const platformName = connection?.selectedPlatform === "clickup" ? "ClickUp" : connection?.selectedPlatform === "monday" ? "Monday.com" : "Notion";
    await disconnect(shop);
    logActivity(shop, "clickup_disconnected", `${platformName} account disconnected`);
    return { ok: true, disconnected: true };
  }

  if (intent === "retry_all_failed_syncs") {
    try {
      const failedJobs = await prisma.syncJob.findMany({
        where: { shopDomain: shop, status: "failed" },
      });
      if (failedJobs.length === 0) {
        return { ok: true, retriedAllFailed: true, retriedCount: 0 };
      }

      const jobIds = failedJobs.map((j) => j.id);
      const orderIds = failedJobs.map((j) => j.shopifyOrderId);

      await prisma.syncJob.updateMany({
        where: { id: { in: jobIds } },
        data: { status: "pending", attempts: 0 },
      });

      await prisma.orderSyncRecord.updateMany({
        where: { shopDomain: shop, shopifyOrderId: { in: orderIds } },
        data: { syncStatus: "retrying" },
      });

      await prisma.activityLog.updateMany({
        where: { shopDomain: shop, shopifyOrderId: { in: orderIds }, syncStatus: "failed" },
        data: { syncStatus: "retrying" },
      });

      logActivity(shop, "sync_retried", `Retried ${failedJobs.length} failed sync job(s)`);
      return { ok: true, retriedAllFailed: true, retriedCount: failedJobs.length };
    } catch (e) {
      return { ok: false, error: "We couldn't retry the failed syncs. Please refresh the page and try again." };
    }
  }

  if (intent === "save_connections") {
    const jsonStr = formData.get("listConnectionsJson");
    if (!jsonStr) {
      return { ok: false, error: "No connection data provided." };
    }

    try {
      const conns = JSON.parse(String(jsonStr));
      if (conns.length === 0) {
        return { ok: false, error: "Please configure at least one list connection." };
      }

      const sub = await getOrCreateSubscription(shop);
      const plan = PLANS[sub.planName] || (sub.planName === "trial" ? { listLimit: 5 } : { listLimit: 1 });
      const limit = plan.listLimit || 1;

      if (conns.length > limit) {
        return { ok: false, error: `Your current plan supports up to ${limit} list connection(s).` };
      }

      if (conns.some((c) => !c.id)) {
        return { ok: false, error: "Please choose a list for all connections." };
      }

      await saveListConnections(shop, conns);
      return { ok: true, saved: true };
    } catch (e) {
      return { ok: false, error: "We couldn't save your list connections. Verify your platform account has active permissions." };
    }
  }

  if (intent === "connect_platform") {
    const platform = formData.get("platform");
    const token = formData.get("token");
    if (platform === "monday" || platform === "notion") {
      return { ok: false, error: `${platform === "monday" ? "Monday.com" : "Notion"} integration is coming soon.` };
    }
    if (!token) {
      return { ok: false, error: "API token is required." };
    }

    try {
      const { IntegrationFactory } = await import("../adapters/factory");
      const adapter = await IntegrationFactory.getAdapter(platform, token);
      const connected = await adapter.testConnection();
      if (!connected) {
        return { ok: false, error: "Failed to verify connection. Please verify your API token and try again." };
      }

      const { encryptToken } = await import("../crypto.server");
      const encryptedToken = await encryptToken(token);

      // Deactivate any other active provider connection
      const activeConnections = await prisma.platformConnection.findMany({
        where: { shopDomain: shop, isActive: true }
      });
      for (const oldConn of activeConnections) {
        if (oldConn.provider !== platform.toUpperCase()) {
          await prisma.syncTarget.updateMany({
            where: { connectionId: oldConn.id },
            data: { isActive: false }
          });
          await prisma.platformConnection.update({
            where: { id: oldConn.id },
            data: { isActive: false }
          });
        }
      }

      // Upsert new connection — mint a fresh webhook secret on every connect so
      // the inbound completion webhook URL is rotated with the new token.
      const webhookSecret = generateWebhookSecret();
      const conn = await prisma.platformConnection.upsert({
        where: {
          shopDomain_provider: {
            shopDomain: shop,
            provider: platform.toUpperCase()
          }
        },
        update: {
          encryptedAccessToken: encryptedToken,
          isActive: true,
          webhookSecret
        },
        create: {
          shopDomain: shop,
          provider: platform.toUpperCase(),
          encryptedAccessToken: encryptedToken,
          isActive: true,
          webhookSecret
        }
      });

      // Upsert metadata
      if (platform === "monday") {
        await prisma.mondayMetadata.upsert({
          where: { connectionId: conn.id },
          update: { workspaceId: "monday_default", fieldMappings: "[]" },
          create: { connectionId: conn.id, workspaceId: "monday_default", fieldMappings: "[]" }
        });
      } else if (platform === "notion") {
        await prisma.notionMetadata.upsert({
          where: { connectionId: conn.id },
          update: { workspaceId: "notion_default", fieldMappings: "[]" },
          create: { connectionId: conn.id, workspaceId: "notion_default", fieldMappings: "[]" }
        });
      }

      logActivity(shop, "clickup_connected", `${platform === "monday" ? "Monday.com" : "Notion"} connected successfully`);
      return { ok: true, connectedPlatform: platform };
    } catch (err) {
      console.error(`Failed to connect ${platform}:`, err);
      return { ok: false, error: "Failed to verify connection. Please verify your API token and try again." };
    }
  }

  if (intent === "save_field_mappings") {
    const jsonStr = formData.get("fieldMappingsJson");
    if (!jsonStr) {
      return { ok: false, error: "No mapping data provided." };
    }
    try {
      const parsed = JSON.parse(String(jsonStr));
      if (!Array.isArray(parsed)) {
        return { ok: false, error: "Invalid mapping data format." };
      }
      if (parsed.length > 100) {
        return { ok: false, error: "You cannot map more than 100 fields." };
      }

      const activeConn = await prisma.platformConnection.findFirst({
        where: { shopDomain: shop, isActive: true }
      });
      if (!activeConn) {
        return { ok: false, error: "No active connection found." };
      }

      // Require the target-field key that the adapter actually reads for this
      // provider, so mappings don't silently fall through to a wrong column.
      const targetFieldKey =
        activeConn.provider === "MONDAY" ? "mondayColumnId"
        : activeConn.provider === "NOTION" ? "notionPropertyId"
        : "clickupFieldId";
      for (const m of parsed) {
        if (!m[targetFieldKey] || !m.shopifySourceField) {
          return { ok: false, error: "Invalid mapping configuration." };
        }
      }

      if (activeConn.provider === "CLICKUP") {
        await prisma.clickUpMetadata.update({
          where: { connectionId: activeConn.id },
          data: { fieldMappings: JSON.stringify(parsed) },
        });
      } else if (activeConn.provider === "MONDAY") {
        await prisma.mondayMetadata.update({
          where: { connectionId: activeConn.id },
          data: { fieldMappings: JSON.stringify(parsed) },
        });
      } else if (activeConn.provider === "NOTION") {
        await prisma.notionMetadata.update({
          where: { connectionId: activeConn.id },
          data: { fieldMappings: JSON.stringify(parsed) },
        });
      }

      return { ok: true, savedMappings: true };
    } catch (e) {
      return { ok: false, error: "We couldn't save your field mappings. Please ensure the column selections are correct." };
    }
  }

  if (intent === "send_test_task") {
    try {
      const connection = await getConnection(shop);
      if (!connection?.accessToken || !connection.listId) {
        return { ok: false, error: "Please configure and save a target connection first." };
      }

      const { IntegrationFactory } = await import("../adapters/factory");
      const adapter = await IntegrationFactory.getAdapter(connection.selectedPlatform, connection.accessToken);

      const mockOrderNumber = "9999-TEST";
      const mockCustomerName = "Jane Doe";
      const mockEmail = "jane.doe@example.com";
      const mockPhone = "+1 555-0199";
      const mockAddress = "123 Main St, Seattle, WA 98101, United States";
      const mockNote = "Engrave initials 'J.D.' on cuff";
      const mockCreatedAt = new Date().toISOString();

      const mockTaskName = `Order #${mockOrderNumber} — ${mockCustomerName}`;
      const mockDescription = `👤 Customer:
   Name:  ${mockCustomerName}
   Email: ${mockEmail}
   Phone: ${mockPhone}

 📦 Items:
   • 1x Custom Embroidered Hoodie [Hoodie-01]

 💰 Subtotal: USD 45.00
 🚚 Shipping: USD 5.00
    Total:    USD 50.00
 ✅ Payment: paid

 📍 Ship to: ${mockAddress}

 📝 Notes: ${mockNote}

 🔗 View order: https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/, "")}/orders/test`;

      const orderCreatedAt = Date.now();
      const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

      await adapter.createRecord(connection.listId, {
        name: mockTaskName,
        description: mockDescription,
        priority: 3,
        startDate: orderCreatedAt,
        dueDate: orderCreatedAt + twoDaysMs,
        tags: ["shopify-order", "test-sync"],
        rawOrder: {
          id: "9999-TEST",
          order_number: mockOrderNumber,
          customer: { first_name: "Jane", last_name: "Doe", email: mockEmail, phone: mockPhone },
          total_price: "50.00",
          subtotal_price: "45.00",
          shipping_lines: [{ price: "5.00" }],
          shipping_address: { address1: "123 Main St", city: "Seattle", province: "WA", zip: "98101", country: "United States" },
          note: mockNote,
          created_at: mockCreatedAt
        },
        customerName: mockCustomerName,
        shippingCost: "5.00",
        fieldMappings: connection.fieldMappings,
        isFreePlan: connection.isFreePlan,
        subtasks: ["1x Custom Embroidered Hoodie"],
        attachments: []
      });

      logActivity(shop, "order_synced", `Sent test record (Order #${mockOrderNumber}) to ${connection.selectedPlatform === "clickup" ? "ClickUp" : connection.selectedPlatform === "monday" ? "Monday.com" : "Notion"}`);
      return { ok: true, sentTestTask: true };
    } catch (e) {
      return { ok: false, error: "We couldn't create the test task. Your selected list/board may have been moved or deleted." };
    }
  }

  if (intent === "save_settings") {
    try {
      const rawTemplate = formData.get("taskNameTemplate") || "";
      const rawDescTemplate = formData.get("taskDescriptionTemplate") || "";
      const syncTrigger = formData.get("syncTrigger") || "payment_confirmed";
      const subtasksEnabled = formData.get("subtasksEnabled") === "true";
      const twoWaySyncEnabled = formData.get("twoWaySyncEnabled") === "true";

      const validTriggers = ["payment_confirmed", "on_create", "on_fulfillment_start"];
      if (!validTriggers.includes(syncTrigger)) {
        return { ok: false, error: "Invalid sync trigger value." };
      }

      const sub = await getOrCreateSubscription(shop);
      const isGrowthOrPro =
        sub.planName.startsWith("growth") ||
        sub.planName.startsWith("pro") ||
        sub.planName === "trial";

      await prisma.subscription.update({
        where: { shopDomain: shop },
        data: {
          taskNameTemplate: rawTemplate.trim() || null,
          taskDescriptionTemplate: isGrowthOrPro ? (rawDescTemplate.trim() || null) : null,
          syncTrigger,
          subtasksEnabled: isGrowthOrPro ? subtasksEnabled : false,
          twoWaySyncEnabled: isGrowthOrPro ? twoWaySyncEnabled : false,
        },
      });

      return { ok: true, savedSettings: true };
    } catch (e) {
      return { ok: false, error: "We couldn't save your settings. Please verify the templates and triggers." };
    }
  }

  return { ok: false, error: "Unknown action." };
};

const C = {
  bg: "#0f0f0f",
  surface: "#1a1a1a",
  border: "#2a2a2a",
  text: "#ffffff",
  muted: "#9a9a9a",
  accent: "#00c48c",
};

const SHOPIFY_SOURCE_FIELDS = [
  { id: "order_number", label: "Order Number (e.g. #1001)", type: "string" },
  { id: "customer_name", label: "Customer Name (e.g. John Doe)", type: "string" },
  { id: "customer_email", label: "Customer Email", type: "email" },
  { id: "customer_phone", label: "Customer Phone", type: "phone" },
  { id: "total_price", label: "Order Total Price", type: "currency" },
  { id: "subtotal_price", label: "Subtotal Price", type: "currency" },
  { id: "shipping_price", label: "Shipping Cost", type: "currency" },
  { id: "shipping_address", label: "Shipping Address", type: "string" },
  { id: "order_notes", label: "Order Notes / Comments", type: "string" },
  { id: "created_at", label: "Order Creation Date", type: "date" },
];

function timeAgo(isoString) {
  const seconds = Math.floor((Date.now() - new Date(isoString)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function checkFieldCompatibility(shopifyType, destType, platform) {
  if (!shopifyType || !destType) return { valid: true };

  const sType = shopifyType.toLowerCase();
  const dType = destType.toLowerCase();

  // Text/string destinations can receive anything
  const isTextDest =
    dType.includes("text") ||
    dType.includes("string") ||
    dType === "title" ||
    dType === "rich_text" ||
    dType === "long_text" ||
    dType === "short_text" ||
    dType === "name" ||
    dType === "url";

  if (isTextDest) {
    return { valid: true };
  }

  // Number/currency destinations
  if (dType === "number" || dType === "numeric" || dType === "currency") {
    if (sType === "currency") {
      return { valid: true };
    }
    return {
      valid: false,
      message: `Mapping a ${sType} to a numeric field might cause format or sync errors.`,
      tone: "warning"
    };
  }

  // Date destinations
  if (dType === "date" || dType === "created_time") {
    if (sType === "date") {
      return { valid: true };
    }
    return {
      valid: false,
      message: `Mapping a ${sType} to a date field will fail to parse correctly.`,
      tone: "critical"
    };
  }

  // Email destinations
  if (dType === "email") {
    if (sType === "email") {
      return { valid: true };
    }
    return {
      valid: false,
      message: `A non-email field mapped to an email property might be rejected.`,
      tone: "warning"
    };
  }

  // Phone destinations
  if (dType === "phone" || dType === "phone_number") {
    if (sType === "phone") {
      return { valid: true };
    }
    return {
      valid: false,
      message: `A non-phone field mapped to a phone property might be rejected.`,
      tone: "warning"
    };
  }

  // Dropdowns/checkboxes/selects/etc.
  if (dType === "checkbox" || dType === "boolean") {
    return {
      valid: false,
      message: `Target is a checkbox. We recommend mapping boolean/toggle values.`,
      tone: "warning"
    };
  }

  return { valid: true };
}

const EVENT_ICONS = {
  order_synced: "✓",
  order_fulfilled: "✓",
  sync_failed: "✗",
  sync_retried: "⚡",
  trial_started: "⚡",
  trial_expired: "✗",
  plan_activated: "✓",
  plan_cancelled: "✗",
  clickup_connected: "⚡",
  clickup_disconnected: "✗",
};

const EVENT_COLORS = {
  order_synced: C.accent,
  order_fulfilled: C.accent,
  sync_failed: "#ff4444",
  sync_retried: "#ff9900",
  trial_started: C.accent,
  trial_expired: "#ff4444",
  plan_activated: C.accent,
  plan_cancelled: "#ff4444",
  clickup_connected: C.accent,
  clickup_disconnected: "#ff4444",
};

const SYNC_STATUS_CONFIG = {
  active: { label: "Syncing Active", color: C.accent, bg: "rgba(0,196,140,0.12)", dot: C.accent },
  paused: { label: "Syncing Paused", color: "#ff9900", bg: "rgba(255,153,0,0.12)", dot: "#ff9900" },
  not_configured: { label: "Finish Setup", color: C.muted, bg: "rgba(154,154,154,0.1)", dot: C.muted },
};

const BANNER_COLORS = {
  green: { bg: "rgba(0,196,140,0.12)", border: "1px solid #00c48c", color: "#00c48c" },
  yellow: { bg: "rgba(255,153,0,0.12)", border: "1px solid #ff9900", color: "#ff9900" },
  orange: { bg: "rgba(255,102,0,0.12)", border: "1px solid #ff6600", color: "#ff6600" },
  red: { bg: "rgba(255,68,68,0.12)", border: "1px solid #ff4444", color: "#ff4444" },
};

function InfoTooltip({ text }) {
  const [visible, setVisible] = useState(false);

  return (
    <span
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        verticalAlign: "middle",
        cursor: "pointer",
        marginLeft: 6,
        userSelect: "none",
      }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onClick={(e) => {
        e.stopPropagation();
        setVisible(!visible);
      }}
    >
      <span style={{ color: "#9a9a9a", fontSize: 13, lineHeight: 1 }}>ⓘ</span>
      {visible && (
        <span
          style={{
            position: "absolute",
            bottom: "135%",
            left: "50%",
            transform: "translateX(-50%)",
            backgroundColor: "#1c1c1c",
            color: "#ffffff",
            padding: "8px 12px",
            borderRadius: "6px",
            border: "1px solid #333333",
            boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
            fontSize: "12px",
            lineHeight: "1.4",
            width: "220px",
            whiteSpace: "normal",
            zIndex: 99999,
            pointerEvents: "none",
            display: "block",
            textAlign: "left",
            fontWeight: "normal",
            fontStyle: "normal",
          }}
        >
          {text}
          <span
            style={{
              position: "absolute",
              top: "100%",
              left: "50%",
              transform: "translateX(-50%)",
              borderWidth: "5px",
              borderStyle: "solid",
              borderColor: "#333333 transparent transparent transparent",
            }}
          />
          <span
            style={{
              position: "absolute",
              top: "100%",
              left: "50%",
              transform: "translateX(-50%)",
              borderWidth: "4px",
              borderStyle: "solid",
              borderColor: "#1c1c1c transparent transparent transparent",
              marginTop: "-1px",
            }}
          />
        </span>
      )}
    </span>
  );
}

export default function Index() {
  const {
    shop,
    clickupConnectState,
    connected,
    healthStatus,
    selectedPlatform,
    workspaceName,
    listConnections,
    lists,
    clickupFields,
    fieldMappings,
    latestOrder,
    taskNameTemplate,
    taskDescriptionTemplate,
    syncTrigger,
    subtasksEnabled,
    twoWaySyncEnabled,
    subscription,
    trialBanner,
    isTrialOrSubscriptionActive,
    syncStatus,
    billingSuccess,
    clickupError,
    removedLists,
    listLimit,
    isFreePlan,
    failedJobsCount,
    lastSyncTime,
    syncedToday,
    analytics,
    recentActivity,
  } = useLoaderData();

  const actionData = useActionData();
  const currentPlan = PLANS[subscription.planName];
  const orderLimit = currentPlan ? currentPlan.monthlyOrderLimit : (subscription.planName === "trial" ? null : 5);
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [dismissedBanners, setDismissedBanners] = useState({});

  useEffect(() => {
    setDismissedBanners({});
  }, [actionData]);

  const renderBanner = (key, content, style) => {
    if (dismissedBanners[key]) return null;
    return (
      <div style={{ ...style, marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ flex: 1, paddingRight: 8 }}>{content}</div>
        <button
          type="button"
          onClick={() => setDismissedBanners((prev) => ({ ...prev, [key]: true }))}
          style={{
            background: "none",
            border: "none",
            color: "inherit",
            cursor: "pointer",
            fontSize: 16,
            fontWeight: "bold",
            padding: "0 4px",
            lineHeight: 1,
            opacity: 0.6,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.6")}
        >
          &times;
        </button>
      </div>
    );
  };

  const [conns, setConns] = useState(
    listConnections.length > 0
      ? listConnections
      : [{ id: "", name: "", keyword: "", routingLocationId: "", routingTag: "" }]
  );

  const [billingInterval, setBillingInterval] = useState("monthly"); // monthly or annual
  const [fieldMappingsList, setFieldMappingsList] = useState(fieldMappings || []);
  const [activeTab, setActiveTab] = useState("connections"); // connections, mappings, settings
  const [selectedTool, setSelectedTool] = useState(null);
  const [comingSoonPlatform, setComingSoonPlatform] = useState(null);
  const [localTaskTemplate, setLocalTaskTemplate] = useState(taskNameTemplate || "");
  const [localTaskDescriptionTemplate, setLocalTaskDescriptionTemplate] = useState(taskDescriptionTemplate || "");

  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);
  const [localSyncTrigger, setLocalSyncTrigger] = useState(syncTrigger || "payment_confirmed");
  const [localSubtasks, setLocalSubtasks] = useState(subtasksEnabled || false);
  const [localTwoWaySync, setLocalTwoWaySync] = useState(twoWaySyncEnabled || false);

  const compiledTemplatePreview = useMemo(() => {
    const template = localTaskTemplate.trim() || "Order {order_number} — {customer_name}";
    if (!latestOrder) return template;

    const customerName = latestOrder.customer
      ? [latestOrder.customer.first_name, latestOrder.customer.last_name].filter(Boolean).join(" ").trim() ||
        latestOrder.customer.name ||
        latestOrder.customer.email
      : "Guest";

    const shippingMethod = latestOrder.shipping_lines?.[0]?.title || "Standard Shipping";
    const itemCount = latestOrder.line_items?.length || 0;
    const orderTotal = `${latestOrder.currency || "USD"} ${latestOrder.total_price || "0.00"}`;
    const paymentStatus = latestOrder.financial_status || "paid";
    const orderNumber = String(latestOrder.order_number || latestOrder.number || latestOrder.id);

    return template
      .replace(/{order_number}/g, orderNumber)
      .replace(/{customer_name}/g, customerName)
      .replace(/{order_total}/g, orderTotal)
      .replace(/{shipping_method}/g, shippingMethod)
      .replace(/{item_count}/g, String(itemCount))
      .replace(/{payment_status}/g, paymentStatus);
  }, [localTaskTemplate, latestOrder]);

  const compiledDescriptionPreview = useMemo(() => {
    const template = localTaskDescriptionTemplate.trim();
    if (!template) return "No custom description template configured. Default order details will be synced.";
    if (!latestOrder) return template;

    const customerName = latestOrder.customer
      ? [latestOrder.customer.first_name, latestOrder.customer.last_name].filter(Boolean).join(" ").trim() ||
        latestOrder.customer.name ||
        latestOrder.customer.email
      : "Guest";

    const shippingMethod = latestOrder.shipping_lines?.[0]?.title || "Standard Shipping";
    const itemCount = latestOrder.line_items?.length || 0;
    const orderTotal = `${latestOrder.currency || "USD"} ${latestOrder.total_price || "0.00"}`;
    const paymentStatus = latestOrder.financial_status || "paid";
    const orderNumber = String(latestOrder.order_number || latestOrder.number || latestOrder.id);
    const adminOrderUrl = `https://${shop}/admin/orders/${latestOrder.id}`;

    let compiled = template;

    // 1. Pre-process line item loops: {% for item in line_items %} ... {% endfor %}
    const loopRegex = /\{%\s*for\s+(\w+)\s+in\s+line_items\s*%\}([\s\S]*?)\{%\s*endfor\s*%\}/g;
    compiled = compiled.replace(loopRegex, (_, varName, loopContent) => {
      const items = latestOrder.line_items || [];
      return items.map((item) => {
        const variant = item.variant_title ? ` (${item.variant_title})` : "";
        
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
      "order.email": latestOrder.customer?.email || latestOrder.email || "",
      "order.phone": latestOrder.customer?.phone || latestOrder.billing_address?.phone || latestOrder.shipping_address?.phone || "",
      "order.total": orderTotal,
      "order.shipping_method": shippingMethod,
      "order.item_count": String(itemCount),
      "order.payment_status": paymentStatus,
      "order.notes": latestOrder.note || "",
      "order.admin_url": adminOrderUrl,
      "order.shipping_address": latestOrder.shipping_address 
        ? [latestOrder.shipping_address.address1, latestOrder.shipping_address.city, latestOrder.shipping_address.province, latestOrder.shipping_address.zip, latestOrder.shipping_address.country].filter(Boolean).join(", ")
        : ""
    };

    for (const [key, val] of Object.entries(variables)) {
      const reg = new RegExp(`{{\\s*${key}\\s*}}`, "g");
      compiled = compiled.replace(reg, val);
    }

    return compiled;
  }, [localTaskDescriptionTemplate, latestOrder, shop]);

  const isFullySetup = connected && listConnections.length > 0;
  const [wizardStep, setWizardStep] = useState(() => {
    if (isFullySetup) return "dashboard";
    if (connected) return "select";
    if (selectedTool) return "connect";
    return "choose";
  });

  useEffect(() => {
    if (connected && listConnections.length > 0) {
      setWizardStep("dashboard");
    } else if (connected && listConnections.length === 0) {
      setWizardStep("select");
    } else if (!connected) {
      if (selectedTool) {
        setWizardStep("connect");
      } else {
        setWizardStep("choose");
      }
    }
  }, [connected, listConnections, selectedTool]);

  useEffect(() => {
    if (actionData?.saved) {
      setWizardStep("done");
    }
  }, [actionData]);

  // Close the disconnect modal only AFTER the server confirms the disconnect.
  // (Closing it on the submit button's onClick unmounts the <Form> before the
  // submit reaches the server, so the disconnect never actually fires.)
  useEffect(() => {
    if (actionData?.disconnected) {
      setShowDisconnectModal(false);
    }
  }, [actionData]);

  const applyPreset = (presetName) => {
    let matchedMappings = [];
    clickupFields.forEach((field) => {
      const fieldNameLower = field.name.toLowerCase();
      let sourceField = "";

      if (presetName === "basic") {
        if (fieldNameLower.includes("number") || fieldNameLower === "order") {
          sourceField = "order_number";
        } else if (fieldNameLower.includes("name") || fieldNameLower.includes("customer")) {
          sourceField = "customer_name";
        } else if (fieldNameLower.includes("total") || fieldNameLower.includes("price")) {
          sourceField = "total_price";
        }
      } else if (presetName === "customer") {
        if (fieldNameLower.includes("number") || fieldNameLower === "order") {
          sourceField = "order_number";
        } else if (fieldNameLower.includes("name") || fieldNameLower.includes("customer")) {
          sourceField = "customer_name";
        } else if (fieldNameLower.includes("email")) {
          sourceField = "customer_email";
        } else if (fieldNameLower.includes("phone") || fieldNameLower.includes("tel")) {
          sourceField = "customer_phone";
        } else if (fieldNameLower.includes("address") || fieldNameLower.includes("ship to")) {
          sourceField = "shipping_address";
        } else if (fieldNameLower.includes("total") || fieldNameLower.includes("price")) {
          sourceField = "total_price";
        }
      } else if (presetName === "financial") {
        if (fieldNameLower.includes("number") || fieldNameLower === "order") {
          sourceField = "order_number";
        } else if (fieldNameLower.includes("subtotal")) {
          sourceField = "subtotal_price";
        } else if (fieldNameLower.includes("shipping")) {
          sourceField = "shipping_price";
        } else if (fieldNameLower.includes("total") || fieldNameLower.includes("price")) {
          sourceField = "total_price";
        } else if (fieldNameLower.includes("note") || fieldNameLower.includes("comment")) {
          sourceField = "order_notes";
        }
      }

      if (sourceField) {
        matchedMappings.push({
          shopifySourceField: sourceField,
          clickupFieldId: field.id,
          clickupFieldName: field.name,
          clickupFieldType: field.type,
        });
      }
    });

    setFieldMappingsList(matchedMappings);
  };

  const renderProgressBar = () => {
    const activeTool = selectedTool || selectedPlatform;
    const destLabel = activeTool === "clickup"
      ? "Pick ClickUp List"
      : activeTool === "monday"
      ? "Pick Monday Board"
      : activeTool === "notion"
      ? "Pick Notion Db"
      : "Select Destination";

    const steps = [
      { key: "choose", label: "Choose Tool" },
      { key: "connect", label: "Connect Account" },
      { key: "select", label: destLabel },
      { key: "done", label: "Get Started" }
    ];
    const currentStepIndex = steps.findIndex(s => s.key === wizardStep);
    if (wizardStep === "dashboard") return null;
    return (
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, position: "relative" }}>
          {steps.map((s, idx) => {
            const isActive = s.key === wizardStep;
            const isCompleted = currentStepIndex > idx;
            return (
              <div key={s.key} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, position: "relative" }}>
                {idx > 0 && (
                  <div style={{
                    position: "absolute",
                    left: "-50%",
                    right: "50%",
                    top: 12,
                    height: 2,
                    background: currentStepIndex >= idx ? C.accent : "#2a2a2a",
                    zIndex: 1,
                  }} />
                )}
                <div style={{
                  width: 24,
                  height: 24,
                  borderRadius: "50%",
                  background: isCompleted ? C.accent : isActive ? "#151515" : "#1a1a1a",
                  border: `2px solid ${isCompleted || isActive ? C.accent : C.border}`,
                  color: isCompleted ? "#03251c" : isActive ? C.accent : C.muted,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  fontWeight: 800,
                  zIndex: 2,
                  transition: "all 0.3s ease",
                  boxShadow: isActive ? `0 0 10px ${C.accent}66` : "none",
                }}>
                  {isCompleted ? "✓" : idx + 1}
                </div>
                <span style={{
                  fontSize: 11,
                  fontWeight: isActive ? 700 : 500,
                  color: isActive ? C.text : C.muted,
                  marginTop: 6,
                  textAlign: "center",
                }}>
                  {s.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const statusCfg = SYNC_STATUS_CONFIG[syncStatus];

  const handleDisconnect = (e) => {
    // Handled via in-app confirmation modal
  };

  const getPlanDisplayName = (planName) => {
    if (planName === "trial") return "Free Trial";
    if (planName === "free") return "Free Plan";
    if (planName === "starter_monthly") return "Starter Monthly";
    if (planName === "starter_annual") return "Starter Annual";
    if (planName === "standard_monthly") return "Standard Monthly";
    if (planName === "standard_annual") return "Standard Annual";
    if (planName === "growth_monthly") return "Growth Monthly";
    if (planName === "growth_annual") return "Growth Annual";
    if (planName === "expired") return "Trial Expired";
    if (planName === "cancelled") return "Subscription Cancelled";
    return planName;
  };

  // If the trial has expired or subscription is cancelled/expired, show a full-page upgrade prompt
  const showFullPageUpgrade = connected && !isTrialOrSubscriptionActive;

  return (
    <>
      <style>{`
        @media (max-width: 600px) {
          .su-plan-row { flex-direction: column !important; align-items: flex-start !important; }
          .su-plan-btn { align-self: flex-start; }
          .su-container { padding: 24px 12px !important; }
          .su-pricing-grid { grid-template-columns: 1fr !important; }
        }
        .su-pricing-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 24px;
          margin-top: 16px;
        }
        .su-toggle-container {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 12px;
          margin-bottom: 24px;
        }
        .su-toggle-btn {
          background: transparent;
          border: 1px solid ${C.border};
          color: ${C.muted};
          padding: 8px 16px;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 600;
          font-size: 13px;
          transition: all 0.2s ease;
        }
        .su-toggle-btn.active {
          background: ${C.accent};
          color: #03251c;
          border-color: ${C.accent};
        }
        .su-platform-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
          margin-top: 16px;
          margin-bottom: 24px;
        }
        @media (max-width: 600px) {
          .su-platform-grid {
            grid-template-columns: 1fr !important;
          }
        }
        .su-platform-card {
          background: #1a1a1a;
          border: 1px solid ${C.border};
          border-radius: 14px;
          padding: 24px 16px;
          text-align: center;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          position: relative;
        }
        .su-platform-card:hover {
          transform: translateY(-2px);
        }
        .su-platform-card.clickup:hover, .su-platform-card.clickup.selected {
          border-color: #7b61ff;
          box-shadow: 0 4px 20px rgba(123, 97, 255, 0.15);
          background: rgba(123, 97, 255, 0.03);
        }
        .su-platform-card.monday:hover, .su-platform-card.monday.selected {
          border-color: #ff3d57;
          box-shadow: 0 4px 20px rgba(255, 61, 87, 0.15);
          background: rgba(255, 61, 87, 0.03);
        }
        .su-platform-card.notion:hover, .su-platform-card.notion.selected {
          border-color: #ffffff;
          box-shadow: 0 4px 20px rgba(255, 255, 255, 0.15);
          background: rgba(255, 255, 255, 0.03);
        }
        .su-platform-badge {
          font-size: 9px;
          font-weight: 700;
          text-transform: uppercase;
          padding: 2px 8px;
          border-radius: 12px;
          letter-spacing: 0.05em;
        }
        .su-platform-badge.live {
          color: ${C.accent};
          background: rgba(0, 196, 140, 0.12);
          border: 1px solid rgba(0, 196, 140, 0.3);
        }
        .su-platform-badge.coming-soon {
          color: #ff9900;
          background: rgba(255, 153, 0, 0.12);
          border: 1px solid rgba(255, 153, 0, 0.3);
        }
        .su-dashboard-grid {
          display: grid;
          grid-template-columns: 1.25fr 0.75fr;
          gap: 20px;
          align-items: start;
        }
        @media (max-width: 900px) {
          .su-dashboard-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>

      <div style={styles.page}>
        <div style={{ ...styles.container, maxWidth: wizardStep === "dashboard" ? 1200 : 640 }} className="su-container">
          {/* Header */}
          <header style={styles.header}>
            <div style={styles.logoMark}>
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke={C.accent}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" />
                <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
              </svg>
            </div>
            <div style={{ flex: 1 }}>
              <h1 style={styles.title}>SyncUp</h1>
              <p style={styles.subtitle}>
                {wizardStep === "dashboard"
                  ? "Automatically sync your Shopify orders to ClickUp, Monday, or Notion."
                  : "Automatically sync your Shopify orders. Setup takes about 2 minutes."}
              </p>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
              <div
                style={{
                  ...styles.statusBadge,
                  color: statusCfg.color,
                  background: statusCfg.bg,
                  border: `1px solid ${statusCfg.color}44`,
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: statusCfg.color,
                    display: "inline-block",
                    marginRight: 6,
                    flexShrink: 0,
                  }}
                />
                {statusCfg.label}
              </div>
              {wizardStep === "dashboard" && lastSyncTime && (
                <span style={{ fontSize: 11, color: C.muted }}>
                  Last sync: {timeAgo(lastSyncTime)}
                </span>
              )}
            </div>
          </header>

          {/* Trial Banners */}
          {trialBanner && (
            <div
              style={{
                ...styles.banner,
                ...BANNER_COLORS[trialBanner.color],
                marginBottom: 16,
              }}
            >
              {trialBanner.message}
            </div>
          )}

          {/* Action/Success Banners */}
          {billingSuccess && renderBanner("billingSuccess", "✓ Your plan has been updated successfully.", styles.successBanner)}
          {actionData?.sentTestTask && renderBanner("sentTestTask", `✓ Test task successfully sent! Check your connected ${selectedPlatform === "clickup" ? "ClickUp list" : selectedPlatform === "monday" ? "Monday board" : "Notion database"}.`, styles.successBanner)}
          {actionData?.retriedAllFailed && renderBanner("retriedAllFailed", `✓ Successfully re-enqueued ${actionData.retriedCount} failed sync job(s) for processing.`, styles.successBanner)}
          {actionData?.savedSettings && renderBanner("savedSettings", "✓ Sync settings saved successfully.", styles.successBanner)}
          {actionData?.saved && renderBanner("savedConnections", "✓ Connections and keyword routing saved successfully.", styles.successBanner)}
          {removedLists && renderBanner("removedLists", <span>⚠️ Downgraded to Standard plan. The following extra list connections were removed: <strong>{removedLists}</strong></span>, styles.warningBanner)}
          {(clickupError || actionData?.error) && renderBanner("actionError", clickupError || actionData?.error, styles.errorBanner)}
          {healthStatus === "error" && renderBanner(
            "healthError",
            <span>⚠️ {selectedPlatform === "clickup" ? "ClickUp" : selectedPlatform === "monday" ? "Monday.com" : "Notion"} Connection Lost. Your API Token has expired or the target list was deleted. Please check your connections.</span>,
            styles.errorBanner
          )}

          {showFullPageUpgrade ? (
            /* SECTION 2 (Pricing cards) shown as full-page settings overlay */
            <section className="bg-zinc-900/40 border border-zinc-800 rounded-3xl p-8 max-w-6xl mx-auto shadow-2xl backdrop-blur-md">
              <div className="text-center mb-8 max-w-2xl mx-auto">
                <h2 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight mb-2">
                  Activate a subscription to resume syncing
                </h2>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  SyncUp has paused order task creation because you do not have an active subscription. Choose a plan below to unlock syncing immediately.
                </p>
              </div>

              {/* Launch Special / Urgency Banner */}
              <div className="bg-emerald-950/20 border border-emerald-500/30 text-emerald-400 p-4 rounded-xl text-xs sm:text-sm flex items-start gap-3 mb-10 max-w-3xl mx-auto shadow-md">
                <span className="text-lg leading-none">🚀</span>
                <div>
                  <strong className="font-semibold block mb-0.5 text-emerald-300">LAUNCH SPECIAL OFFER</strong>
                  Install today to lock in these discounted B2B rates forever. Once our beta ends, pricing will increase for new installs. Existing merchants will remain grandfathered on these plans indefinitely!
                </div>
              </div>

              {/* Toggle */}
              <div className="flex justify-center items-center gap-3 mb-10">
                <span className={`text-xs font-semibold transition-colors duration-200 ${billingInterval === "monthly" ? "text-zinc-100" : "text-zinc-500"}`}>
                  Monthly Billing
                </span>
                <button
                  type="button"
                  className="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none bg-zinc-800"
                  onClick={() => setBillingInterval(billingInterval === "monthly" ? "annual" : "monthly")}
                  role="switch"
                  aria-checked={billingInterval === "annual"}
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-emerald-400 shadow ring-0 transition duration-200 ease-in-out ${
                      billingInterval === "annual" ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
                <span className={`text-xs font-semibold transition-colors duration-200 ${billingInterval === "annual" ? "text-emerald-400" : "text-zinc-500"}`}>
                  Annual Billing <span className="bg-emerald-500/10 text-emerald-400 text-[10px] px-2 py-0.5 rounded-full font-bold ml-1 border border-emerald-400/20">Save ~30%</span>
                </span>
              </div>

              {/* Pricing Cards Grid */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
                {["standard", "growth", "pro"].map((key) => {
                  const planKey = `${key}_${billingInterval}`;
                  const plan = PLANS[planKey];
                  if (!plan) return null;
                  const isHighlighted = key === "growth";

                  // Single source of truth: all display values derive from plans.js (PLANS).
                  // The merchant is charged plan.price; the headline here always matches it.
                  // regMonthly/regAnnual are the strike-through "regular" price (plan.regularPrice).
                  const overlayBadges = {
                    standard: "Best for Starters",
                    growth: "Most Popular",
                    pro: "Concierge Setup Included",
                  };

                  const monthlyPlan = PLANS[`${key}_monthly`];
                  const annualPlan = PLANS[`${key}_annual`];

                  const displayPrice = billingInterval === "annual"
                    ? `$${(annualPlan.price / 12).toFixed(2)}/mo`
                    : `$${monthlyPlan.price.toFixed(2)}/mo`;

                  const regularPrice = billingInterval === "annual"
                    ? (annualPlan.regularPrice ? `$${annualPlan.regularPrice.toFixed(2)}` : null)
                    : (monthlyPlan.regularPrice ? `$${monthlyPlan.regularPrice.toFixed(2)}` : null);

                  const billedDesc = billingInterval === "annual"
                    ? `Billed annually as $${annualPlan.price}`
                    : null;

                  return (
                    <div
                      key={key}
                      className={`bg-zinc-950/45 border rounded-2xl p-6 flex flex-col justify-between transition-all duration-300 relative ${
                        isHighlighted 
                          ? "border-emerald-500/40 shadow-xl shadow-emerald-950/15 hover:border-emerald-500/60" 
                          : "border-zinc-800 hover:border-zinc-700"
                      }`}
                    >
                      {isHighlighted && (
                        <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-emerald-500 text-zinc-950 text-[10px] font-black uppercase tracking-wider px-3.5 py-1 rounded-full shadow-lg shadow-emerald-500/20">
                          {overlayBadges[key]}
                        </div>
                      )}

                      <div>
                        <div className="mb-4">
                          <span className="text-zinc-500 text-[10px] font-semibold tracking-wider uppercase block mb-1">
                            {key} tier
                          </span>
                          <h3 className="text-base font-bold text-white tracking-tight">{plan.name}</h3>
                        </div>

                        {/* Price */}
                        <div className="mb-6">
                          <div className="flex items-baseline flex-wrap gap-1">
                            {regularPrice && (
                              <span className="text-xs text-zinc-500 line-through mr-1 font-medium">
                                {regularPrice}
                              </span>
                            )}
                            <span className="text-2xl font-extrabold text-white tracking-tight">
                              {displayPrice.split("/")[0]}
                            </span>
                            <span className="text-zinc-400 text-xs font-medium">
                              /{displayPrice.split("/")[1]}
                            </span>
                          </div>

                          {/* Annual details */}
                          {billingInterval === "annual" && billedDesc && (
                            <div className="text-[10px] text-zinc-400 mt-1.5 font-medium flex items-center gap-1">
                              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                              {billedDesc} (${(monthlyPlan.price).toFixed(2)}/mo equivalent)
                            </div>
                          )}
                        </div>

                        {/* Divider */}
                        <div className="h-px bg-zinc-800/80 mb-5"></div>

                        {/* Features */}
                        <ul className="space-y-3 mb-6 text-xs text-zinc-300">
                          {getTranslatedFeatures(plan.features, selectedPlatform).map((feat) => (
                            <li key={feat} className="flex items-start">
                              <span className="text-emerald-400 mr-2 flex-shrink-0 font-bold">✓</span>
                              <span className="leading-snug">{feat}</span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      {/* Submit action */}
                      <Link
                        to={`/app/billing?platform=${selectedPlatform}`}
                        className={`w-full py-2.5 rounded-xl text-xs font-bold text-center block transition-all duration-200 hover:scale-[1.02] cursor-pointer ${
                          isHighlighted
                            ? "bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-extrabold shadow-lg shadow-emerald-500/10"
                            : "bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700 hover:border-zinc-600"
                        }`}
                        style={{ textDecoration: "none" }}
                      >
                        Select {plan.name.split(" ")[0]}
                      </Link>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : (
            <>{wizardStep !== "dashboard" ? (
                <div>
                  {renderProgressBar()}

                  {/* Step 1: Choose Tool */}
                  {wizardStep === "choose" && (
                    <section style={{ ...styles.card, marginBottom: 24 }}>
                      <h2 style={{ ...styles.cardTitle, marginTop: 0, textAlign: "center" }}>Choose your Workspace Tool</h2>
                      <p style={{ ...styles.cardText, textAlign: "center", marginBottom: 24 }}>
                        Select the project management platform you want to sync your Shopify orders to.
                      </p>

                      {comingSoonPlatform && (
                        <div style={{ ...styles.warningBanner, marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div style={{ flex: 1, paddingRight: 8 }}>
                            ⚠️ <strong>{comingSoonPlatform}</strong> integration is coming soon! For now, please connect ClickUp to start syncing your Shopify orders.
                          </div>
                          <button
                            type="button"
                            onClick={() => setComingSoonPlatform(null)}
                            style={{
                              background: "none",
                              border: "none",
                              color: "inherit",
                              cursor: "pointer",
                              fontSize: 16,
                              fontWeight: "bold",
                              padding: "0 4px",
                              lineHeight: 1,
                              opacity: 0.6,
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                            onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.6")}
                          >
                            &times;
                          </button>
                        </div>
                      )}

                      <div className="su-platform-grid">
                        {/* ClickUp */}
                        <button
                          type="button"
                          className="su-platform-card clickup"
                          onClick={() => {
                            setComingSoonPlatform(null);
                            setSelectedTool("clickup");
                            setWizardStep("connect");
                          }}
                          style={{ background: "none", width: "100%", outline: "none", color: "inherit", font: "inherit", border: `1px solid ${C.border}` }}
                        >
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                            <div style={{ width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                                <path d="M5 9L12 3L19 9" stroke="#7b61ff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M12 14C9.5 14 7.5 16 7.5 18.5C7.5 20.5 9 21 12 21C15 21 16.5 20.5 16.5 18.5C16.5 16 14.5 14 12 14Z" fill="#7b61ff" />
                              </svg>
                            </div>
                            <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>ClickUp</span>
                          </div>
                          <span className="su-platform-badge live">Live</span>
                        </button>

                        {/* Monday.com */}
                        <button
                          type="button"
                          className="su-platform-card monday"
                          onClick={() => {
                            setComingSoonPlatform("Monday.com");
                          }}
                          style={{ background: "none", width: "100%", outline: "none", color: "inherit", font: "inherit", border: `1px solid ${C.border}` }}
                        >
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                            <div style={{ width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                                <rect x="5" y="10" width="30" height="6" rx="3" fill="#ff3d57" />
                                <rect x="5" y="20" width="30" height="6" rx="3" fill="#ffcb00" />
                                <rect x="5" y="30" width="30" height="6" rx="3" fill="#00cff4" />
                              </svg>
                            </div>
                            <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Monday.com</span>
                          </div>
                          <span className="su-platform-badge coming-soon">Coming Soon</span>
                        </button>

                        {/* Notion */}
                        <button
                          type="button"
                          className="su-platform-card notion"
                          onClick={() => {
                            setComingSoonPlatform("Notion");
                          }}
                          style={{ background: "none", width: "100%", outline: "none", color: "inherit", font: "inherit", border: `1px solid ${C.border}` }}
                        >
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                            <div style={{ width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="3" y="3" width="18" height="18" rx="4" />
                                <path d="M9 17V7l6 10V7" />
                              </svg>
                            </div>
                            <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Notion</span>
                          </div>
                          <span className="su-platform-badge coming-soon">Coming Soon</span>
                        </button>
                      </div>
                    </section>
                  )}

                  {/* Step 2: Connect platform */}
                  {wizardStep === "connect" && (
                    <div>
                      <div style={{ marginBottom: 16 }}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedTool(null);
                            setWizardStep("choose");
                          }}
                          style={{
                            background: "none",
                            color: C.accent,
                            cursor: "pointer",
                            fontSize: 14,
                            fontWeight: 600,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "6px 12px",
                            borderRadius: "8px",
                            backgroundColor: "rgba(0, 196, 140, 0.06)",
                            border: "1px solid rgba(0, 196, 140, 0.15)",
                            outline: "none",
                          }}
                        >
                          &larr; Back to tool selector
                        </button>
                      </div>

                      {/* ClickUp configuration and billing */}
                      {selectedTool === "clickup" && (
                        <section style={styles.card}>
                          <h2 style={{ ...styles.cardTitle, marginTop: 0 }}>Connect ClickUp Workspace</h2>
                          
                          {!isTrialOrSubscriptionActive ? (
                            <div>
                              <p style={{ ...styles.cardText, marginBottom: 24 }}>
                                SyncUp has paused task creation because you do not have an active subscription. Choose a plan below to unlock ClickUp connection and start syncing.
                              </p>

                              {/* Toggle */}
                              <div className="flex justify-center items-center gap-3 mb-8">
                                <span className={`text-xs font-semibold transition-colors duration-200 ${billingInterval === "monthly" ? "text-zinc-100" : "text-zinc-500"}`}>
                                  Monthly Billing
                                </span>
                                <button
                                  type="button"
                                  className="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none bg-zinc-800"
                                  onClick={() => setBillingInterval(billingInterval === "monthly" ? "annual" : "monthly")}
                                  role="switch"
                                  aria-checked={billingInterval === "annual"}
                                >
                                  <span
                                    aria-hidden="true"
                                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-emerald-400 shadow ring-0 transition duration-200 ease-in-out ${
                                      billingInterval === "annual" ? "translate-x-5" : "translate-x-0"
                                    }`}
                                  />
                                </button>
                                <span className={`text-xs font-semibold transition-colors duration-200 ${billingInterval === "annual" ? "text-emerald-400" : "text-zinc-500"}`}>
                                  Annual Billing <span className="bg-emerald-500/10 text-emerald-400 text-[10px] px-2 py-0.5 rounded-full font-bold ml-1 border border-emerald-400/20">Save ~30%</span>
                                </span>
                              </div>

                              {/* Pricing Cards Grid */}
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
                                {["standard", "growth", "pro"].map((key) => {
                                  const planKey = `${key}_${billingInterval}`;
                                  const plan = PLANS[planKey];
                                  if (!plan) return null;
                                  const isHighlighted = key === "growth";
                                  
                                  const overlayBadges = {
                                    standard: "Best for Starters",
                                    growth: "Most Popular",
                                    pro: "Concierge Setup Included",
                                  };

                                  const monthlyPlan = PLANS[`${key}_monthly`];
                                  const annualPlan = PLANS[`${key}_annual`];

                                  const displayPrice = billingInterval === "annual"
                                    ? `$${(annualPlan.price / 12).toFixed(2)}/mo`
                                    : `$${monthlyPlan.price.toFixed(2)}/mo`;

                                  const regularPrice = billingInterval === "annual"
                                    ? (annualPlan.regularPrice ? `$${annualPlan.regularPrice.toFixed(2)}` : null)
                                    : (monthlyPlan.regularPrice ? `$${monthlyPlan.regularPrice.toFixed(2)}` : null);

                                  const billedDesc = billingInterval === "annual"
                                    ? `Billed annually as $${annualPlan.price}`
                                    : null;

                                  return (
                                    <div
                                      key={key}
                                      className={`bg-zinc-950/45 border rounded-2xl p-6 flex flex-col justify-between transition-all duration-300 relative ${
                                        isHighlighted 
                                          ? "border-emerald-500/40 shadow-xl shadow-emerald-950/15 hover:border-emerald-500/60" 
                                          : "border-zinc-800 hover:border-zinc-700"
                                      }`}
                                      style={{ border: isHighlighted ? "1px solid rgba(16, 185, 129, 0.4)" : `1px solid ${C.border}`, background: "#0f0f0f" }}
                                    >
                                      {isHighlighted && (
                                        <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-emerald-500 text-zinc-950 text-[10px] font-black uppercase tracking-wider px-3.5 py-1 rounded-full shadow-lg shadow-emerald-500/20">
                                          {overlayBadges[key]}
                                        </div>
                                      )}

                                      <div>
                                        <div className="mb-4">
                                          <span className="text-zinc-500 text-[10px] font-semibold tracking-wider uppercase block mb-1">
                                            {key} tier
                                          </span>
                                          <h3 className="text-base font-bold text-white tracking-tight">{plan.name}</h3>
                                        </div>

                                        {/* Price */}
                                        <div className="mb-6">
                                          <div className="flex items-baseline flex-wrap gap-1">
                                            {regularPrice && (
                                              <span className="text-xs text-zinc-500 line-through mr-1 font-medium">
                                                {regularPrice}
                                              </span>
                                            )}
                                            <span className="text-2xl font-extrabold text-white tracking-tight">
                                              {displayPrice.split("/")[0]}
                                            </span>
                                            <span className="text-zinc-400 text-xs font-medium">
                                              /{displayPrice.split("/")[1]}
                                            </span>
                                          </div>

                                          {/* Annual details */}
                                          {billingInterval === "annual" && billedDesc && (
                                            <div className="text-[10px] text-zinc-400 mt-1.5 font-medium flex items-center gap-1">
                                              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                                              {billedDesc} (${(monthlyPlan.price).toFixed(2)}/mo equivalent)
                                            </div>
                                          )}
                                        </div>

                                        {/* Divider */}
                                        <div className="h-px bg-zinc-800/80 mb-5" style={{ background: C.border }}></div>

                                        {/* Features translated dynamically */}
                                        <ul className="space-y-3 mb-6 text-xs text-zinc-300" style={{ listStyle: "none", padding: 0 }}>
                                          {getTranslatedFeatures(plan.features, selectedTool).map((feat) => (
                                            <li key={feat} className="flex items-start">
                                              <span className="text-emerald-400 mr-2 flex-shrink-0 font-bold">✓</span>
                                              <span className="leading-snug">{feat}</span>
                                            </li>
                                          ))}
                                        </ul>
                                      </div>

                                      {/* Submit action */}
                                      <Link
                                        to={`/app/billing?platform=clickup`}
                                        className={`w-full py-2.5 rounded-xl text-xs font-bold text-center block transition-all duration-200 hover:scale-[1.02] cursor-pointer ${
                                          isHighlighted
                                            ? "bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-extrabold shadow-lg shadow-emerald-500/10"
                                            : "bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700 hover:border-zinc-600"
                                        }`}
                                        style={{
                                          border: isHighlighted ? "none" : `1px solid ${C.border}`,
                                          background: isHighlighted ? C.accent : "#1a1a1a",
                                          color: isHighlighted ? "#03251c" : C.text,
                                          width: "100%",
                                          textDecoration: "none"
                                        }}
                                      >
                                        Select {plan.name.split(" ")[0]}
                                      </Link>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ) : (
                            <>
                              <p style={styles.cardText}>
                                Connect ClickUp to start syncing new orders into a list of your
                                choice. New orders become tasks, fulfilled orders get marked
                                complete — automatically.
                              </p>
                              <a
                                href={`/auth/clickup?state=${encodeURIComponent(clickupConnectState)}`}
                                target="_top"
                                style={{ ...styles.primaryButton, display: "inline-flex", alignItems: "center", gap: 8 }}
                              >
                                <span>Connect ClickUp</span>
                                <span style={{ fontSize: 11 }}>&rarr;</span>
                              </a>
                            </>
                          )}
                        </section>
                      )}

                      {/* Monday.com / Notion active connection forms */}
                      {(selectedTool === "monday" || selectedTool === "notion") && (
                        <section style={styles.card}>
                          <h2 style={{ ...styles.cardTitle, marginTop: 0 }}>
                            Connect {selectedTool === "monday" ? "Monday.com" : "Notion"}
                          </h2>
                          
                          <p style={styles.cardText}>
                            {selectedTool === "monday"
                              ? "Enter your Monday.com Personal Access Token to connect your account. You can find this token in your Monday.com account under Administration > API."
                              : "Enter your Notion Integration Token to connect your account. You can create an integration token at developers.notion.com/my-integrations."}
                          </p>

                          {selectedTool === "notion" && (
                            <div style={{ ...styles.errorBanner, background: "rgba(150,150,150,0.08)", color: "#cfcfcc", marginTop: 12 }}>
                              Note: Notion sync is one-way. Orders are sent to Notion, but completing a Notion page will not auto-fulfill the Shopify order.
                            </div>
                          )}

                          {actionData?.error && (
                            <div style={{ ...styles.errorBanner, marginTop: 12, marginBottom: 12 }}>
                              {actionData.error}
                            </div>
                          )}

                          <Form method="post" style={{ ...styles.form, marginTop: 16 }}>
                            <input type="hidden" name="intent" value="connect_platform" />
                            <input type="hidden" name="platform" value={selectedTool} />
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              <label style={styles.formLabel} htmlFor="platform_token">
                                {selectedTool === "monday" ? "Monday.com Personal Access Token" : "Notion Integration Token"}{" "}
                                <InfoTooltip text={selectedTool === "monday" ? "A secure personal access token generated from your Monday.com developer settings." : "A secure integration token generated from your Notion developer settings."} />
                              </label>
                              <input
                                id="platform_token"
                                name="token"
                                type="password"
                                required
                                placeholder={selectedTool === "monday" ? "e.g. eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." : "e.g. secret_abc123xyz..."}
                                style={styles.input}
                              />
                            </div>
                            <button
                              type="submit"
                              style={{ ...styles.primaryButton, width: "100%", marginTop: 12 }}
                              disabled={isSubmitting}
                            >
                              {isSubmitting ? "Connecting..." : `Connect ${selectedTool === "monday" ? "Monday.com" : "Notion"}`}
                            </button>
                          </Form>
                        </section>
                      )}
                    </div>
                  )}

                  {/* Step 3: Select destination */}
                  {wizardStep === "select" && (
                    <section style={styles.card}>
                      <div style={styles.cardHeaderRow}>
                        <div style={styles.statusRow}>
                          <span style={styles.statusDot} />
                          <span style={styles.statusText}>
                            {workspaceName
                              ? `Connected to ${workspaceName}`
                              : `${selectedPlatform === "clickup" ? "ClickUp" : selectedPlatform === "monday" ? "Monday.com" : "Notion"} connected`}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowDisconnectModal(true)}
                          style={styles.dangerButton}
                          disabled={isSubmitting}
                        >
                          Disconnect
                        </button>
                      </div>

                      <h2 style={styles.cardTitle}>Configure order {selectedPlatform === "clickup" ? "list" : selectedPlatform === "monday" ? "board" : "database"} connections</h2>
                      <p style={styles.cardText}>
                        Select where new orders should sync. Growth plan merchants can configure up to 5 {selectedPlatform === "clickup" ? "lists" : selectedPlatform === "monday" ? "boards" : "databases"} with keyword filters to route orders automatically.
                      </p>

                      {lists.length === 0 ? (
                        <p style={styles.cardText}>
                          No {selectedPlatform === "clickup" ? "lists" : selectedPlatform === "monday" ? "boards" : "databases"} found in workspaces. Create one first then reload this page.
                        </p>
                      ) : (
                        <Form method="post" style={styles.form}>
                          <input type="hidden" name="intent" value="save_connections" />
                          <input type="hidden" name="listConnectionsJson" value={JSON.stringify(conns)} />

                          <div style={styles.connectionsContainer}>
                            {conns.map((conn, index) => (
                              <div key={index} style={styles.connectionRow}>
                                <div style={{ flex: 2, minWidth: "150px" }}>
                                  <label style={styles.formLabel} htmlFor={`list_${index}`}>
                                    {selectedPlatform === "clickup" ? "ClickUp List" : selectedPlatform === "monday" ? "Monday Board" : "Notion Database"}{" "}
                                    <InfoTooltip text={`The specific destination ${selectedPlatform === "clickup" ? "list" : selectedPlatform === "monday" ? "board" : "database"} where synced order tasks will be created.`} />
                                  </label>
                                  <select
                                    id={`list_${index}`}
                                    value={conn.id}
                                    onChange={(e) => {
                                      const selectedId = e.currentTarget.value;
                                      const match = lists.find((l) => l.id === selectedId);
                                      const updated = [...conns];
                                      updated[index] = {
                                        ...conn,
                                        id: selectedId,
                                        name: match ? match.name : "",
                                      };
                                      setConns(updated);
                                    }}
                                    style={styles.select}
                                  >
                                    <option value="">Select...</option>
                                    {lists.map((list) => (
                                      <option key={list.id} value={list.id}>
                                        {list.name}
                                      </option>
                                    ))}
                                  </select>
                                </div>

                                {listLimit > 1 && (
                                  <>
                                    <div style={{ flex: 1, minWidth: "120px" }}>
                                      <label style={styles.formLabel} htmlFor={`kw_${index}`}>
                                        Product Keyword <InfoTooltip text="Only route orders containing products whose title, vendor, or SKU matches this word (e.g. 'boot')." />
                                      </label>
                                      <input
                                        id={`kw_${index}`}
                                        type="text"
                                        placeholder="e.g. Shoes or Vendor"
                                        value={conn.keyword || ""}
                                        onChange={(e) => {
                                          const updated = [...conns];
                                          updated[index] = { ...conn, keyword: e.currentTarget.value };
                                          setConns(updated);
                                        }}
                                        style={styles.input}
                                        className="border border-zinc-800"
                                      />
                                    </div>
                                    <div style={{ flex: 1, minWidth: "120px" }}>
                                      <label style={styles.formLabel} htmlFor={`loc_${index}`}>
                                        Location ID <InfoTooltip text="Only route orders if they are fulfilled from this physical Shopify warehouse/location ID." />
                                      </label>
                                      <input
                                        id={`loc_${index}`}
                                        type="text"
                                        placeholder="Shopify Location ID"
                                        value={conn.routingLocationId || ""}
                                        onChange={(e) => {
                                          const updated = [...conns];
                                          updated[index] = { ...conn, routingLocationId: e.currentTarget.value };
                                          setConns(updated);
                                        }}
                                        style={styles.input}
                                        className="border border-zinc-800"
                                      />
                                    </div>
                                    <div style={{ flex: 1, minWidth: "120px" }}>
                                      <label style={styles.formLabel} htmlFor={`tag_${index}`}>
                                        Order Tag <InfoTooltip text="Only route orders that carry this specific Shopify order tag or product tag (e.g. 'B2B')." />
                                      </label>
                                      <input
                                        id={`tag_${index}`}
                                        type="text"
                                        placeholder="Order/product tag name"
                                        value={conn.routingTag || ""}
                                        onChange={(e) => {
                                          const updated = [...conns];
                                          updated[index] = { ...conn, routingTag: e.currentTarget.value };
                                          setConns(updated);
                                        }}
                                        style={styles.input}
                                        className="border border-zinc-800"
                                      />
                                    </div>
                                  </>
                                )}

                                {listLimit > 1 && conns.length > 1 && (
                                  <button
                                    type="button"
                                    onClick={() => setConns(conns.filter((_, i) => i !== index))}
                                    style={styles.removeConnButton}
                                  >
                                    Remove
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>

                          {conns.length < listLimit && (
                            <button
                              type="button"
                              onClick={() => setConns([...conns, { id: lists[0]?.id || "", name: lists[0]?.name || "", keyword: "", routingLocationId: "", routingTag: "" }])}
                              style={styles.addConnButton}
                            >
                              + Add connection
                            </button>
                          )}

                          <button
                            type="submit"
                            style={styles.primaryButton}
                            disabled={isSubmitting}
                          >
                            {isSubmitting ? "Saving…" : "Save connections"}
                          </button>
                        </Form>
                      )}
                    </section>
                  )}

                  {/* Step 4: Done */}
                  {wizardStep === "done" && (
                    <section style={{ ...styles.card, textAlign: "center", padding: "48px 32px" }}>
                      <div style={{
                        width: 64,
                        height: 64,
                        borderRadius: "50%",
                        background: "rgba(0, 196, 140, 0.12)",
                        border: `2px solid ${C.accent}`,
                        color: C.accent,
                        fontSize: 32,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        marginBottom: 20,
                      }}>
                        🎉
                      </div>
                      <h2 style={{ ...styles.cardTitle, marginTop: 0 }}>Setup complete!</h2>
                      <p style={{ ...styles.cardText, maxWidth: 480, margin: "0 auto 24px", fontSize: 14, lineHeight: "1.6" }}>
                        SyncUp is now watching for new orders. Want to see it in action right now?
                      </p>

                      {actionData?.sentTestTask && (
                        <div style={{ ...styles.successBanner, marginBottom: 24, textAlign: "left" }}>
                          {`✓ Test task successfully sent! Check your connected ${selectedPlatform === "clickup" ? "ClickUp list" : selectedPlatform === "monday" ? "Monday board" : "Notion database"}.`}
                        </div>
                      )}

                      <div style={{ display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
                        <Form method="post" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="send_test_task" />
                          <button
                            type="submit"
                            style={styles.primaryButton}
                            disabled={isSubmitting}
                          >
                            {isSubmitting ? "Sending..." : `Send a test task → see it in ${selectedPlatform === "clickup" ? "ClickUp" : selectedPlatform === "monday" ? "Monday" : "Notion"} now`}
                          </button>
                        </Form>
                        <button
                          type="button"
                          onClick={() => setWizardStep("dashboard")}
                          style={{ ...styles.dangerButton, height: "fit-content", padding: "12px 22px" }}
                        >
                          Skip, go to Dashboard
                        </button>
                      </div>
                    </section>
                  )}
                </div>
              ) : (
                /* OPERATIONAL DASHBOARD: Two-Column Layout */
                <div>
                  {/* SECTION 1 — PLAN STATUS (active paid/trial merchants only) */}
                  <section style={{ ...styles.card, marginBottom: 20 }}>
                    <div style={styles.planRow} className="su-plan-row">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={styles.planLabel}>Current plan</div>
                        <div style={styles.planName}>
                          {getPlanDisplayName(subscription.planName)}
                          {subscription.planName !== "trial" && (
                            <span style={styles.paidBadge}>Active</span>
                          )}
                        </div>
                        {subscription.planName === "trial" ? (
                          <div style={styles.usageText}>
                            Your 7-day trial ends on {subscription.trialEndDate ? new Date(subscription.trialEndDate).toLocaleDateString() : ""}
                          </div>
                        ) : (
                          <div style={styles.usageText}>
                            Billing cycle started on {subscription.billingCycleStart ? new Date(subscription.billingCycleStart).toLocaleDateString() : ""}
                          </div>
                        )}
                      </div>
                      <Link
                        to={`/app/billing?platform=${selectedPlatform}`}
                        style={styles.managePlanButton}
                        className="su-plan-btn"
                      >
                        Manage billing
                      </Link>
                    </div>
                  </section>

                  {/* Failed sync jobs banner/card */}
                  {failedJobsCount > 0 && (
                    <div style={{
                      background: "rgba(255, 68, 68, 0.12)",
                      border: "1px solid #ff4444",
                      borderRadius: 16,
                      padding: "16px 24px",
                      marginBottom: 20,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 16,
                      flexWrap: "wrap",
                    }}>
                      <div style={{ flex: 1, minWidth: "250px" }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: "#ff4444", display: "flex", alignItems: "center", gap: 6 }}>
                          <span>⚠️</span>
                          <span>{failedJobsCount} order sync{failedJobsCount > 1 ? "s" : ""} failed</span>
                        </div>
                        <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
                          Some orders could not be synced to your connected workspace due to connection issues or mapping errors.
                        </div>
                      </div>
                      <Form method="post" style={{ display: "inline" }}>
                        <input type="hidden" name="intent" value="retry_all_failed_syncs" />
                        <button
                          type="submit"
                          disabled={isSubmitting}
                          style={{
                            background: "#ff4444",
                            color: "#ffffff",
                            border: "none",
                            borderRadius: 8,
                            padding: "10px 16px",
                            fontSize: 12,
                            fontWeight: 700,
                            cursor: "pointer",
                            transition: "all 0.2s",
                          }}
                        >
                          {isSubmitting ? "Retrying..." : "Retry Now →"}
                        </button>
                      </Form>
                    </div>
                  )}

                  {/* TWO-COLUMN GRID */}
                  <div className="su-dashboard-grid">
                    {/* LEFT COLUMN: Settings & Custom Field Mapping */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                      
                      {/* Tab Navigation */}
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", borderBottom: `1px solid ${C.border}`, paddingBottom: 16, marginBottom: 4 }}>
                        <button
                          type="button"
                          onClick={() => setActiveTab("connections")}
                          style={{
                            background: activeTab === "connections" ? C.accent : "rgba(255, 255, 255, 0.03)",
                            color: activeTab === "connections" ? "#03251c" : C.muted,
                            border: `1px solid ${activeTab === "connections" ? C.accent : C.border}`,
                            padding: "10px 18px",
                            borderRadius: 10,
                            cursor: "pointer",
                            fontWeight: 700,
                            fontSize: 13,
                            transition: "all 0.2s ease",
                            outline: "none"
                          }}
                        >
                          🔌 Connections & Routing
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveTab("mappings")}
                          style={{
                            background: activeTab === "mappings" ? C.accent : "rgba(255, 255, 255, 0.03)",
                            color: activeTab === "mappings" ? "#03251c" : C.muted,
                            border: `1px solid ${activeTab === "mappings" ? C.accent : C.border}`,
                            padding: "10px 18px",
                            borderRadius: 10,
                            cursor: "pointer",
                            fontWeight: 700,
                            fontSize: 13,
                            transition: "all 0.2s ease",
                            outline: "none"
                          }}
                        >
                          📋 Map Shopify Fields
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveTab("settings")}
                          style={{
                            background: activeTab === "settings" ? C.accent : "rgba(255, 255, 255, 0.03)",
                            color: activeTab === "settings" ? "#03251c" : C.muted,
                            border: `1px solid ${activeTab === "settings" ? C.accent : C.border}`,
                            padding: "10px 18px",
                            borderRadius: 10,
                            cursor: "pointer",
                            fontWeight: 700,
                            fontSize: 13,
                            transition: "all 0.2s ease",
                            outline: "none"
                          }}
                        >
                          ⚙️ Sync Settings
                        </button>
                      </div>

                      {activeTab === "connections" && (
                        <>
                          {/* Connection status card */}
                          <section style={styles.card}>
                        <div style={styles.cardHeaderRow}>
                          <div style={styles.statusRow}>
                            <span style={styles.statusDot} />
                            <span style={styles.statusText}>
                              {workspaceName
                                ? `Connected to ${workspaceName}`
                                : `${selectedPlatform === "clickup" ? "ClickUp" : selectedPlatform === "monday" ? "Monday.com" : "Notion"} connected`}
                            </span>
                          </div>
                          <div style={{ display: "flex", gap: 8 }}>
                            <Form method="post">
                              <input type="hidden" name="intent" value="send_test_task" />
                              <button
                                type="submit"
                                className="bg-emerald-500 hover:bg-emerald-400 text-zinc-950 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 cursor-pointer shadow shadow-emerald-500/10"
                                disabled={isSubmitting}
                                style={{ border: "none", color: "#03251c" }}
                              >
                                Send Test Task
                              </button>
                            </Form>

                            <button
                              type="button"
                              onClick={() => setShowDisconnectModal(true)}
                              style={styles.dangerButton}
                              disabled={isSubmitting}
                            >
                              Disconnect
                            </button>
                          </div>
                        </div>
                        {selectedPlatform === "clickup" && isFreePlan && (
                          <div style={{ ...styles.warningBanner, marginTop: 12, fontSize: "13px", lineHeight: "1.4" }}>
                            <strong>⚠️ ClickUp Free Tier Notice:</strong> Your ClickUp workspace is on the Free Forever plan. Custom field syncing is limited to 60 lifetime uses by ClickUp. We recommend leaving field mapping empty; SyncUp will automatically format order details in the task description to save your limits.
                          </div>
                        )}
                      </section>

                      {/* Configure order list connections */}
                      <section style={styles.card}>
                        <h2 style={{ ...styles.cardTitle, marginTop: 0 }}>Configure order {selectedPlatform === "clickup" ? "list" : selectedPlatform === "monday" ? "board" : "database"} connections</h2>
                        <p style={styles.cardText}>
                          Select where new orders should sync. Growth plan merchants can configure up to 5 {selectedPlatform === "clickup" ? "lists" : selectedPlatform === "monday" ? "boards" : "databases"} with keyword filters to route orders automatically.
                        </p>

                        {lists.length === 0 ? (
                          <p style={styles.cardText}>
                            No {selectedPlatform === "clickup" ? "lists" : selectedPlatform === "monday" ? "boards" : "databases"} found in workspaces. Create one first then reload this page.
                          </p>
                        ) : (
                          <Form method="post" style={styles.form}>
                            <input type="hidden" name="intent" value="save_connections" />
                            <input type="hidden" name="listConnectionsJson" value={JSON.stringify(conns)} />

                            <div style={styles.connectionsContainer}>
                              {conns.map((conn, index) => (
                                <div key={index} style={styles.connectionRow}>
                                  <div style={{ flex: 2, minWidth: "150px" }}>
                                    <label style={styles.formLabel} htmlFor={`list_${index}`}>
                                      {selectedPlatform === "clickup" ? "ClickUp List" : selectedPlatform === "monday" ? "Monday Board" : "Notion Database"}{" "}
                                      <InfoTooltip text={`The specific destination ${selectedPlatform === "clickup" ? "list" : selectedPlatform === "monday" ? "board" : "database"} where synced order tasks will be created.`} />
                                    </label>
                                    <select
                                      id={`list_${index}`}
                                      value={conn.id}
                                      onChange={(e) => {
                                        const selectedId = e.currentTarget.value;
                                        const match = lists.find((l) => l.id === selectedId);
                                        const updated = [...conns];
                                        updated[index] = {
                                          ...conn,
                                          id: selectedId,
                                          name: match ? match.name : "",
                                        };
                                        setConns(updated);
                                      }}
                                      style={styles.select}
                                    >
                                      <option value="">Select...</option>
                                      {lists.map((list) => (
                                        <option key={list.id} value={list.id}>
                                          {list.name}
                                        </option>
                                      ))}
                                    </select>
                                  </div>

                                  {listLimit > 1 && (
                                    <>
                                      <div style={{ flex: 1, minWidth: "120px" }}>
                                        <label style={styles.formLabel} htmlFor={`kw_${index}`}>
                                          Product Keyword <InfoTooltip text="Only route orders containing products whose title, vendor, or SKU matches this word (e.g. 'boot')." />
                                        </label>
                                        <input
                                          id={`kw_${index}`}
                                          type="text"
                                          placeholder="e.g. Shoes or Vendor"
                                          value={conn.keyword || ""}
                                          onChange={(e) => {
                                            const updated = [...conns];
                                            updated[index] = { ...conn, keyword: e.currentTarget.value };
                                            setConns(updated);
                                          }}
                                          style={styles.input}
                                          className="border border-zinc-800"
                                        />
                                      </div>
                                      <div style={{ flex: 1, minWidth: "120px" }}>
                                        <label style={styles.formLabel} htmlFor={`loc_${index}`}>
                                          Location ID <InfoTooltip text="Only route orders if they are fulfilled from this physical Shopify warehouse/location ID." />
                                        </label>
                                        <input
                                          id={`loc_${index}`}
                                          type="text"
                                          placeholder="Shopify Location ID"
                                          value={conn.routingLocationId || ""}
                                          onChange={(e) => {
                                            const updated = [...conns];
                                            updated[index] = { ...conn, routingLocationId: e.currentTarget.value };
                                            setConns(updated);
                                          }}
                                          style={styles.input}
                                          className="border border-zinc-800"
                                        />
                                      </div>
                                      <div style={{ flex: 1, minWidth: "120px" }}>
                                        <label style={styles.formLabel} htmlFor={`tag_${index}`}>
                                          Order Tag <InfoTooltip text="Only route orders that carry this specific Shopify order tag or product tag (e.g. 'B2B')." />
                                        </label>
                                        <input
                                          id={`tag_${index}`}
                                          type="text"
                                          placeholder="Order/product tag name"
                                          value={conn.routingTag || ""}
                                          onChange={(e) => {
                                            const updated = [...conns];
                                            updated[index] = { ...conn, routingTag: e.currentTarget.value };
                                            setConns(updated);
                                          }}
                                          style={styles.input}
                                          className="border border-zinc-800"
                                        />
                                      </div>
                                    </>
                                  )}

                                  {listLimit > 1 && conns.length > 1 && (
                                    <button
                                      type="button"
                                      onClick={() => setConns(conns.filter((_, i) => i !== index))}
                                      style={styles.removeConnButton}
                                    >
                                      Remove
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>

                            {conns.length < listLimit && (
                              <button
                                type="button"
                                onClick={() => setConns([...conns, { id: lists[0]?.id || "", name: lists[0]?.name || "", keyword: "", routingLocationId: "", routingTag: "" }])}
                                style={styles.addConnButton}
                              >
                                + Add connection
                              </button>
                            )}

                            <button
                              type="submit"
                              style={styles.primaryButton}
                              disabled={isSubmitting}
                            >
                              {isSubmitting ? "Saving…" : "Save connections"}
                            </button>
                          </Form>
                        )}
                      </section>
                        </>
                      )}

                      {activeTab === "mappings" && (
                        <>
                          {/* Custom Field Mapping */}
                          <section style={styles.card}>
                        {(() => {
                          const isTrial = subscription.planName === "trial";
                          const isGrowthOrPro = subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro");
                          const isMappingUnlocked = isGrowthOrPro || isTrial;
                          const platformName = selectedPlatform === "clickup" ? "ClickUp" : selectedPlatform === "monday" ? "Monday.com" : "Notion";
                          const termFieldName = selectedPlatform === "clickup" ? "Custom Field" : selectedPlatform === "monday" ? "Column" : "Property";

                          if (!isMappingUnlocked) {
                            return (
                              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                                <h2 style={{ ...styles.cardTitle, marginTop: 0, display: "flex", alignItems: "center", gap: 8 }}>
                                  {platformName} {termFieldName} Mapping
                                  <span style={{
                                    fontSize: 10,
                                    color: "#ff9900",
                                    background: "rgba(255,153,0,0.12)",
                                    border: "1px solid #ff990044",
                                    padding: "2px 8px",
                                    borderRadius: 12,
                                    fontWeight: 700,
                                    textTransform: "uppercase"
                                  }}>
                                    Locked
                                  </span>
                                </h2>
                                <p style={styles.cardText}>
                                  Map Shopify order attributes directly to your custom {termFieldName.toLowerCase()}s in {platformName}. This feature is available on the Growth & Pro plans.
                                </p>
                                <div style={{ alignSelf: "flex-start", marginTop: 8 }}>
                                  <Link
                                    to={`/app/billing?platform=${selectedPlatform}`}
                                    style={{
                                      ...styles.primaryButton,
                                      display: "inline-block",
                                      textDecoration: "none",
                                      textAlign: "center",
                                    }}
                                  >
                                    Upgrade to Unlock Custom Mapping
                                  </Link>
                                </div>
                              </div>
                            );
                          }

                          const hasSelectedList = listConnections && listConnections.length > 0;
                          if (!hasSelectedList) {
                            return (
                              <div>
                                <h2 style={{ ...styles.cardTitle, marginTop: 0 }}>{platformName} {termFieldName} Mapping</h2>
                                <p style={styles.cardText}>
                                  Please configure and save at least one connection above to begin mapping custom {termFieldName.toLowerCase()}s.
                                </p>
                              </div>
                            );
                          }

                          return (
                            <div>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
                                <div style={{ flex: 1, minWidth: "250px" }}>
                                  <h2 style={{ ...styles.cardTitle, marginTop: 0, display: "flex", alignItems: "center", gap: 8 }}>
                                    {platformName} {termFieldName} Mapping
                                    <span style={{
                                      fontSize: 10,
                                      color: C.accent,
                                      background: "rgba(0,196,140,0.12)",
                                      border: `1px solid ${C.accent}44`,
                                      padding: "2px 8px",
                                      borderRadius: 12,
                                      fontWeight: 700,
                                      textTransform: "uppercase"
                                    }}>
                                      Active
                                    </span>
                                  </h2>
                                  <p style={styles.cardText}>
                                    Map Shopify order attributes directly to custom {termFieldName.toLowerCase()}s inside your primary connected {selectedPlatform === "clickup" ? "list" : selectedPlatform === "monday" ? "board" : "database"}.
                                  </p>
                                </div>
                                
                                <Form method="post">
                                  <input type="hidden" name="intent" value="save_field_mappings" />
                                  <input type="hidden" name="fieldMappingsJson" value={JSON.stringify(fieldMappingsList)} />
                                  <button
                                    type="submit"
                                    className="bg-emerald-500 hover:bg-emerald-400 text-zinc-950 px-4 py-2 rounded-xl text-xs font-black tracking-wide transition-all duration-200 cursor-pointer shadow-lg shadow-emerald-500/10"
                                    disabled={isSubmitting}
                                    style={{ border: "none", color: "#03251c", outline: "none" }}
                                  >
                                    {isSubmitting ? "Saving..." : "Save mappings"}
                                  </button>
                                </Form>
                              </div>

                              {actionData?.savedMappings && (
                                <div style={{ ...styles.successBanner, marginBottom: 16 }}>
                                  ✓ Mappings saved successfully.
                                </div>
                              )}

                              {/* TEMPLATE PRESETS BAR */}
                              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
                                <span style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>Start from a preset:</span>
                                {["basic", "customer", "financial"].map((preset) => (
                                  <button
                                    key={preset}
                                    type="button"
                                    onClick={() => applyPreset(preset)}
                                    style={{
                                      background: "rgba(255,255,255,0.05)",
                                      border: `1px solid ${C.border}`,
                                      color: C.text,
                                      padding: "4px 10px",
                                      borderRadius: 8,
                                      fontSize: 11,
                                      fontWeight: 600,
                                      cursor: "pointer",
                                      transition: "all 0.2s"
                                    }}
                                    onMouseEnter={(e) => e.currentTarget.style.borderColor = C.accent}
                                    onMouseLeave={(e) => e.currentTarget.style.borderColor = C.border}
                                  >
                                    {preset === "basic" ? "📦 Basic" : preset === "customer" ? "📋 Full Customer" : "💰 Financial"}
                                  </button>
                                ))}
                              </div>

                              {selectedPlatform === "clickup" && (isFreePlan || fieldMappingsList.length > 0) && (
                                <div style={{ ...styles.warningBanner, marginBottom: 16, fontSize: "13px", lineHeight: "1.4" }}>
                                  <strong>⚠️ ClickUp Free Tier Notice:</strong> ClickUp Free Forever plans have a lifetime limit of 60 custom field uses. {isFreePlan ? "Your connected workspace is detected as Free tier, so custom field syncing will stop once this limit is reached. We recommend keeping field mappings empty; SyncUp will format all order details in the task description to save your limits." : "If your workspace is on the Free tier, updates to mapped fields will stop syncing once this limit is reached."}
                                </div>
                              )}

                              {clickupFields.length === 0 ? (
                                <div style={{
                                  background: "rgba(255,153,0,0.02)",
                                  border: `1px solid ${C.border}`,
                                  borderRadius: 12,
                                  padding: "24px 20px",
                                  textAlign: "center",
                                  marginTop: 16
                                }}>
                                  <div style={{ fontSize: 24, marginBottom: 8 }}>📋</div>
                                  <h3 style={{ fontSize: 14, fontWeight: 700, color: "#ffffff", marginBottom: 6 }}>
                                    No custom {termFieldName.toLowerCase()}s detected
                                  </h3>
                                  <p style={{ ...styles.cardText, maxWidth: 480, margin: "0 auto 16px auto", color: C.muted }}>
                                    To map Shopify customer data directly to custom columns, please add columns (e.g. text, dates, numbers, checkboxes) inside your connected {platformName} {selectedPlatform === "clickup" ? "List settings" : selectedPlatform === "monday" ? "Board settings" : "Database properties"}.
                                  </p>
                                  <button
                                    type="button"
                                    onClick={() => window.location.reload()}
                                    style={{
                                      background: "rgba(255,255,255,0.06)",
                                      border: `1px solid ${C.border}`,
                                      color: C.text,
                                      padding: "8px 16px",
                                      borderRadius: 8,
                                      fontSize: 12,
                                      fontWeight: 600,
                                      cursor: "pointer",
                                    }}
                                  >
                                    🔄 Refresh Fields List
                                  </button>
                                </div>
                              ) : (
                                <div style={{ border: `1px solid ${C.border}`, borderRadius: "12px", overflow: "hidden", background: "#151515" }}>
                                  {/* Table Header */}
                                  <div className="grid grid-cols-12 bg-zinc-900/50 p-4 border-b border-zinc-800 font-semibold text-xs tracking-wider uppercase text-zinc-400">
                                    <div className="col-span-5">
                                      Shopify Source Field <InfoTooltip text="The data point from the Shopify order (e.g. Customer Email or Shipping Cost)." />
                                    </div>
                                    <div className="col-span-2 text-center">Flow</div>
                                    <div className="col-span-5">
                                      Destination {termFieldName} <InfoTooltip text={`The custom field or column in your connected ${selectedPlatform === "clickup" ? "list" : selectedPlatform === "monday" ? "board" : "database"} to map the data to.`} />
                                    </div>
                                  </div>

                                  {/* Mappings */}
                                  <div className="divide-y divide-zinc-900/50">
                                    {clickupFields.map((field) => {
                                      const currentMapping = fieldMappingsList.find((m) => m.clickupFieldId === field.id);
                                      const shopifyField = SHOPIFY_SOURCE_FIELDS.find((sf) => sf.id === currentMapping?.shopifySourceField);
                                      const validation = currentMapping ? checkFieldCompatibility(shopifyField?.type, field.type, selectedPlatform) : { valid: true };
                                      return (
                                        <div key={field.id} className="grid grid-cols-12 items-center p-4 hover:bg-zinc-900/10 transition-colors">
                                          {/* Shopify field selector */}
                                          <div className="col-span-5">
                                            <select
                                              value={currentMapping?.shopifySourceField || ""}
                                              onChange={(e) => {
                                                const val = e.currentTarget.value;
                                                setFieldMappingsList((prev) => {
                                                  const filtered = prev.filter((m) => m.clickupFieldId !== field.id);
                                                  if (!val) return filtered;
                                                  return [
                                                    ...filtered,
                                                    {
                                                      shopifySourceField: val,
                                                      clickupFieldId: field.id,
                                                      clickupFieldName: field.name,
                                                      clickupFieldType: field.type,
                                                    },
                                                  ];
                                                });
                                              }}
                                              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer"
                                            >
                                              <option value="">-- Leave Unmapped --</option>
                                              {SHOPIFY_SOURCE_FIELDS.map((src) => (
                                                <option key={src.id} value={src.id}>
                                                  {src.label} ({src.type.toUpperCase()})
                                                </option>
                                              ))}
                                            </select>
                                            {!validation.valid && (
                                              <div style={{
                                                marginTop: 6,
                                                fontSize: 10,
                                                color: validation.tone === "critical" ? "#ff4444" : "#ff9900",
                                                display: "flex",
                                                gap: 4,
                                                alignItems: "flex-start",
                                                lineHeight: "1.3"
                                              }}>
                                                <span>⚠️</span>
                                                <span>{validation.message}</span>
                                              </div>
                                            )}
                                          </div>

                                          {/* Arrow icon */}
                                          <div className="col-span-2 flex justify-center text-emerald-400">
                                            <span style={{ fontSize: "14px", fontWeight: "bold" }}>&rarr;</span>
                                          </div>

                                          {/* ClickUp Custom Field read-only info */}
                                          <div className="col-span-5 flex justify-between items-center pl-2">
                                            <div>
                                              <span className="font-semibold text-xs text-white">{field.name}</span>
                                              <div className="flex gap-1.5 mt-1">
                                                <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-zinc-900 text-zinc-400 border border-zinc-800">
                                                  {field.type}
                                                </span>
                                              </div>
                                            </div>
                                            <div className="text-zinc-500 font-mono text-[10px] hidden sm:block">
                                              {field.id.slice(0, 8)}...
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </section>
                        </>
                      )}

                      {activeTab === "settings" && (
                        <>
                          {/* Sync Settings */}
                          <section style={styles.card}>
                        <h2 style={{ ...styles.cardTitle, marginTop: 0 }}>Sync Settings</h2>
                        <p style={styles.cardText}>
                          Configure how and when orders are synced to your connected workspace tool.
                        </p>

                        <Form method="post" style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 24 }}>
                          <input type="hidden" name="intent" value="save_settings" />

                          {/* Task Name Template */}
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <label style={{ ...styles.formLabel, marginBottom: 0 }} htmlFor="taskNameTemplate">
                              Task Name Template <InfoTooltip text="Customize the name of the created task. Use bracket variables like {order_number} or {customer_name} to dynamically inject order data." />
                            </label>
                            <p style={{ ...styles.cardText, margin: 0, fontSize: 12 }}>
                              Customise the task title using tokens. Leave blank to use the default.
                            </p>
                            <input
                              id="taskNameTemplate"
                              name="taskNameTemplate"
                              type="text"
                              value={localTaskTemplate}
                              onChange={(e) => setLocalTaskTemplate(e.currentTarget.value)}
                              placeholder="Order {order_number} — {customer_name}"
                              style={styles.input}
                            />
                            {/* Token chips */}
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                              {[
                                "{order_number}",
                                "{customer_name}",
                                "{order_total}",
                                "{shipping_method}",
                                "{item_count}",
                                "{payment_status}",
                              ].map((token) => (
                                <button
                                  key={token}
                                  type="button"
                                  onClick={() => setLocalTaskTemplate((prev) => (prev ? `${prev} ${token}` : token))}
                                  style={{
                                    fontSize: 11,
                                    background: "rgba(0,196,140,0.08)",
                                    border: "1px solid rgba(0,196,140,0.2)",
                                    color: C.accent,
                                    padding: "3px 8px",
                                    borderRadius: 6,
                                    cursor: "pointer",
                                    fontWeight: 500,
                                    outline: "none",
                                  }}
                                >
                                  {token}
                                </button>
                              ))}
                            </div>
                            
                            {/* Live Preview Box */}
                            <div style={{
                              marginTop: 10,
                              padding: "12px 14px",
                              background: "rgba(255,255,255,0.03)",
                              border: `1px dashed ${C.border}`,
                              borderRadius: "10px",
                            }}>
                              <div style={{ fontSize: 10, color: C.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                                Live Preview (using latest store order)
                              </div>
                              <div style={{ fontSize: 13, color: C.accent, fontWeight: "bold", marginTop: 4, fontFamily: "monospace" }}>
                                {compiledTemplatePreview}
                              </div>
                            </div>
                          </div>

                          {/* Task Description Template */}
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <label style={{ ...styles.formLabel, marginBottom: 0 }} htmlFor="taskDescriptionTemplate">
                                Task Description Template <InfoTooltip text="Customize the description body of the task. Supports rich text, custom tokens, and line item tables." />
                              </label>
                              {!(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial") && (
                                <span style={{ fontSize: 9, background: "rgba(255,153,0,0.12)", color: "#ff9900", border: "1px solid rgba(255,153,0,0.3)", borderRadius: 6, padding: "1px 6px", fontWeight: 700, textTransform: "uppercase" }}>Growth+</span>
                              )}
                            </div>
                            <p style={{ ...styles.cardText, margin: 0, fontSize: 12 }}>
                              Customize the task body using Liquid-like syntax. Loops are supported for line items.
                            </p>
                            <textarea
                              id="taskDescriptionTemplate"
                              name="taskDescriptionTemplate"
                              rows={5}
                              value={localTaskDescriptionTemplate}
                              onChange={(e) => setLocalTaskDescriptionTemplate(e.currentTarget.value)}
                              placeholder={`Order Total: {{ order.total }}\nShipping: {{ order.shipping_method }}\n\nItems:\n{% for item in line_items %}\n- {{ item.quantity }}x {{ item.title }}{{ item.variant }} [SKU: {{ item.sku }}]\n{% endfor %}`}
                              style={{
                                ...styles.input,
                                fontFamily: "monospace",
                                fontSize: 12,
                                resize: "vertical",
                              }}
                              disabled={!(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial")}
                            />
                            {/* Token chips */}
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                              {[
                                "{{ order.order_number }}",
                                "{{ order.customer_name }}",
                                "{{ order.email }}",
                                "{{ order.phone }}",
                                "{{ order.total }}",
                                "{{ order.shipping_method }}",
                                "{{ order.item_count }}",
                                "{{ order.payment_status }}",
                                "{{ order.notes }}",
                                "{{ order.admin_url }}",
                                "{{ order.shipping_address }}",
                                "line_items loop block"
                              ].map((token) => (
                                <button
                                  key={token}
                                  type="button"
                                  disabled={!(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial")}
                                  onClick={() => {
                                    setLocalTaskDescriptionTemplate((prev) => {
                                      const insertText = token === "line_items loop block"
                                        ? "{% for item in line_items %}\n- {{ item.quantity }}x {{ item.title }}{{ item.variant }} [SKU: {{ item.sku }}]\n{% endfor %}"
                                        : token;
                                      return prev ? `${prev} ${insertText}` : insertText;
                                    });
                                  }}
                                  style={{
                                    fontSize: 11,
                                    background: "rgba(0,196,140,0.08)",
                                    border: "1px solid rgba(0,196,140,0.2)",
                                    color: C.accent,
                                    padding: "3px 8px",
                                    borderRadius: 6,
                                    cursor: !(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial") ? "not-allowed" : "pointer",
                                    fontWeight: 500,
                                    outline: "none",
                                    opacity: !(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial") ? 0.5 : 1
                                  }}
                                >
                                  {token}
                                </button>
                              ))}
                            </div>

                            {/* Description Live Preview Box */}
                            <div style={{
                              marginTop: 10,
                              padding: "12px 14px",
                              background: "rgba(255,255,255,0.03)",
                              border: `1px dashed ${C.border}`,
                              borderRadius: "10px",
                            }}>
                              <div style={{ fontSize: 10, color: C.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                                Description Live Preview (using latest store order)
                              </div>
                              <pre style={{
                                fontSize: 12,
                                color: C.accent,
                                marginTop: 6,
                                fontFamily: "monospace",
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-all",
                                margin: 0
                              }}>
                                {compiledDescriptionPreview}
                              </pre>
                            </div>
                          </div>

                           {/* When to create tasks Selector */}
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <label style={{ ...styles.formLabel, marginBottom: 0 }}>
                              When to create tasks <InfoTooltip text="Choose the exact event in Shopify that triggers task creation: when payment is Captured/Paid, immediately when order is placed, or when fulfillment begins." />
                            </label>
                            <p style={{ ...styles.cardText, margin: 0, fontSize: 12 }}>
                              Choose when a task is created for new orders.
                            </p>
                            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
                              {[
                                { id: "payment_confirmed", title: "When order is paid (Recommended)", desc: "Creates the task when the order is marked paid." },
                                { id: "on_create", title: "Immediately when order is placed", desc: "Creates the task as soon as the customer checks out (including unpaid draft orders)." },
                                { id: "on_fulfillment_start", title: "When order starts shipping", desc: "Creates the task when you start processing or shipping." }
                              ].map(({ id, title, desc }) => (
                                <label key={id} style={{ display: "flex", gap: 12, alignItems: "flex-start", cursor: "pointer" }}>
                                  <input
                                    type="radio"
                                    name="syncTrigger"
                                    value={id}
                                    checked={localSyncTrigger === id}
                                    onChange={() => setLocalSyncTrigger(id)}
                                    style={{ marginTop: 4, accentColor: C.accent }}
                                  />
                                  <div>
                                    <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
                                      {title}
                                    </div>
                                    <div style={{ fontSize: 12, color: "#9a9a9a", marginTop: 3 }}>{desc}</div>
                                  </div>
                                </label>
                              ))}
                            </div>
                          </div>

                          {/* Subtasks Toggle */}
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderRadius: 10, border: "1px solid #2a2a2a", background: "#151515" }}>
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 600, color: "#ffffff", display: "flex", alignItems: "center", gap: 6 }}>
                                Create a subtask per product <InfoTooltip text="When enabled, each product variant in the Shopify order is created as a separate subtask under the main task." />
                                {!(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial") && (
                                  <span style={{ fontSize: 9, background: "rgba(255,153,0,0.12)", color: "#ff9900", border: "1px solid rgba(255,153,0,0.3)", borderRadius: 6, padding: "1px 6px", fontWeight: 700, textTransform: "uppercase" }}>Growth+</span>
                                )}
                              </div>
                              <div style={{ fontSize: 12, color: "#9a9a9a", marginTop: 3 }}>
                                Each product variant in the Shopify order becomes a separate subtask.
                              </div>
                            </div>
                            <input type="hidden" name="subtasksEnabled" value={String(localSubtasks)} />
                            <button
                              type="button"
                              role="switch"
                              aria-checked={localSubtasks}
                              disabled={!(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial")}
                              onClick={() => setLocalSubtasks((v) => !v)}
                              style={{
                                width: 44,
                                height: 24,
                                borderRadius: 12,
                                background: localSubtasks ? "#00c48c" : "#2a2a2a",
                                border: "none",
                                cursor: "pointer",
                                position: "relative",
                                flexShrink: 0,
                                transition: "background 0.2s ease",
                                outline: "none",
                              }}
                            >
                              <span style={{
                                position: "absolute",
                                top: 2,
                                left: localSubtasks ? 22 : 2,
                                width: 20,
                                height: 20,
                                borderRadius: "50%",
                                background: "#ffffff",
                                transition: "left 0.2s ease",
                                boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                              }} />
                            </button>
                          </div>

                          {/* Two-Way Status Sync Toggle */}
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderRadius: 10, border: "1px solid #2a2a2a", background: "#151515" }}>
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 600, color: "#ffffff", display: "flex", alignItems: "center", gap: 6 }}>
                                Mark task complete when order ships <InfoTooltip text="Automatically fulfill the Shopify order when the mapped task is marked complete or done in ClickUp or Monday." />
                                {selectedPlatform !== "notion" && !(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial") && (
                                  <span style={{ fontSize: 9, background: "rgba(255,153,0,0.12)", color: "#ff9900", border: "1px solid rgba(255,153,0,0.3)", borderRadius: 6, padding: "1px 6px", fontWeight: 700, textTransform: "uppercase" }}>Growth+</span>
                                )}
                                {selectedPlatform === "notion" && (
                                  <span style={{ fontSize: 9, background: "rgba(150,150,150,0.12)", color: "#9a9a9a", border: "1px solid rgba(150,150,150,0.3)", borderRadius: 6, padding: "1px 6px", fontWeight: 700, textTransform: "uppercase" }}>One-way</span>
                                )}
                              </div>
                              <div style={{ fontSize: 12, color: "#9a9a9a", marginTop: 3 }}>
                                {selectedPlatform === "notion"
                                  ? "Notion sync is one-way: orders are sent to Notion, but marking a Notion page complete will NOT auto-fulfill the Shopify order (Notion has no change webhooks)."
                                  : "Automatically fulfill and close the Shopify order when its task is marked complete in ClickUp/Monday."}
                              </div>
                            </div>
                            <input type="hidden" name="twoWaySyncEnabled" value={String(selectedPlatform === "notion" ? false : localTwoWaySync)} />
                            <button
                              type="button"
                              role="switch"
                              aria-checked={localTwoWaySync}
                              disabled={selectedPlatform === "notion" || !(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial")}
                              onClick={() => {
                                if (!localTwoWaySync) {
                                  setShowConfirmModal(true);
                                } else {
                                  setLocalTwoWaySync(false);
                                }
                              }}
                              style={{
                                width: 44,
                                height: 24,
                                borderRadius: 12,
                                background: localTwoWaySync ? "#00c48c" : "#2a2a2a",
                                border: "none",
                                cursor: (selectedPlatform === "notion" || !(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial")) ? "not-allowed" : "pointer",
                                position: "relative",
                                flexShrink: 0,
                                transition: "background 0.2s ease",
                                outline: "none",
                                opacity: (selectedPlatform === "notion" || !(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial")) ? 0.5 : 1
                              }}
                            >
                              <span style={{
                                position: "absolute",
                                top: 2,
                                left: localTwoWaySync ? 22 : 2,
                                width: 20,
                                height: 20,
                                borderRadius: "50%",
                                background: "#ffffff",
                                transition: "left 0.2s ease",
                                boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                              }} />
                            </button>
                          </div>

                          <button
                            type="submit"
                            style={{ ...styles.primaryButton, alignSelf: "flex-start" }}
                            disabled={isSubmitting}
                          >
                            {isSubmitting ? "Saving…" : "Save settings"}
                          </button>
                        </Form>
                      </section>
                        </>
                      )}

                    </div>

                    {/* RIGHT COLUMN: Health, Stats & Live Event feed */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                      
                      {/* Webhook Health Badge Card */}
                      <section style={styles.card}>
                        <h2 style={{ ...styles.cardTitle, marginTop: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          Connection Health
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              textTransform: "uppercase",
                              padding: "2px 8px",
                              borderRadius: 12,
                              letterSpacing: "0.05em",
                              color: healthStatus === "healthy" ? C.accent : "#ff4444",
                              background: healthStatus === "healthy" ? "rgba(0, 196, 140, 0.12)" : "rgba(255, 68, 68, 0.12)",
                              border: `1px solid ${healthStatus === "healthy" ? C.accent : "#ff4444"}44`,
                            }}
                          >
                            {healthStatus === "healthy" ? "Live" : "Error"}
                          </span>
                        </h2>
                        <p style={{ ...styles.cardText, margin: 0 }}>
                          {healthStatus === "healthy"
                            ? `✓ Your integration with ${selectedPlatform === "clickup" ? "ClickUp" : selectedPlatform === "monday" ? "Monday.com" : "Notion"} is functioning normally.`
                            : `⚠️ Your connection has dropped. Please disconnect and reconnect to resume order syncing.`}
                        </p>
                      </section>

                      {/* Sync Analytics Card */}
                      {(() => {
                        const isTrial = subscription.planName === "trial";
                        const isGrowthOrPro = subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro");
                        const isAnalyticsUnlocked = isGrowthOrPro || isTrial;

                        return (
                          <section style={{ ...styles.card }}>
                            <h2 style={{ ...styles.cardTitle, marginTop: 0, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              Sync Analytics
                              {isTrial && (
                                <span style={{
                                  fontSize: 10,
                                  color: C.accent,
                                  background: "rgba(0,196,140,0.12)",
                                  border: `1px solid ${C.accent}44`,
                                  padding: "2px 8px",
                                  borderRadius: 12,
                                  fontWeight: 600,
                                  textTransform: "uppercase",
                                  letterSpacing: "0.05em"
                                }}>
                                  Trial mode
                                </span>
                              )}
                            </h2>

                            {/* Stats Grid - Unlocked and always visible */}
                            <div style={styles.analyticsGrid}>
                              <div style={styles.analyticsStatCard}>
                                <div style={styles.analyticsStatLabel}>Synced this month</div>
                                <div style={styles.analyticsStatValue}>
                                  {analytics.totalSyncedMonth}
                                  {orderLimit !== null && (
                                    <span style={{ fontSize: 13, color: C.muted, fontWeight: 500, marginLeft: 4 }}>
                                      / {orderLimit.toLocaleString()}
                                    </span>
                                  )}
                                </div>
                                <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                                  {orderLimit === null ? "Unlimited orders" : `${Math.max(0, orderLimit - analytics.totalSyncedMonth).toLocaleString()} remaining`}
                                </div>
                              </div>
                              <div style={styles.analyticsStatCard}>
                                <div style={styles.analyticsStatLabel}>Synced all time</div>
                                <div style={styles.analyticsStatValue}>{analytics.totalSyncedAllTime}</div>
                              </div>
                              <div style={styles.analyticsStatCard}>
                                <div style={styles.analyticsStatLabel}>Synced today</div>
                                <div style={styles.analyticsStatValue}>{syncedToday}</div>
                              </div>
                            </div>

                            {/* Recent Sync Events - Blurred & Locked section for free/standard tier */}
                            <div style={{ position: "relative", marginTop: 24, minHeight: 180 }}>
                              <div style={isAnalyticsUnlocked ? {} : { filter: "blur(4px)", pointerEvents: "none", opacity: 0.6 }}>
                                <h3 style={styles.sectionSubheading}>Recent Sync Events</h3>
                                {analytics.recentTasks.length === 0 ? (
                                  <p style={styles.cardText}>No sync events recorded yet.</p>
                                ) : (
                                  <table style={styles.table}>
                                    <thead>
                                      <tr>
                                        <th style={styles.th}>Time</th>
                                        <th style={styles.th}>Order</th>
                                        <th style={styles.th}>Status</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {analytics.recentTasks.map((t) => (
                                        <tr key={t.id} style={styles.tr}>
                                          <td style={styles.td}>{timeAgo(t.createdAt)}</td>
                                          <td style={styles.td}>{t.orderNumber}</td>
                                          <td style={styles.td}>
                                            <span
                                              style={{
                                                ...styles.statusBadgeInline,
                                                color: t.status === "failed" ? "#ff4444" : t.status === "retrying" ? "#ff9900" : "#00c48c",
                                                background: t.status === "failed" ? "rgba(255,68,68,0.12)" : t.status === "retrying" ? "rgba(255,153,0,0.12)" : "rgba(0,196,140,0.12)",
                                              }}
                                            >
                                              {t.status}
                                            </span>
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                              </div>

                              {!isAnalyticsUnlocked && (
                                <div style={{
                                  ...styles.analyticsLockOverlay,
                                  borderRadius: 12,
                                  background: "rgba(26, 26, 26, 0.9)",
                                  backdropFilter: "blur(2px)",
                                  padding: 16
                                }}>
                                  <div style={styles.lockIcon}>🔒</div>
                                  <div style={styles.lockTitle}>Growth Plan Feature</div>
                                  <div style={styles.lockText}>
                                    Upgrade to the Growth plan to unlock sync history, up to 5 connection routes, and automatic fulfillment updates.
                                  </div>
                                  <Link to={`/app/billing?platform=${selectedPlatform}`} style={styles.upgradeInlineButton}>
                                    Upgrade to Growth
                                  </Link>
                                </div>
                              )}
                            </div>
                          </section>
                        );
                      })()}

                      {/* Recent Activity Log */}
                      <section style={styles.card}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                          <h2 style={{ ...styles.cardTitle, marginTop: 0, marginBottom: 0 }}>
                            Recent log
                          </h2>
                          <Link
                            to="/app/history"
                            style={{ fontSize: 12, color: "#00c48c", textDecoration: "none", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4 }}
                          >
                            View full history →
                          </Link>
                        </div>
                        {recentActivity.length === 0 ? (
                          <p style={{ ...styles.cardText, color: C.muted, margin: "12px 0 0 0" }}>
                            No sync activity recorded yet. Place a test order to see logs here.
                          </p>
                        ) : (
                          <ul style={styles.activityList}>
                            {recentActivity.map((event) => (
                              <li key={event.id} style={styles.activityItem}>
                                <span
                                  style={{
                                    ...styles.activityIcon,
                                    color: EVENT_COLORS[event.eventType] || C.muted,
                                  }}
                                >
                                  {EVENT_ICONS[event.eventType] || "·"}
                                </span>
                                <span style={styles.activityDescription}>
                                  {event.description}
                                </span>
                                <span style={styles.activityTime}>
                                  {timeAgo(event.createdAt)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </section>

                    </div>
                  </div>
                </div>
              )}</>
          )}

          <footer style={styles.footer}>
            Connected store: <span style={styles.footerShop}>{shop}</span>
            {" · "}
            <a href="/privacy" target="_top" style={styles.footerLink}>
              Privacy Policy
            </a>
          </footer>
        </div>
      </div>

      {/* IN-APP CONFIRMATION MODALS */}
      {showConfirmModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(0,0,0,0.6)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 999999
        }}>
          <div style={{
            background: "#151515",
            border: `1px solid ${C.border}`,
            borderRadius: 16,
            padding: 24,
            maxWidth: 480,
            width: "90%",
            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.5)",
            textAlign: "center"
          }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: "#ffffff", marginBottom: 12 }}>
              Enable Two-Way Sync?
            </h3>
            <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, marginBottom: 20 }}>
              Enabling this option will automatically fulfill and close Shopify orders when their corresponding tasks are marked complete in your project management tool.
            </p>
            <div style={{ display: "flex", justifyContent: "center", gap: 12 }}>
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: `1px solid ${C.border}`,
                  color: C.text,
                  padding: "8px 16px",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer"
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setLocalTwoWaySync(true);
                  setShowConfirmModal(false);
                }}
                style={{
                  background: C.accent,
                  border: "none",
                  color: "#03251c",
                  padding: "8px 16px",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer"
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {showDisconnectModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(0,0,0,0.6)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 999999
        }}>
          <div style={{
            background: "#151515",
            border: `1px solid ${C.border}`,
            borderRadius: 16,
            padding: 24,
            maxWidth: 480,
            width: "90%",
            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.5)",
            textAlign: "center"
          }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🔌</div>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: "#ffffff", marginBottom: 12 }}>
              Disconnect Integration?
            </h3>
            <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, marginBottom: 20 }}>
              Are you sure you want to disconnect? This will immediately pause all automated order syncing between Shopify and your project management board.
            </p>
            <div style={{ display: "flex", justifyContent: "center", gap: 12 }}>
              <button
                type="button"
                onClick={() => setShowDisconnectModal(false)}
                style={{
                  background: "rgba(255,255,255,0.06)",
                  border: `1px solid ${C.border}`,
                  color: C.text,
                  padding: "8px 16px",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer"
                }}
              >
                Cancel
              </button>
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="disconnect" />
                <button
                  type="submit"
                  style={{
                    background: "#ff4444",
                    border: "none",
                    color: "#ffffff",
                    padding: "8px 16px",
                    borderRadius: 8,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer"
                  }}
                >
                  Disconnect
                </button>
              </Form>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const styles = {
  page: {
    background: C.bg,
    color: C.text,
    minHeight: "100vh",
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding: "40px 20px",
    boxSizing: "border-box",
  },
  container: {
    maxWidth: 640,
    margin: "0 auto",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    marginBottom: 24,
    flexWrap: "wrap",
  },
  logoMark: {
    width: 44,
    height: 44,
    borderRadius: 12,
    background: C.surface,
    border: `1px solid ${C.border}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  title: { margin: 0, fontSize: 24, fontWeight: 600, color: C.text },
  subtitle: { margin: "4px 0 0", fontSize: 14, color: C.muted },
  statusBadge: {
    display: "flex",
    alignItems: "center",
    fontSize: 12,
    fontWeight: 600,
    padding: "5px 10px",
    borderRadius: 20,
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  card: {
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 16,
    padding: 24,
  },
  cardHeaderRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
    gap: 12,
    flexWrap: "wrap",
  },
  cardTitle: { margin: "16px 0 8px", fontSize: 16, fontWeight: 600, color: C.text },
  cardText: { margin: "0 0 20px", fontSize: 14, lineHeight: 1.6, color: C.muted },
  statusRow: { display: "flex", alignItems: "center", gap: 8 },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: C.accent,
    boxShadow: `0 0 8px ${C.accent}`,
    flexShrink: 0,
  },
  statusText: { fontSize: 14, fontWeight: 500, color: C.text },
  form: { display: "flex", flexDirection: "column", gap: 16 },
  formLabel: { fontSize: 12, fontWeight: 600, color: C.muted, display: "block", marginBottom: 6 },
  label: { fontSize: 13, fontWeight: 500, color: C.muted },
  select: {
    width: "100%",
    background: C.bg,
    color: C.text,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: "12px 14px",
    fontSize: 14,
    outline: "none",
    boxSizing: "border-box",
  },
  input: {
    width: "100%",
    background: C.bg,
    color: C.text,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: "12px 14px",
    fontSize: 14,
    outline: "none",
    boxSizing: "border-box",
  },
  primaryButton: {
    display: "inline-block",
    background: C.accent,
    color: "#03251c",
    border: "none",
    borderRadius: 10,
    padding: "12px 22px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    textDecoration: "none",
    marginTop: 4,
    width: "fit-content",
    textAlign: "center",
  },
  dangerButton: {
    background: "transparent",
    color: C.muted,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
  },
  banner: {
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 14,
    fontWeight: 500,
    lineHeight: 1.5,
  },
  successBanner: {
    background: "rgba(0, 196, 140, 0.12)",
    border: `1px solid ${C.accent}`,
    color: C.accent,
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 14,
  },
  warningBanner: {
    background: "rgba(255, 153, 0, 0.12)",
    border: "1px solid #ff9900",
    color: "#ff9900",
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 14,
  },
  errorBanner: {
    background: "rgba(255, 68, 68, 0.12)",
    border: "1px solid #ff4444",
    color: "#ff4444",
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 14,
  },
  planRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
  },
  planLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: C.muted,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 4,
  },
  planName: {
    fontSize: 20,
    fontWeight: 700,
    color: C.text,
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },
  paidBadge: {
    fontSize: 11,
    fontWeight: 600,
    background: "rgba(0, 196, 140, 0.15)",
    color: C.accent,
    border: `1px solid ${C.accent}`,
    borderRadius: 6,
    padding: "2px 8px",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  usageText: { fontSize: 12, color: C.muted },
  managePlanButton: {
    display: "inline-block",
    background: "transparent",
    color: C.text,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: "10px 18px",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    textDecoration: "none",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  activityList: { listStyle: "none", padding: 0, margin: 0 },
  activityItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 0",
    borderBottom: `1px solid ${C.border}`,
    fontSize: 13,
  },
  activityIcon: { fontWeight: 700, flexShrink: 0, marginTop: 1 },
  activityDescription: { flex: 1, color: C.muted, lineHeight: 1.4 },
  activityTime: { color: C.border, fontSize: 11, flexShrink: 0, marginTop: 2 },
  footer: { marginTop: 24, fontSize: 13, color: C.muted, textAlign: "center" },
  footerShop: { color: C.text },
  footerLink: { color: C.muted, textDecoration: "underline" },

  // Pricing Card Layout Styles
  pricingCard: {
    background: C.bg,
    border: `1px solid ${C.border}`,
    borderRadius: 14,
    padding: 24,
    display: "flex",
    flexDirection: "column",
    gap: 16,
    position: "relative",
  },
  pricingCardHighlighted: {
    borderColor: "#3a3a5a",
    background: "#1e1e2e",
  },
  popularBadge: {
    position: "absolute",
    top: -12,
    left: "50%",
    transform: "translateX(-50%)",
    background: C.accent,
    color: "#03251c",
    fontSize: 11,
    fontWeight: 700,
    padding: "3px 12px",
    borderRadius: 12,
    whiteSpace: "nowrap",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  pricingHeader: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  pricingTitle: { margin: 0, fontSize: 18, fontWeight: 700, color: C.text },
  pricingPrice: { display: "flex", alignItems: "baseline", flexWrap: "wrap" },
  priceAmount: { fontSize: 28, fontWeight: 800, color: C.text },
  priceInterval: { fontSize: 14, color: C.muted, marginLeft: 2 },
  priceSubtext: { fontSize: 11, color: C.muted, width: "100%", marginTop: 2 },
  pricingFeatures: {
    listStyle: "none",
    padding: 0,
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    fontSize: 13,
    color: C.muted,
  },
  pricingButton: {
    width: "100%",
    background: "transparent",
    color: C.text,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: "10px 14px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    textAlign: "center",
    boxSizing: "border-box",
  },
  pricingButtonHighlighted: {
    background: C.accent,
    color: "#03251c",
    borderColor: C.accent,
  },

  // Multiple List Connections UI Styles
  connectionsContainer: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    marginBottom: 8,
  },
  connectionRow: {
    display: "flex",
    alignItems: "flex-end",
    gap: 12,
    flexWrap: "wrap",
    background: C.bg,
    border: `1px solid ${C.border}`,
    borderRadius: 12,
    padding: 16,
  },
  removeConnButton: {
    background: "transparent",
    color: "#ff4444",
    border: "1px solid rgba(255,68,68,0.3)",
    borderRadius: 8,
    padding: "10px 14px",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    height: "fit-content",
    alignSelf: "flex-end",
  },
  addConnButton: {
    background: "transparent",
    color: C.accent,
    border: `1px dashed ${C.accent}`,
    borderRadius: 10,
    padding: "10px 16px",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    alignSelf: "flex-start",
    marginBottom: 8,
  },

  // Analytics Grid Styles
  analyticsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 16,
    margin: "12px 0 24px",
  },
  analyticsStatCard: {
    background: C.bg,
    border: `1px solid ${C.border}`,
    borderRadius: 12,
    padding: 16,
    textAlign: "center",
  },
  analyticsStatLabel: {
    fontSize: 11,
    color: C.muted,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    marginBottom: 6,
  },
  analyticsStatValue: {
    fontSize: 24,
    fontWeight: 700,
    color: C.text,
  },
  sectionSubheading: {
    fontSize: 14,
    fontWeight: 600,
    color: C.text,
    margin: "0 0 12px",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
    color: C.muted,
  },
  th: {
    textAlign: "left",
    padding: "10px 12px",
    borderBottom: `2px solid ${C.border}`,
    fontWeight: 600,
    color: C.text,
  },
  tr: {
    borderBottom: `1px solid ${C.border}`,
  },
  td: {
    padding: "12px",
  },
  statusBadgeInline: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 12,
    fontSize: 11,
    fontWeight: 600,
    textTransform: "capitalize",
  },
  analyticsLockOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(26, 26, 26, 0.8)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    textAlign: "center",
    zIndex: 10,
  },
  lockIcon: { fontSize: 32, marginBottom: 12 },
  lockTitle: { fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 },
  lockText: { fontSize: 13, color: C.muted, maxWidth: 360, lineHeight: 1.5, marginBottom: 16 },
  upgradeInlineButton: {
    display: "inline-block",
    background: C.accent,
    color: "#03251c",
    textDecoration: "none",
    borderRadius: 8,
    padding: "10px 20px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
};

export const headers = (headersArgs) => boundary.headers(headersArgs);
