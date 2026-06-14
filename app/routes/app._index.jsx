import { useState } from "react";
import { Form, useLoaderData, useActionData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, registerWebhooks } from "../shopify.server";
import {
  getConnection,
  getAllLists,
  saveList,
  disconnect,
  getRecentActivity,
  logActivity,
} from "../clickup.server";
import { getOrCreateSubscription } from "../billing.server";
import { PLANS } from "../plans";

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
      listError =
        "We couldn't load your ClickUp lists. Try disconnecting and reconnecting.";
    }
  }

  const url = new URL(request.url);
  const billingSuccess = url.searchParams.get("billing_success") === "1";
  const clickupError = url.searchParams.get("clickup_error") || null;

  // Compute sync status
  let syncStatus = "not_configured";
  if (connection?.accessToken && connection?.listId) {
    const plan = PLANS[subscription.planName] || PLANS.free;
    const limitExceeded =
      plan.monthlyOrderLimit !== null &&
      subscription.ordersThisMonth >= plan.monthlyOrderLimit;
    syncStatus = limitExceeded ? "paused" : "active";
  }

  return {
    shop,
    connected: Boolean(connection?.accessToken),
    workspaceName: connection?.workspaceName || null,
    selectedListId: connection?.listId || "",
    selectedListName: connection?.listName || "",
    lists,
    listError,
    subscription: {
      planName: subscription.planName,
      ordersThisMonth: subscription.ordersThisMonth,
      status: subscription.status,
    },
    syncStatus,
    billingSuccess,
    clickupError,
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

  if (intent === "save") {
    const listId = formData.get("listId");
    const listName = formData.get("listName");
    if (!listId) {
      return { ok: false, error: "Please choose a list before saving." };
    }
    await saveList(shop, String(listId), String(listName || ""));
    return { ok: true, saved: true, listName: String(listName || "") };
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
  clickup_connected: "⚡",
  clickup_disconnected: "✗",
};
const EVENT_COLORS = {
  order_synced: C.accent,
  order_fulfilled: C.accent,
  sync_failed: "#ff8a8a",
  clickup_connected: C.accent,
  clickup_disconnected: "#ff8a8a",
};

const SYNC_STATUS_CONFIG = {
  active: { label: "Sync Active", color: C.accent, bg: "rgba(0,196,140,0.12)", dot: C.accent },
  paused: { label: "Sync Paused", color: "#f0c040", bg: "rgba(240,192,64,0.12)", dot: "#f0c040" },
  not_configured: { label: "Not Configured", color: C.muted, bg: "rgba(154,154,154,0.1)", dot: C.muted },
};

export default function Index() {
  const {
    shop,
    connected,
    workspaceName,
    selectedListId,
    selectedListName,
    lists,
    listError,
    subscription,
    syncStatus,
    billingSuccess,
    clickupError,
    recentActivity,
  } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const plan = PLANS[subscription.planName] || PLANS.free;
  const orderLimit = plan.monthlyOrderLimit;
  const limitExceeded =
    orderLimit !== null && subscription.ordersThisMonth >= orderLimit;

  const initialList = lists.find((l) => l.id === selectedListId) || lists[0] || null;
  const [chosenId, setChosenId] = useState(selectedListId || initialList?.id || "");
  const chosenList = lists.find((l) => l.id === chosenId);
  const chosenName = chosenList?.name || selectedListName || "";

  const syncingTo = actionData?.saved
    ? actionData.listName
    : !actionData?.disconnected && selectedListId
      ? selectedListName
      : null;

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

  return (
    <>
      {/* Mobile-responsive overrides — inline style can't do media queries */}
      <style>{`
        @media (max-width: 600px) {
          .su-plan-row { flex-direction: column !important; align-items: flex-start !important; }
          .su-plan-btn { align-self: flex-start; }
          .su-container { padding: 24px 12px !important; }
        }
      `}</style>

      <div style={styles.page}>
        <div style={styles.container} className="su-container">
          {/* Header */}
          <header style={styles.header}>
            <div style={styles.logoDot} />
            <div style={{ flex: 1 }}>
              <h1 style={styles.title}>SyncUp</h1>
              <p style={styles.subtitle}>
                Automatically sync your Shopify orders to your project tools.
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

          {/* Transient banners */}
          {billingSuccess && (
            <div style={{ ...styles.successBanner, marginBottom: 16 }}>
              ✓ Your plan has been updated successfully.
            </div>
          )}
          {(clickupError || actionData?.clickupError) && (
            <div style={{ ...styles.errorBanner, marginBottom: 16 }}>
              {clickupError || actionData?.clickupError}
            </div>
          )}
          {limitExceeded && (
            <div style={styles.limitBanner}>
              <strong>Monthly limit reached.</strong> You've used all 50 free
              orders this month. New orders won't sync until you upgrade or the
              counter resets on the 1st.{" "}
              <a href="/app/billing" target="_top" style={styles.limitBannerLink}>
                Upgrade now →
              </a>
            </div>
          )}

          {/* Plan card */}
          <section style={{ ...styles.card, marginBottom: 16 }}>
            <div style={styles.planRow} className="su-plan-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={styles.planLabel}>Current plan</div>
                <div style={styles.planName}>
                  {plan.name}
                  {subscription.planName !== "free" && (
                    <span style={styles.paidBadge}>Active</span>
                  )}
                </div>
                {orderLimit !== null ? (
                  <div style={styles.planUsage}>
                    <div style={styles.usageBar}>
                      <div
                        style={{
                          ...styles.usageFill,
                          width: `${Math.min(100, (subscription.ordersThisMonth / orderLimit) * 100)}%`,
                          background: limitExceeded ? "#ff5a5a" : C.accent,
                        }}
                      />
                    </div>
                    <span
                      style={{
                        ...styles.usageText,
                        color: limitExceeded ? "#ff8a8a" : C.muted,
                      }}
                    >
                      {subscription.ordersThisMonth} / {orderLimit} orders this month
                    </span>
                  </div>
                ) : (
                  <div style={{ ...styles.usageText, marginTop: 6 }}>
                    {subscription.ordersThisMonth} orders synced this month
                  </div>
                )}
              </div>
              <a
                href="/app/billing"
                target="_top"
                style={styles.managePlanButton}
                className="su-plan-btn"
              >
                {subscription.planName === "free" ? "Upgrade" : "Manage plan"}
              </a>
            </div>
          </section>

          {/* ClickUp connection card */}
          {!connected ? (
            <section style={styles.card}>
              <h2 style={styles.cardTitle}>Connect your ClickUp account</h2>
              <p style={styles.cardText}>
                Connect ClickUp to start syncing new orders into a list of your
                choice. New orders become tasks, fulfilled orders get marked
                complete — automatically.
              </p>
              <a
                href={`/auth/clickup?shop=${encodeURIComponent(shop)}`}
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

              {syncingTo && (
                <div style={styles.successBanner}>
                  ✓ Orders are syncing to <strong>{syncingTo}</strong>
                </div>
              )}
              {actionData?.error && (
                <div style={styles.errorBanner}>{actionData.error}</div>
              )}
              {listError && <div style={styles.errorBanner}>{listError}</div>}

              <h2 style={styles.cardTitle}>Choose a list to sync orders into</h2>

              {lists.length === 0 ? (
                <p style={styles.cardText}>
                  No lists found in your ClickUp workspaces. Create a list in
                  ClickUp then reload this page.
                </p>
              ) : (
                <Form method="post" style={styles.form}>
                  <input type="hidden" name="intent" value="save" />
                  <input type="hidden" name="listName" value={chosenName} />
                  <label style={styles.label} htmlFor="listId">
                    ClickUp list
                  </label>
                  <select
                    id="listId"
                    name="listId"
                    value={chosenId}
                    onChange={(e) => setChosenId(e.currentTarget.value)}
                    style={styles.select}
                  >
                    {lists.map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    style={styles.primaryButton}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? "Saving…" : "Save"}
                  </button>
                </Form>
              )}
            </section>
          )}

          {/* Recent activity */}
          {recentActivity.length > 0 && (
            <section style={{ ...styles.card, marginTop: 16 }}>
              <h2 style={{ ...styles.cardTitle, marginTop: 0 }}>
                Recent activity
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
  logoDot: {
    width: 44,
    height: 44,
    borderRadius: 12,
    background: C.accent,
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
  form: { display: "flex", flexDirection: "column", gap: 12 },
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
  successBanner: {
    background: "rgba(0, 196, 140, 0.12)",
    border: `1px solid ${C.accent}`,
    color: C.accent,
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 14,
    margin: "16px 0 4px",
  },
  errorBanner: {
    background: "rgba(255, 90, 90, 0.12)",
    border: "1px solid #ff5a5a",
    color: "#ff8a8a",
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 14,
    margin: "16px 0 4px",
  },
  limitBanner: {
    background: "rgba(255, 165, 0, 0.1)",
    border: "1px solid #f0a500",
    color: "#f0c040",
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 14,
    marginBottom: 16,
    lineHeight: 1.5,
  },
  limitBannerLink: { color: "#f0c040", fontWeight: 600, textDecoration: "underline" },
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
  planUsage: { display: "flex", flexDirection: "column", gap: 6, maxWidth: 260 },
  usageBar: { height: 4, background: C.border, borderRadius: 2, overflow: "hidden" },
  usageFill: { height: "100%", borderRadius: 2, transition: "width 0.3s ease" },
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
};

export const headers = (headersArgs) => boundary.headers(headersArgs);
