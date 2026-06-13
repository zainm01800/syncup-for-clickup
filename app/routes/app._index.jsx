import { useState } from "react";
import { Form, useLoaderData, useActionData, useNavigation, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, registerWebhooks } from "../shopify.server";
import {
  getConnection,
  getAllLists,
  saveList,
  disconnect,
} from "../clickup.server";
import { getOrCreateSubscription, PLANS } from "../billing.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  try {
    const result = await registerWebhooks({ session });
    console.log("registerWebhooks result:", JSON.stringify(result));
  } catch (e) {
    console.error("registerWebhooks error:", e);
  }

  const [connection, subscription] = await Promise.all([
    getConnection(shop),
    getOrCreateSubscription(shop),
  ]);

  let lists = [];
  let listError = null;

  if (connection?.accessToken) {
    try {
      lists = await getAllLists(connection.accessToken);
    } catch (error) {
      console.error(`Failed to load ClickUp lists for ${shop}:`, error);
      listError =
        "We couldn't load your ClickUp lists. Try disconnecting and connecting again.";
    }
  }

  const url = new URL(request.url);
  const billingSuccess = url.searchParams.get("billing_success") === "1";

  return {
    shop,
    connected: Boolean(connection?.accessToken),
    selectedListId: connection?.listId || "",
    selectedListName: connection?.listName || "",
    lists,
    listError,
    subscription: {
      planName: subscription.planName,
      ordersThisMonth: subscription.ordersThisMonth,
      status: subscription.status,
    },
    billingSuccess,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "disconnect") {
    await disconnect(shop);
    return { ok: true, disconnected: true };
  }

  if (intent === "save") {
    const listId = formData.get("listId");
    const listName = formData.get("listName");
    if (!listId) {
      return { ok: false, error: "Please choose a list before saving." };
    }
    await saveList(shop, String(listId), String(listName || ""));
    return {
      ok: true,
      saved: true,
      listName: String(listName || ""),
    };
  }

  return { ok: false, error: "Unknown action." };
};

const COLORS = {
  bg: "#0f0f0f",
  surface: "#1a1a1a",
  border: "#2a2a2a",
  text: "#ffffff",
  muted: "#9a9a9a",
  accent: "#00c48c",
};

export default function Index() {
  const {
    shop,
    connected,
    selectedListId,
    selectedListName,
    lists,
    listError,
    subscription,
    billingSuccess,
  } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const plan = PLANS[subscription.planName] || PLANS.free;
  const orderLimit = plan.monthlyOrderLimit;
  const limitExceeded =
    orderLimit !== null && subscription.ordersThisMonth >= orderLimit;

  const initialList =
    lists.find((l) => l.id === selectedListId) || lists[0] || null;
  const [chosenId, setChosenId] = useState(
    selectedListId || initialList?.id || "",
  );
  const chosenList = lists.find((l) => l.id === chosenId);
  const chosenName = chosenList?.name || selectedListName || "";

  const syncingTo = actionData?.saved
    ? actionData.listName
    : !actionData?.disconnected && selectedListId
      ? selectedListName
      : null;

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <header style={styles.header}>
          <div style={styles.logoDot} />
          <div>
            <h1 style={styles.title}>SyncUp for ClickUp</h1>
            <p style={styles.subtitle}>
              Automatically turn Shopify orders into ClickUp tasks.
            </p>
          </div>
        </header>

        {/* Billing success banner */}
        {billingSuccess && (
          <div style={{ ...styles.successBanner, marginBottom: "20px" }}>
            ✓ Your plan has been updated successfully.
          </div>
        )}

        {/* Free tier limit exceeded warning */}
        {limitExceeded && (
          <div style={styles.limitBanner}>
            <strong>Monthly limit reached.</strong> You've used all 50 free
            orders this month. New orders will not sync until you upgrade or
            until the counter resets on the 1st.{" "}
            <a href="/app/billing" target="_top" style={styles.limitBannerLink}>
              Upgrade now →
            </a>
          </div>
        )}

        {/* Plan section */}
        <section style={{ ...styles.card, marginBottom: "20px" }}>
          <div style={styles.planRow}>
            <div>
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
                        background: limitExceeded ? "#ff5a5a" : COLORS.accent,
                      }}
                    />
                  </div>
                  <span style={{ ...styles.usageText, color: limitExceeded ? "#ff8a8a" : COLORS.muted }}>
                    {subscription.ordersThisMonth} / {orderLimit} orders this month
                  </span>
                </div>
              ) : (
                <div style={{ ...styles.usageText, marginTop: "6px" }}>
                  {subscription.ordersThisMonth} orders synced this month
                </div>
              )}
            </div>
            <a href="/app/billing" target="_top" style={styles.managePlanButton}>
              {subscription.planName === "free" ? "Upgrade" : "Manage plan"}
            </a>
          </div>
        </section>

        {/* ClickUp connection section */}
        {!connected ? (
          <section style={styles.card}>
            <h2 style={styles.cardTitle}>Connect your ClickUp account</h2>
            <p style={styles.cardText}>
              Connect ClickUp to start syncing new orders into a list of your
              choice. New orders become tasks, and fulfilled orders are marked
              complete automatically.
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
                <span style={styles.statusText}>ClickUp connected</span>
              </div>
              <Form method="post">
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
                No lists were found in your ClickUp workspaces. Create a list in
                ClickUp, then reload this page.
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

        <footer style={styles.footer}>
          Connected store: <span style={styles.footerShop}>{shop}</span>
          {" · "}
          <a href="/privacy" target="_top" style={styles.footerLink}>
            Privacy Policy
          </a>
        </footer>
      </div>
    </div>
  );
}

const styles = {
  page: {
    background: COLORS.bg,
    color: COLORS.text,
    minHeight: "100vh",
    fontFamily:
      "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding: "40px 20px",
    boxSizing: "border-box",
  },
  container: {
    maxWidth: "640px",
    margin: "0 auto",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "16px",
    marginBottom: "32px",
  },
  logoDot: {
    width: "44px",
    height: "44px",
    borderRadius: "12px",
    background: COLORS.accent,
    flexShrink: 0,
  },
  title: {
    margin: 0,
    fontSize: "24px",
    fontWeight: 600,
    color: COLORS.text,
  },
  subtitle: {
    margin: "4px 0 0",
    fontSize: "14px",
    color: COLORS.muted,
  },
  card: {
    background: COLORS.surface,
    border: `1px solid ${COLORS.border}`,
    borderRadius: "16px",
    padding: "28px",
  },
  cardHeaderRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "8px",
  },
  cardTitle: {
    margin: "16px 0 8px",
    fontSize: "18px",
    fontWeight: 600,
    color: COLORS.text,
  },
  cardText: {
    margin: "0 0 20px",
    fontSize: "14px",
    lineHeight: 1.6,
    color: COLORS.muted,
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  statusDot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    background: COLORS.accent,
    boxShadow: `0 0 8px ${COLORS.accent}`,
  },
  statusText: {
    fontSize: "14px",
    fontWeight: 500,
    color: COLORS.text,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  label: {
    fontSize: "13px",
    fontWeight: 500,
    color: COLORS.muted,
  },
  select: {
    width: "100%",
    background: COLORS.bg,
    color: COLORS.text,
    border: `1px solid ${COLORS.border}`,
    borderRadius: "10px",
    padding: "12px 14px",
    fontSize: "14px",
    outline: "none",
    boxSizing: "border-box",
  },
  primaryButton: {
    display: "inline-block",
    background: COLORS.accent,
    color: "#03251c",
    border: "none",
    borderRadius: "10px",
    padding: "12px 22px",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    textDecoration: "none",
    marginTop: "4px",
    width: "fit-content",
  },
  dangerButton: {
    background: "transparent",
    color: COLORS.muted,
    border: `1px solid ${COLORS.border}`,
    borderRadius: "10px",
    padding: "8px 16px",
    fontSize: "13px",
    fontWeight: 500,
    cursor: "pointer",
  },
  successBanner: {
    background: "rgba(0, 196, 140, 0.12)",
    border: `1px solid ${COLORS.accent}`,
    color: COLORS.accent,
    borderRadius: "10px",
    padding: "12px 16px",
    fontSize: "14px",
    margin: "16px 0 4px",
  },
  errorBanner: {
    background: "rgba(255, 90, 90, 0.12)",
    border: "1px solid #ff5a5a",
    color: "#ff8a8a",
    borderRadius: "10px",
    padding: "12px 16px",
    fontSize: "14px",
    margin: "16px 0 4px",
  },
  limitBanner: {
    background: "rgba(255, 165, 0, 0.1)",
    border: "1px solid #f0a500",
    color: "#f0c040",
    borderRadius: "10px",
    padding: "12px 16px",
    fontSize: "14px",
    marginBottom: "20px",
    lineHeight: 1.5,
  },
  limitBannerLink: {
    color: "#f0c040",
    fontWeight: 600,
    textDecoration: "underline",
  },
  planRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
  },
  planLabel: {
    fontSize: "12px",
    fontWeight: 500,
    color: COLORS.muted,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: "4px",
  },
  planName: {
    fontSize: "20px",
    fontWeight: 700,
    color: COLORS.text,
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginBottom: "10px",
  },
  paidBadge: {
    fontSize: "11px",
    fontWeight: 600,
    background: "rgba(0, 196, 140, 0.15)",
    color: COLORS.accent,
    border: `1px solid ${COLORS.accent}`,
    borderRadius: "6px",
    padding: "2px 8px",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  planUsage: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    maxWidth: "240px",
  },
  usageBar: {
    height: "4px",
    background: COLORS.border,
    borderRadius: "2px",
    overflow: "hidden",
  },
  usageFill: {
    height: "100%",
    borderRadius: "2px",
    transition: "width 0.3s ease",
  },
  usageText: {
    fontSize: "12px",
    color: COLORS.muted,
  },
  managePlanButton: {
    display: "inline-block",
    background: "transparent",
    color: COLORS.text,
    border: `1px solid ${COLORS.border}`,
    borderRadius: "10px",
    padding: "10px 18px",
    fontSize: "13px",
    fontWeight: 500,
    cursor: "pointer",
    textDecoration: "none",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  footer: {
    marginTop: "24px",
    fontSize: "13px",
    color: COLORS.muted,
    textAlign: "center",
  },
  footerShop: {
    color: COLORS.text,
  },
  footerLink: {
    color: COLORS.muted,
    textDecoration: "underline",
  },
};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
