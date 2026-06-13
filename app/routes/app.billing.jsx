import { useEffect } from "react";
import {
  useLoaderData,
  useActionData,
  useNavigation,
  Form,
  redirect,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  PLANS,
  getOrCreateSubscription,
  createShopifySubscription,
  cancelExistingSubscription,
  activateSubscription,
  downgradeToFree,
} from "../billing.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const activated = url.searchParams.get("activated");

  // Callback after Shopify billing approval
  if (activated && PLANS[activated] && activated !== "free") {
    const res = await admin.graphql(`#graphql
      {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
          }
        }
      }
    `);
    const { data } = await res.json();
    const activeSubs =
      data?.currentAppInstallation?.activeSubscriptions || [];
    const plan = PLANS[activated];
    const match = activeSubs.find(
      (s) => s.name === plan.shopifyPlanName && s.status === "ACTIVE"
    );

    if (match) {
      await activateSubscription(shop, activated, match.id);
    }

    return redirect("/app?billing_success=1");
  }

  const subscription = await getOrCreateSubscription(shop);
  return { subscription };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");
  const planKey = formData.get("plan");

  if (intent === "upgrade" && planKey && PLANS[planKey] && planKey !== "free") {
    const subscription = await getOrCreateSubscription(shop);
    if (subscription.shopifyChargeId) {
      await cancelExistingSubscription(admin, subscription.shopifyChargeId);
    }
    try {
      const { confirmationUrl } = await createShopifySubscription(
        admin,
        shop,
        planKey
      );
      return { confirmationUrl };
    } catch (err) {
      return { error: err.message };
    }
  }

  if (intent === "downgrade") {
    const subscription = await getOrCreateSubscription(shop);
    if (subscription.shopifyChargeId) {
      await cancelExistingSubscription(admin, subscription.shopifyChargeId);
    }
    await downgradeToFree(shop);
    return redirect("/app?billing_success=1");
  }

  return { error: "Unknown action." };
};

const COLORS = {
  bg: "#0f0f0f",
  surface: "#1a1a1a",
  border: "#2a2a2a",
  text: "#ffffff",
  muted: "#9a9a9a",
  accent: "#00c48c",
};

const CHECK = "✓";

export default function BillingPage() {
  const { subscription } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // Top-level redirect to Shopify billing approval page
  useEffect(() => {
    if (actionData?.confirmationUrl) {
      window.top.location.href = actionData.confirmationUrl;
    }
  }, [actionData?.confirmationUrl]);

  const currentPlanKey = subscription?.planName || "free";

  const planOrder = ["free", "starter", "growth"];

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <header style={styles.header}>
          <a href="/app" target="_top" style={styles.backLink}>
            ← Back
          </a>
          <h1 style={styles.title}>Choose a plan</h1>
          <p style={styles.subtitle}>
            Upgrade anytime. Cancel anytime. All prices in USD.
          </p>
        </header>

        {actionData?.error && (
          <div style={styles.errorBanner}>{actionData.error}</div>
        )}

        {actionData?.confirmationUrl && (
          <div style={styles.infoBanner}>
            Redirecting to Shopify billing approval…
          </div>
        )}

        <div style={styles.plansGrid}>
          {planOrder.map((key) => {
            const plan = PLANS[key];
            const isCurrent = key === currentPlanKey;
            const isHighlighted = key === "starter";

            return (
              <div
                key={key}
                style={{
                  ...styles.planCard,
                  ...(isCurrent ? styles.currentCard : {}),
                  ...(isHighlighted && !isCurrent ? styles.highlightCard : {}),
                }}
              >
                {isHighlighted && (
                  <div style={styles.popularBadge}>Most popular</div>
                )}

                <div style={styles.planHeader}>
                  <div style={styles.planName}>{plan.name}</div>
                  <div style={styles.planPrice}>
                    {plan.price === 0 ? (
                      <span>Free</span>
                    ) : (
                      <>
                        <span style={styles.priceAmount}>${plan.price}</span>
                        <span style={styles.priceInterval}>/mo</span>
                      </>
                    )}
                  </div>
                  <div style={styles.planLimit}>
                    {plan.monthlyOrderLimit === null
                      ? "Unlimited orders/month"
                      : `Up to ${plan.monthlyOrderLimit} orders/month`}
                  </div>
                </div>

                <ul style={styles.featureList}>
                  {plan.features.map((f) => (
                    <li key={f} style={styles.featureItem}>
                      <span style={styles.checkmark}>{CHECK}</span>
                      {f}
                    </li>
                  ))}
                </ul>

                <div style={styles.planAction}>
                  {isCurrent ? (
                    <div style={styles.currentLabel}>Current plan</div>
                  ) : key === "free" ? (
                    <Form method="post">
                      <input type="hidden" name="intent" value="downgrade" />
                      <button
                        type="submit"
                        style={styles.ghostButton}
                        disabled={isSubmitting}
                      >
                        Downgrade to Free
                      </button>
                    </Form>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="intent" value="upgrade" />
                      <input type="hidden" name="plan" value={key} />
                      <button
                        type="submit"
                        style={
                          isHighlighted ? styles.primaryButton : styles.outlineButton
                        }
                        disabled={isSubmitting}
                      >
                        {isSubmitting ? "Please wait…" : `Upgrade to ${plan.name}`}
                      </button>
                    </Form>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <p style={styles.note}>
          Billing is handled securely by Shopify. Test mode is active — no real
          charges will be made.
        </p>
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
    maxWidth: "860px",
    margin: "0 auto",
  },
  header: {
    marginBottom: "36px",
  },
  backLink: {
    fontSize: "13px",
    color: COLORS.muted,
    textDecoration: "none",
    display: "inline-block",
    marginBottom: "16px",
  },
  title: {
    margin: "0 0 8px",
    fontSize: "28px",
    fontWeight: 700,
    color: COLORS.text,
  },
  subtitle: {
    margin: 0,
    fontSize: "14px",
    color: COLORS.muted,
  },
  plansGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: "20px",
    alignItems: "start",
  },
  planCard: {
    background: COLORS.surface,
    border: `1px solid ${COLORS.border}`,
    borderRadius: "16px",
    padding: "28px",
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: "20px",
  },
  currentCard: {
    border: `1px solid ${COLORS.accent}`,
    boxShadow: `0 0 0 1px ${COLORS.accent}22`,
  },
  highlightCard: {
    border: `1px solid #3a3a5a`,
    background: "#1e1e2e",
  },
  popularBadge: {
    position: "absolute",
    top: "-12px",
    left: "50%",
    transform: "translateX(-50%)",
    background: COLORS.accent,
    color: "#03251c",
    fontSize: "11px",
    fontWeight: 700,
    padding: "3px 12px",
    borderRadius: "12px",
    whiteSpace: "nowrap",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  planHeader: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  planName: {
    fontSize: "16px",
    fontWeight: 600,
    color: COLORS.text,
    marginBottom: "4px",
  },
  planPrice: {
    fontSize: "32px",
    fontWeight: 800,
    color: COLORS.text,
    lineHeight: 1,
  },
  priceAmount: {},
  priceInterval: {
    fontSize: "16px",
    fontWeight: 400,
    color: COLORS.muted,
    marginLeft: "2px",
  },
  planLimit: {
    fontSize: "13px",
    color: COLORS.muted,
    marginTop: "6px",
  },
  featureList: {
    listStyle: "none",
    padding: 0,
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    flex: 1,
  },
  featureItem: {
    fontSize: "14px",
    color: COLORS.muted,
    display: "flex",
    alignItems: "flex-start",
    gap: "8px",
    lineHeight: 1.4,
  },
  checkmark: {
    color: COLORS.accent,
    fontWeight: 700,
    flexShrink: 0,
    marginTop: "1px",
  },
  planAction: {
    marginTop: "auto",
  },
  currentLabel: {
    fontSize: "13px",
    color: COLORS.accent,
    fontWeight: 600,
    textAlign: "center",
    padding: "10px 0",
  },
  primaryButton: {
    display: "block",
    width: "100%",
    background: COLORS.accent,
    color: "#03251c",
    border: "none",
    borderRadius: "10px",
    padding: "12px 20px",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    textAlign: "center",
    boxSizing: "border-box",
  },
  outlineButton: {
    display: "block",
    width: "100%",
    background: "transparent",
    color: COLORS.text,
    border: `1px solid ${COLORS.border}`,
    borderRadius: "10px",
    padding: "12px 20px",
    fontSize: "14px",
    fontWeight: 500,
    cursor: "pointer",
    textAlign: "center",
    boxSizing: "border-box",
  },
  ghostButton: {
    display: "block",
    width: "100%",
    background: "transparent",
    color: COLORS.muted,
    border: `1px solid ${COLORS.border}`,
    borderRadius: "10px",
    padding: "12px 20px",
    fontSize: "13px",
    fontWeight: 500,
    cursor: "pointer",
    textAlign: "center",
    boxSizing: "border-box",
  },
  errorBanner: {
    background: "rgba(255, 90, 90, 0.12)",
    border: "1px solid #ff5a5a",
    color: "#ff8a8a",
    borderRadius: "10px",
    padding: "12px 16px",
    fontSize: "14px",
    marginBottom: "24px",
  },
  infoBanner: {
    background: "rgba(0, 196, 140, 0.12)",
    border: `1px solid ${COLORS.accent}`,
    color: COLORS.accent,
    borderRadius: "10px",
    padding: "12px 16px",
    fontSize: "14px",
    marginBottom: "24px",
  },
  note: {
    marginTop: "32px",
    fontSize: "12px",
    color: COLORS.muted,
    textAlign: "center",
  },
};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
