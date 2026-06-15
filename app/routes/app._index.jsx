import { useState } from "react";
import { Form, useLoaderData, useActionData, useNavigation, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, registerWebhooks } from "../shopify.server";
import {
  getConnection,
  getAllLists,
  saveListConnections,
  disconnect,
  getRecentActivity,
  logActivity,
} from "../clickup.server";
import { getOrCreateSubscription, getTrialBannerStatus, isSubscriptionActive } from "../billing.server";
import { signState } from "../oauth-state.server";
import { PLANS } from "../plans";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  try {
    await registerWebhooks({ session });
  } catch (e) {
    console.error("registerWebhooks error:", e);
  }

  const [connection, subscription, recentActivity] = await Promise.all([
    getConnection(shop),
    getOrCreateSubscription(shop),
    getRecentActivity(shop, 5),
  ]);

  let lists = [];
  let listError = null;

  if (connection?.accessToken) {
    try {
      lists = await getAllLists(connection.accessToken);
    } catch (error) {
      console.error(`Failed to load ClickUp lists for ${shop}:`, error);
      listError = "We couldn't load your ClickUp lists. Try disconnecting and reconnecting.";
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

  const isGrowthOrPro = subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro");
  const totalSyncedMonth = subscription.ordersSyncedThisMonth || 0;
  const totalSyncedAllTime = subscription.ordersSyncedAllTime || 0;

  const totalTasks = await prisma.orderTask.count({ where: { shopDomain: shop } });
  const failedTasks = await prisma.orderTask.count({
    where: { shopDomain: shop, status: "failed" },
  });
  const successRate = totalTasks === 0 ? 100 : Math.round(((totalTasks - failedTasks) / totalTasks) * 100);

  const recentTasks = await prisma.orderTask.findMany({
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
          const { fetchListCustomFields } = await import("../clickup.server");
          clickupFields = await fetchListCustomFields(connection.accessToken, connection.listId);
        } catch (e) {
          console.error("Failed to load list custom fields in loader:", e);
        }
      }
    }
  }

  return {
    shop,
    clickupConnectState: await signState(shop),
    connected: Boolean(connection?.accessToken),
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
        status: t.status,
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

  if (intent === "disconnect") {
    await disconnect(shop);
    logActivity(shop, "clickup_disconnected", "ClickUp account disconnected");
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

  if (intent === "save_field_mappings") {
    const jsonStr = formData.get("fieldMappingsJson");
    if (!jsonStr) {
      return { ok: false, error: "No mapping data provided." };
    }
    try {
      await prisma.clickUpConnection.update({
        where: { shopDomain: shop },
        data: { fieldMappings: String(jsonStr) },
      });
      return { ok: true, savedMappings: true };
    } catch (e) {
      return { ok: false, error: `Failed to save mappings: ${e.message}` };
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
    workspaceName,
    listConnections,
    lists,
    listError,
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

  const statusCfg = SYNC_STATUS_CONFIG[syncStatus];

  const handleDisconnect = (e) => {
    if (
      !window.confirm(
        "Are you sure you want to disconnect ClickUp? Order syncing will stop immediately."
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
  const showFullPageUpgrade = !isTrialOrSubscriptionActive;

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
                Automatically sync your Shopify orders to ClickUp.
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
                          {plan.features.map((feat) => (
                            <li key={feat} className="flex items-start">
                              <span className="text-emerald-400 mr-2 flex-shrink-0 font-bold">✓</span>
                              <span className="leading-snug">{feat}</span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      {/* Submit action */}
                      <Form method="post" action="/app/billing" target="_top" className="mt-auto">
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
                    to="/app/billing"
                    style={styles.managePlanButton}
                    className="su-plan-btn"
                  >
                    Manage billing
                  </Link>
                </div>
              </section>

              {/* SECTION 3 — CLICKUP CONNECTION */}
              {!connected ? (
                <section style={styles.card}>
                  <h2 style={styles.cardTitle}>Connect your ClickUp account</h2>
                  <p style={styles.cardText}>
                    Connect ClickUp to start syncing new orders into a list of your
                    choice. New orders become tasks, fulfilled orders get marked
                    complete — automatically. Notion and Monday integrations are coming soon!
                  </p>
                  <a
                    href={`/auth/clickup?state=${encodeURIComponent(clickupConnectState)}`}
                    target="_top"
                    style={styles.primaryButton}
                  >
                    Connect ClickUp
                  </a>
                </section>
              ) : (
                <section style={styles.card}>
                  <div style={styles.cardHeaderRow}>
                    <div style={styles.statusRow}>
                      <span style={styles.statusDot} />
                      <span style={styles.statusText}>
                        {workspaceName
                          ? `Connected to ${workspaceName}`
                          : "ClickUp connected"}
                      </span>
                    </div>
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

                  {actionData?.saved && (
                    <div style={styles.successBanner}>
                      ✓ Connections saved successfully.
                    </div>
                  )}

                  <h2 style={styles.cardTitle}>Configure order list connections</h2>
                  <p style={styles.cardText}>
                    Select where new orders should sync. Growth plan merchants can configure up to 5 lists with keyword filters to route orders automatically.
                  </p>

                  {lists.length === 0 ? (
                    <p style={styles.cardText}>
                      No lists found in your ClickUp workspaces. Create a list in
                      ClickUp then reload this page.
                    </p>
                  ) : (
                    <Form method="post" style={styles.form}>
                      <input type="hidden" name="intent" value="save_connections" />
                      <input type="hidden" name="listConnectionsJson" value={JSON.stringify(conns)} />

                      <div style={styles.connectionsContainer}>
                        {conns.map((conn, index) => (
                          <div key={index} style={styles.connectionRow}>
                            <div style={{ flex: 2, minWidth: "150px" }}>
                              <label style={styles.formLabel} htmlFor={`list_${index}`}>ClickUp List</label>
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
                                <option value="">Select a list...</option>
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
                          + Add list connection
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

              {/* SECTION 3.5 — CLICKUP CUSTOM FIELD MAPPING */}
              {connected && (
                <section style={{ ...styles.card, marginTop: 16 }}>
                  {(() => {
                    const isTrial = subscription.planName === "trial";
                    const isGrowthOrPro = subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro");
                    const isMappingUnlocked = isGrowthOrPro || isTrial;

                    if (!isMappingUnlocked) {
                      return (
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                          <h2 style={{ ...styles.cardTitle, marginTop: 0, display: "flex", alignItems: "center", gap: 8 }}>
                            ClickUp Custom Field Mapping
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
                            Map Shopify order attributes directly to your custom columns in ClickUp. This feature is available on the Growth & Pro plans.
                          </p>
                          <div style={{ marginTop: 8 }}>
                            <Link
                              to="/app/billing"
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
                          <h2 style={{ ...styles.cardTitle, marginTop: 0 }}>ClickUp Custom Field Mapping</h2>
                          <p style={styles.cardText}>
                            Please configure and save at least one ClickUp list connection above to begin mapping custom fields.
                          </p>
                        </div>
                      );
                    }

                    return (
                      <div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
                          <div style={{ flex: 1, minWidth: "250px" }}>
                            <h2 style={{ ...styles.cardTitle, marginTop: 0, display: "flex", alignItems: "center", gap: 8 }}>
                              ClickUp Custom Field Mapping
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
                              Map Shopify order attributes directly to custom columns inside your primary connected ClickUp list.
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
                              {isSubmitting ? "Saving..." : "Save field mappings"}
                            </button>
                          </Form>
                        </div>

                        {actionData?.savedMappings && (
                          <div style={{ ...styles.successBanner, marginBottom: 16 }}>
                            ✓ Field mappings saved successfully.
                          </div>
                        )}

                        {clickupFields.length === 0 ? (
                          <p style={styles.cardText}>
                            No custom fields found in your connected ClickUp list. Create some custom fields in ClickUp first, then reload this page.
                          </p>
                        ) : (
                          <div style={{ border: `1px solid ${C.border}`, borderRadius: "12px", overflow: "hidden", background: "#151515" }}>
                            {/* Table Header */}
                            <div className="grid grid-cols-12 bg-zinc-900/50 p-4 border-b border-zinc-800 font-semibold text-xs tracking-wider uppercase text-zinc-400">
                              <div className="col-span-5">Shopify Source Field</div>
                              <div className="col-span-2 text-center">Flow</div>
                              <div className="col-span-5">ClickUp Custom Field (Destination)</div>
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
                          Upgrade to the Growth plan to unlock sync analytics, up to 5 list connections, priority support, and automatic webhook retries.
                        </div>
                        <Link to="/app/billing" style={styles.upgradeInlineButton}>
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
