import { useState } from "react";
import { Form, useLoaderData, useActionData, useNavigation, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, registerWebhooks } from "../shopify.server";
import { getOrCreateSubscription, getTrialBannerStatus, isSubscriptionActive } from "../billing.server";
import { signState } from "../oauth-state.server";
import { PLANS, getTranslatedFeatures } from "../plans";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  try {
    await registerWebhooks({ session });
  } catch (e) {
    console.error("registerWebhooks error:", e);
  }

  const { getConnection, getRecentActivity } = await import("../clickup.server");

  const [connection, subscription, recentActivity] = await Promise.all([
    getConnection(shop),
    getOrCreateSubscription(shop),
    getRecentActivity(shop, 5),
  ]);

  let lists = [];
  let listError = null;

  if (connection?.accessToken) {
    try {
      const { IntegrationFactory } = await import("../adapters/factory");
      const adapter = await IntegrationFactory.getAdapter(connection.selectedPlatform, connection.accessToken);
      lists = await adapter.fetchTargets();
    } catch (error) {
      console.error(`Failed to load targets for ${shop}:`, error);
      listError = `We couldn't load your resources from ${connection.selectedPlatform === "clickup" ? "ClickUp" : connection.selectedPlatform === "monday" ? "Monday.com" : "Notion"}. Try disconnecting and reconnecting.`;
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

  const recentTasks = await prisma.orderSyncRecord.findMany({
    where: { shopDomain: shop },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const plan = PLANS[subscription.planName] || (subscription.planName === "trial" ? { name: "Free Trial", listLimit: 5 } : { name: "Expired/Cancelled", listLimit: 1 });
  const listLimit = plan.listLimit || 1;

  let clickupFields = [];
  let fieldMappings = null;

  if (connection?.accessToken) {
    fieldMappings = connection.fieldMappings ? JSON.parse(connection.fieldMappings) : null;
    if (connection.listId) {
      const isGrowthOrPro =
        subscription.planName.startsWith("growth") ||
        subscription.planName.startsWith("pro") ||
        subscription.planName === "trial";
      if (isGrowthOrPro) {
        try {
          const { IntegrationFactory } = await import("../adapters/factory");
          const adapter = await IntegrationFactory.getAdapter(connection.selectedPlatform, connection.accessToken);
          clickupFields = await adapter.fetchFields(connection.listId);
        } catch (e) {
          console.error("Failed to load destination fields in loader:", e);
        }
      }
    }
  }

  return {
    shop,
    email: session.email || null,
    clickupConnectState: await signState(shop),
    connected: Boolean(connection?.accessToken),
    selectedPlatform: connection?.selectedPlatform || "clickup",
    workspaceName: connection?.workspaceName || null,
    listConnections: connection?.listConnections || [],
    lists,
    listError,
    clickupFields,
    fieldMappings,
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
    analytics: {
      totalSyncedMonth,
      totalSyncedAllTime,
      successRate,
      recentTasks: recentTasks.map((t) => ({
        id: t.id,
        shopifyOrderId: t.shopifyOrderId,
        orderNumber: t.orderNumber || `#${t.shopifyOrderId}`,
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

  const { getConnection, disconnect, logActivity, saveListConnections } = await import("../clickup.server");

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
      return { ok: false, error: `Failed to save: ${e.message}` };
    }
  }

  if (intent === "connect_platform") {
    const platform = formData.get("platform");
    const token = formData.get("token");
    if (!token) {
      return { ok: false, error: "API token is required." };
    }

    try {
      const { IntegrationFactory } = await import("../adapters/factory");
      const adapter = await IntegrationFactory.getAdapter(platform, token);
      const connected = await adapter.testConnection();
      if (!connected) {
        return { ok: false, error: "Failed to verify connection. Please check your token." };
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

      // Upsert new connection
      const conn = await prisma.platformConnection.upsert({
        where: {
          shopDomain_provider: {
            shopDomain: shop,
            provider: platform.toUpperCase()
          }
        },
        update: {
          encryptedAccessToken: encryptedToken,
          isActive: true
        },
        create: {
          shopDomain: shop,
          provider: platform.toUpperCase(),
          encryptedAccessToken: encryptedToken,
          isActive: true
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
      return { ok: false, error: `Connection failed: ${err.message}` };
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
      for (const m of parsed) {
        if (!m.clickupFieldId || !m.shopifySourceField) {
          return { ok: false, error: "Invalid mapping configuration." };
        }
      }

      const activeConn = await prisma.platformConnection.findFirst({
        where: { shopDomain: shop, isActive: true }
      });
      if (!activeConn) {
        return { ok: false, error: "No active connection found." };
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
      return { ok: false, error: `Failed to save mappings: ${e.message}` };
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

 🔗 View order: https://admin.shopify.com/store/syncup-test-store/orders/test`;

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
      return { ok: false, error: `Failed to send test task: ${e.message}` };
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
  active: { label: "Sync Active", color: C.accent, bg: "rgba(0,196,140,0.12)", dot: C.accent },
  paused: { label: "Sync Paused", color: "#ff9900", bg: "rgba(255,153,0,0.12)", dot: "#ff9900" },
  not_configured: { label: "Not Configured", color: C.muted, bg: "rgba(154,154,154,0.1)", dot: C.muted },
};

const BANNER_COLORS = {
  green: { bg: "rgba(0,196,140,0.12)", border: "1px solid #00c48c", color: "#00c48c" },
  yellow: { bg: "rgba(255,153,0,0.12)", border: "1px solid #ff9900", color: "#ff9900" },
  orange: { bg: "rgba(255,102,0,0.12)", border: "1px solid #ff6600", color: "#ff6600" },
  red: { bg: "rgba(255,68,68,0.12)", border: "1px solid #ff4444", color: "#ff4444" },
};

export default function Index() {
  const {
    shop,
    clickupConnectState,
    connected,
    selectedPlatform,
    workspaceName,
    listConnections,
    lists,
    clickupFields,
    fieldMappings,
    subscription,
    trialBanner,
    isTrialOrSubscriptionActive,
    syncStatus,
    billingSuccess,
    clickupError,
    removedLists,
    listLimit,
    analytics,
    recentActivity,
  } = useLoaderData();

  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [conns, setConns] = useState(
    listConnections.length > 0
      ? listConnections
      : [{ id: "", name: "", keyword: "" }]
  );

  const [billingInterval, setBillingInterval] = useState("monthly"); // monthly or annual
  const [fieldMappingsList, setFieldMappingsList] = useState(fieldMappings || []);
  const [selectedTool, setSelectedTool] = useState(null);

  const statusCfg = SYNC_STATUS_CONFIG[syncStatus];

  const handleDisconnect = (e) => {
    const platformName = selectedPlatform === "clickup" ? "ClickUp" : selectedPlatform === "monday" ? "Monday.com" : "Notion";
    if (
      !window.confirm(
        `Are you sure you want to disconnect ${platformName}? Order syncing will stop immediately.`
      )
    ) {
      e.preventDefault();
    }
  };

  const getPlanDisplayName = (planName) => {
    if (planName === "trial") return "Free Trial";
    if (planName === "free") return "Free Plan";
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
      `}</style>

      <div style={styles.page}>
        <div style={styles.container} className="su-container">
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
                Automatically sync your Shopify orders to ClickUp, Monday, or Notion.
              </p>
            </div>
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
          {billingSuccess && (
            <div style={{ ...styles.successBanner, marginBottom: 16 }}>
              ✓ Your plan has been updated successfully.
            </div>
          )}
          {actionData?.sentTestTask && (
            <div style={{ ...styles.successBanner, marginBottom: 16 }}>
              {`✓ Test task successfully sent! Check your connected ${selectedPlatform === "clickup" ? "ClickUp list" : selectedPlatform === "monday" ? "Monday board" : "Notion database"}.`}
            </div>
          )}
          {removedLists && (
            <div style={{ ...styles.warningBanner, marginBottom: 16 }}>
              ⚠️ Downgraded to Standard plan. The following extra list connections were removed: <strong>{removedLists}</strong>
            </div>
          )}
          {(clickupError || actionData?.error) && (
            <div style={{ ...styles.errorBanner, marginBottom: 16 }}>
              {clickupError || actionData?.error}
            </div>
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
                  
                  const overlayPlanSpecs = {
                    standard: {
                      badge: "Best for Starters",
                      priceDesc: "$29.99/mo",
                      annualPriceDesc: "$19.99/mo",
                      billedDesc: "Billed annually as $239",
                      regMonthly: "$49.99",
                      regAnnual: "$399",
                    },
                    growth: {
                      badge: "Most Popular",
                      priceDesc: "$49.99/mo",
                      annualPriceDesc: "$34.99/mo",
                      billedDesc: "Billed annually as $419",
                      regMonthly: "$79.99",
                      regAnnual: "$699",
                    },
                    pro: {
                      badge: "Concierge Setup Included",
                      priceDesc: "$99.99/mo",
                      annualPriceDesc: "$69.99/mo",
                      billedDesc: "Billed annually as $839",
                      regMonthly: "$149.99",
                      regAnnual: "$1199",
                    },
                  };
                  const spec = overlayPlanSpecs[key];

                  const displayPrice = billingInterval === "annual" 
                    ? spec.annualPriceDesc 
                    : spec.priceDesc;

                  const regularPrice = billingInterval === "annual"
                    ? spec.regAnnual
                    : spec.regMonthly;

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
                          {spec.badge}
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
                          {billingInterval === "annual" && (
                            <div className="text-[10px] text-zinc-400 mt-1.5 font-medium flex items-center gap-1">
                              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                              {spec.billedDesc} ({spec.priceDesc} equivalent)
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
                      <Form method="post" action={`/app/billing?platform=${selectedPlatform}`} target="_top" className="mt-auto">
                        <input type="hidden" name="intent" value="upgrade" />
                        <input type="hidden" name="plan" value={planKey} />
                        <button
                          type="submit"
                          className={`w-full py-2.5 rounded-xl text-xs font-bold transition-all duration-200 hover:scale-[1.02] cursor-pointer ${
                            isHighlighted
                              ? "bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-extrabold shadow-lg shadow-emerald-500/10"
                              : "bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700 hover:border-zinc-600"
                          }`}
                          disabled={isSubmitting}
                        >
                          {isSubmitting ? "Connecting..." : `Select ${plan.name.split(" ")[0]}`}
                        </button>
                      </Form>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : (
            <>
              {/* SECTION 1 — PLAN STATUS (active paid/trial merchants only) */}
              <section style={{ ...styles.card, marginBottom: 16 }}>
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

              {/* SECTION 3 — INTEGRATION SETUP WIZARD */}
              {!connected ? (
                <div>
                  {selectedTool === null ? (
                    /* STEP 1: WELCOME & TOOL SELECTOR GRID */
                    <section style={{ ...styles.card, marginBottom: 24 }}>
                      <h2 style={{ ...styles.cardTitle, marginTop: 0, textAlign: "center" }}>Choose your Workspace Tool</h2>
                      <p style={{ ...styles.cardText, textAlign: "center", marginBottom: 24 }}>
                        Select the project management platform you want to sync your Shopify orders to.
                      </p>

                      <div className="su-platform-grid">
                        {/* ClickUp */}
                        <button
                          type="button"
                          className="su-platform-card clickup"
                          onClick={() => setSelectedTool("clickup")}
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
                          onClick={() => setSelectedTool("monday")}
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
                          <span className="su-platform-badge coming-soon">Beta</span>
                        </button>

                        {/* Notion */}
                        <button
                          type="button"
                          className="su-platform-card notion"
                          onClick={() => setSelectedTool("notion")}
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
                          <span className="su-platform-badge coming-soon">Beta</span>
                        </button>
                      </div>
                    </section>
                  ) : (
                    /* STEP 2: DEDICATED TOOL CONFIGURATION SCREEN */
                    <div>
                      {/* Navigation Link Back */}
                      <div style={{ marginBottom: 16 }}>
                        <button
                          type="button"
                          onClick={() => setSelectedTool(null)}
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
                            transition: "all 0.2s ease",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = "rgba(0, 196, 140, 0.12)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = "rgba(0, 196, 140, 0.06)";
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
                                  
                                  const overlayPlanSpecs = {
                                    standard: {
                                      badge: "Best for Starters",
                                      priceDesc: "$29.99/mo",
                                      annualPriceDesc: "$19.99/mo",
                                      billedDesc: "Billed annually as $239",
                                      regMonthly: "$49.99",
                                      regAnnual: "$399",
                                    },
                                    growth: {
                                      badge: "Most Popular",
                                      priceDesc: "$49.99/mo",
                                      annualPriceDesc: "$34.99/mo",
                                      billedDesc: "Billed annually as $419",
                                      regMonthly: "$79.99",
                                      regAnnual: "$699",
                                    },
                                    pro: {
                                      badge: "Concierge Setup Included",
                                      priceDesc: "$99.99/mo",
                                      annualPriceDesc: "$69.99/mo",
                                      billedDesc: "Billed annually as $839",
                                      regMonthly: "$149.99",
                                      regAnnual: "$1199",
                                    },
                                  };
                                  const spec = overlayPlanSpecs[key];

                                  const displayPrice = billingInterval === "annual" 
                                    ? spec.annualPriceDesc 
                                    : spec.priceDesc;

                                  const regularPrice = billingInterval === "annual"
                                    ? spec.regAnnual
                                    : spec.regMonthly;

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
                                          {spec.badge}
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
                                          {billingInterval === "annual" && (
                                            <div className="text-[10px] text-zinc-400 mt-1.5 font-medium flex items-center gap-1">
                                              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                                              {spec.billedDesc} ({spec.priceDesc} equivalent)
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
                                      <Form method="post" action={`/app/billing?platform=clickup`} target="_top" className="mt-auto">
                                        <input type="hidden" name="intent" value="upgrade" />
                                        <input type="hidden" name="plan" value={planKey} />
                                        <button
                                          type="submit"
                                          className={`w-full py-2.5 rounded-xl text-xs font-bold transition-all duration-200 hover:scale-[1.02] cursor-pointer ${
                                            isHighlighted
                                              ? "bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-extrabold shadow-lg shadow-emerald-500/10"
                                              : "bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700 hover:border-zinc-600"
                                          }`}
                                          style={{
                                            border: isHighlighted ? "none" : `1px solid ${C.border}`,
                                            background: isHighlighted ? C.accent : "#1a1a1a",
                                            color: isHighlighted ? "#03251c" : C.text,
                                            width: "100%",
                                          }}
                                          disabled={isSubmitting}
                                        >
                                          {isSubmitting ? "Connecting..." : `Select ${plan.name.split(" ")[0]}`}
                                        </button>
                                      </Form>
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
                                {selectedTool === "monday" ? "Monday.com Personal Access Token" : "Notion Integration Token"}
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
                </div>
              ) : (
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

                      <Form method="post" onSubmit={handleDisconnect}>
                        <input type="hidden" name="intent" value="disconnect" />
                        <button
                          type="submit"
                          style={styles.dangerButton}
                          disabled={isSubmitting}
                        >
                          Disconnect
                        </button>
                      </Form>
                    </div>
                  </div>

                  {actionData?.saved && (
                    <div style={styles.successBanner}>
                      ✓ Connections saved successfully.
                    </div>
                  )}

                  <h2 style={styles.cardTitle}>Configure order {selectedPlatform === "clickup" ? "list" : selectedPlatform === "monday" ? "board" : "database"} connections</h2>
                  <p style={styles.cardText}>
                    Select where new orders should sync. Growth plan merchants can configure up to 5 {selectedPlatform === "clickup" ? "lists" : selectedPlatform === "monday" ? "boards" : "databases"} with keyword filters to route orders automatically.
                  </p>

                  {lists.length === 0 ? (
                    <p style={styles.cardText}>
                      No {selectedPlatform === "clickup" ? "lists" : selectedPlatform === "monday" ? "boards" : "databases"} found in your {selectedPlatform === "clickup" ? "ClickUp" : selectedPlatform === "monday" ? "Monday.com" : "Notion"} workspaces. Create one first then reload this page.
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
                                {selectedPlatform === "clickup" ? "ClickUp List" : selectedPlatform === "monday" ? "Monday Board" : "Notion Database"}
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
                              <div style={{ flex: 1, minWidth: "120px" }}>
                                <label style={styles.formLabel} htmlFor={`kw_${index}`}>Product Keyword / Tag</label>
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
                          onClick={() => setConns([...conns, { id: lists[0]?.id || "", name: lists[0]?.name || "", keyword: "" }])}
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

              {/* SECTION 3.5 — CUSTOM FIELD / COLUMN / PROPERTY MAPPING */}
              {connected && (
                <section style={{ ...styles.card, marginTop: 16 }}>
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
                          <div style={{ marginTop: 8 }}>
                            <Link
                              to={`/app/billing?platform=${selectedPlatform}`}
                              className="inline-flex items-center justify-center bg-emerald-500 hover:bg-emerald-400 text-zinc-950 px-4 py-2.5 rounded-xl text-xs font-black tracking-wide shadow-lg shadow-emerald-500/10 transition-all duration-200"
                              style={{ textDecoration: "none", color: "#03251c" }}
                            >
                              Upgrade to Unlock Custom Mapping
                            </Link>
                          </div>
                        </div>
                      );
                    }

                    // Mapping unlocked (Trial, Growth, or Pro)
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

                        {selectedPlatform === "clickup" && fieldMappingsList.length > 0 && (
                          <div style={{ ...styles.warningBanner, marginBottom: 16, fontSize: "13px", lineHeight: "1.4" }}>
                            <strong>⚠️ ClickUp Free Tier Notice:</strong> ClickUp Free Forever plans have a lifetime limit of 60 custom field uses. If your workspace is on the Free tier, updates to mapped fields will stop syncing once this limit is reached.
                          </div>
                        )}

                        {clickupFields.length === 0 ? (
                          <p style={styles.cardText}>
                            No custom {termFieldName.toLowerCase()}s found in your connected {selectedPlatform === "clickup" ? "list" : selectedPlatform === "monday" ? "board" : "database"}. Create some first, then reload this page.
                          </p>
                        ) : (
                          <div style={{ border: `1px solid ${C.border}`, borderRadius: "12px", overflow: "hidden", background: "#151515" }}>
                            {/* Table Header */}
                            <div className="grid grid-cols-12 bg-zinc-900/50 p-4 border-b border-zinc-800 font-semibold text-xs tracking-wider uppercase text-zinc-400">
                              <div className="col-span-5">Shopify Source Field</div>
                              <div className="col-span-2 text-center">Flow</div>
                              <div className="col-span-5">Destination {termFieldName}</div>
                            </div>

                            {/* Mappings */}
                            <div className="divide-y divide-zinc-900/50">
                              {clickupFields.map((field) => {
                                const currentMapping = fieldMappingsList.find((m) => m.clickupFieldId === field.id);
                                return (
                                  <div key={field.id} className="grid grid-cols-12 items-center p-4 hover:bg-zinc-900/10 transition-colors">
                                    {/* Shopify field selector */}
                                    <div className="col-span-5">
                                      <select
                                        value={currentMapping?.shopifySourceField || ""}
                                        onChange={(e) => {
                                          const val = e.currentTarget.value;
                                          // Update state
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
              )}

              {/* SECTION 4 — SYNC ANALYTICS (locked for Standard, active for Growth/Pro, active during trial) */}
              {(() => {
                const isTrial = subscription.planName === "trial";
                const isGrowthOrPro = subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro");
                const isAnalyticsUnlocked = isGrowthOrPro || isTrial;

                return (
                  <section style={{ ...styles.card, marginTop: 16, position: "relative", overflow: "hidden" }}>
                    <h2 style={{ ...styles.cardTitle, marginTop: 0, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      Sync Analytics
                      {isTrial && (
                        <span style={{
                          fontSize: 11,
                          color: C.accent,
                          background: "rgba(0,196,140,0.12)",
                          border: `1px solid ${C.accent}44`,
                          padding: "2px 8px",
                          borderRadius: 12,
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em"
                        }}>
                          Growth Plan Feature (Free during trial)
                        </span>
                      )}
                    </h2>

                    <div style={isAnalyticsUnlocked ? {} : { filter: "blur(4px)", pointerEvents: "none", opacity: 0.6 }}>
                      <div style={styles.analyticsGrid}>
                        <div style={styles.analyticsStatCard}>
                          <div style={styles.analyticsStatLabel}>Synced this month</div>
                          <div style={styles.analyticsStatValue}>{analytics.totalSyncedMonth}</div>
                        </div>
                        <div style={styles.analyticsStatCard}>
                          <div style={styles.analyticsStatLabel}>Synced all time</div>
                          <div style={styles.analyticsStatValue}>{analytics.totalSyncedAllTime}</div>
                        </div>
                        <div style={styles.analyticsStatCard}>
                          <div style={styles.analyticsStatLabel}>Success Rate</div>
                          <div style={styles.analyticsStatValue}>{analytics.successRate}%</div>
                        </div>
                      </div>

                      <h3 style={styles.sectionSubheading}>Recent Sync Events</h3>
                      {analytics.recentTasks.length === 0 ? (
                        <p style={styles.cardText}>No sync events recorded yet.</p>
                      ) : (
                        <table style={styles.table}>
                          <thead>
                            <tr>
                              <th style={styles.th}>Time</th>
                              <th style={styles.th}>Order</th>
                              <th style={styles.th}>Event</th>
                              <th style={styles.th}>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {analytics.recentTasks.map((t) => (
                              <tr key={t.id} style={styles.tr}>
                                <td style={styles.td}>{timeAgo(t.createdAt)}</td>
                                <td style={styles.td}>{t.orderNumber}</td>
                                <td style={styles.td}>
                                  {t.status === "fulfilled"
                                    ? "Fulfillment Synced"
                                    : t.status === "failed"
                                    ? "Sync Failed"
                                    : t.status === "retrying"
                                    ? "Sync Retried (Queued)"
                                    : "Order Synced"}
                                </td>
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
                      <div style={styles.analyticsLockOverlay}>
                        <div style={styles.lockIcon}>🔒</div>
                        <div style={styles.lockTitle}>Growth Plan Feature</div>
                        <div style={styles.lockText}>
                          Upgrade to the Growth plan to unlock sync analytics, up to 5 {selectedPlatform === "clickup" ? "list" : selectedPlatform === "monday" ? "board" : "database"} connections, priority support, and automatic webhook retries.
                        </div>
                        <Link to={`/app/billing?platform=${selectedPlatform}`} style={styles.upgradeInlineButton}>
                          Upgrade to Growth
                        </Link>
                      </div>
                    )}
                  </section>
                );
              })()}

              {/* Recent Activity Log */}
              {recentActivity.length > 0 && (
                <section style={{ ...styles.card, marginTop: 16 }}>
                  <h2 style={{ ...styles.cardTitle, marginTop: 0 }}>
                    Recent log
                  </h2>
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
                </section>
              )}
            </>
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
