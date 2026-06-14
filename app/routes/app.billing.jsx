import { useEffect, useState } from "react";
import { useLoaderData, useActionData, useNavigation, Form, redirect, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { PLANS } from "../plans";
import {
  getOrCreateSubscription,
  createShopifySubscription,
  cancelExistingSubscription,
  activateSubscription,
} from "../billing.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const activated = url.searchParams.get("activated");

  const subscription = await getOrCreateSubscription(shop);

  // Callback after Shopify billing approval
  if (activated && PLANS[activated]) {
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
    const activeSubs = data?.currentAppInstallation?.activeSubscriptions || [];
    const plan = PLANS[activated];
    const match = activeSubs.find(
      (s) => s.name === plan.shopifyPlanName && s.status === "ACTIVE"
    );

    if (match) {
      const isDowngrade = subscription.planName.startsWith("growth") && activated.startsWith("starter");
      let removedListNames = null;

      if (isDowngrade) {
        const { handleDowngradeToListLimit } = await import("../clickup.server");
        removedListNames = await handleDowngradeToListLimit(shop);
      }

      await activateSubscription(shop, activated, match.id);

      const query = removedListNames
        ? `&removed_lists=${encodeURIComponent(removedListNames)}`
        : "";
      return redirect(`/app?billing_success=1${query}`);
    }
  }

  return { subscription };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");
  const planKey = formData.get("plan");

  if (intent === "upgrade" && planKey && PLANS[planKey]) {
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

export default function BillingPage() {
  const { subscription } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [billingInterval, setBillingInterval] = useState(
    subscription.planName.endsWith("_annual") ? "annual" : "monthly"
  );

  useEffect(() => {
    if (actionData?.confirmationUrl) {
      window.top.location.href = actionData.confirmationUrl;
    }
  }, [actionData?.confirmationUrl]);

  const currentPlanKey = subscription?.planName || "trial";

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <style>{`
          @media (max-width: 600px) {
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
            border: 1px solid ${COLORS.border};
            color: ${COLORS.muted};
            padding: 8px 16px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            font-size: 13px;
            transition: all 0.2s ease;
          }
          .su-toggle-btn.active {
            background: ${COLORS.accent};
            color: #03251c;
            border-color: ${COLORS.accent};
          }
        `}</style>

        <header style={styles.header}>
          <Link to="/app" style={styles.backLink}>
            ← Back to Settings
          </Link>
          <h1 style={styles.title}>Choose a subscription plan</h1>
          <p style={styles.subtitle}>
            Activate a paid subscription to automate order sync workflows. Test mode is enabled for all charges.
          </p>
        </header>

        {actionData?.error && (
          <div style={styles.errorBanner}>{actionData.error}</div>
        )}

        {actionData?.confirmationUrl && (
          <div style={styles.infoBanner}>
            Redirecting to Shopify billing approval page…
          </div>
        )}

        <div className="su-toggle-container">
          <button
            type="button"
            className={`su-toggle-btn ${billingInterval === "monthly" ? "active" : ""}`}
            onClick={() => setBillingInterval("monthly")}
          >
            Monthly billing
          </button>
          <button
            type="button"
            className={`su-toggle-btn ${billingInterval === "annual" ? "active" : ""}`}
            onClick={() => setBillingInterval("annual")}
          >
            Annual billing (Save ~30%)
          </button>
        </div>

        <div className="su-pricing-grid">
          {/* Starter Card */}
          {(() => {
            const planKey = billingInterval === "monthly" ? "starter_monthly" : "starter_annual";
            const plan = PLANS[planKey];
            const isCurrent = currentPlanKey === planKey;

            return (
              <div style={{ ...styles.pricingCard, ...(isCurrent ? styles.currentCard : {}) }}>
                <div style={styles.pricingHeader}>
                  <h3 style={styles.pricingTitle}>{plan.name}</h3>
                  <div style={styles.pricingPrice}>
                    {billingInterval === "monthly" ? (
                      <>
                        <span style={styles.priceAmount}>$29.99</span>
                        <span style={styles.priceInterval}>/mo</span>
                      </>
                    ) : (
                      <>
                        <span style={styles.priceAmount}>$239</span>
                        <span style={styles.priceInterval}>/yr</span>
                        <div style={styles.priceSubtext}>Equivalent to $19.92/mo</div>
                      </>
                    )}
                  </div>
                </div>
                <ul style={styles.pricingFeatures}>
                  {plan.features.map((feat) => (
                    <li key={feat}>✓ {feat}</li>
                  ))}
                </ul>
                <div style={styles.planAction}>
                  {isCurrent ? (
                    <div style={styles.currentLabel}>Active plan</div>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="intent" value="upgrade" />
                      <input type="hidden" name="plan" value={planKey} />
                      <button
                        type="submit"
                        style={styles.pricingButton}
                        disabled={isSubmitting}
                      >
                        {isSubmitting ? "Please wait…" : `Select ${plan.name}`}
                      </button>
                    </Form>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Growth Card */}
          {(() => {
            const planKey = billingInterval === "monthly" ? "growth_monthly" : "growth_annual";
            const plan = PLANS[planKey];
            const isCurrent = currentPlanKey === planKey;

            return (
              <div
                style={{
                  ...styles.pricingCard,
                  ...styles.pricingCardHighlighted,
                  ...(isCurrent ? styles.currentCard : {}),
                }}
              >
                <div style={styles.popularBadge}>Most popular</div>
                <div style={styles.pricingHeader}>
                  <h3 style={styles.pricingTitle}>{plan.name}</h3>
                  <div style={styles.pricingPrice}>
                    {billingInterval === "monthly" ? (
                      <>
                        <span style={styles.priceAmount}>$49.99</span>
                        <span style={styles.priceInterval}>/mo</span>
                      </>
                    ) : (
                      <>
                        <span style={styles.priceAmount}>$419</span>
                        <span style={styles.priceInterval}>/yr</span>
                        <div style={styles.priceSubtext}>Equivalent to $34.92/mo</div>
                      </>
                    )}
                  </div>
                </div>
                <ul style={styles.pricingFeatures}>
                  {plan.features.map((feat) => (
                    <li key={feat}>✓ {feat}</li>
                  ))}
                </ul>
                <div style={styles.planAction}>
                  {isCurrent ? (
                    <div style={styles.currentLabel}>Active plan</div>
                  ) : (
                    <Form method="post">
                      <input type="hidden" name="intent" value="upgrade" />
                      <input type="hidden" name="plan" value={planKey} />
                      <button
                        type="submit"
                        style={{ ...styles.pricingButton, ...styles.pricingButtonHighlighted }}
                        disabled={isSubmitting}
                      >
                        {isSubmitting ? "Please wait…" : `Select ${plan.name}`}
                      </button>
                    </Form>
                  )}
                </div>
              </div>
            );
          })()}
        </div>

        <p style={styles.note}>
          Billing is securely handled directly by Shopify. Subscriptions are billed in USD.
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
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding: "40px 20px",
    boxSizing: "border-box",
  },
  container: {
    maxWidth: "720px",
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
    lineHeight: 1.5,
  },
  errorBanner: {
    background: "rgba(255, 68, 68, 0.12)",
    border: "1px solid #ff4444",
    color: "#ff4444",
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

  // Pricing Card Layout Styles
  pricingCard: {
    background: COLORS.surface,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 16,
    padding: 28,
    display: "flex",
    flexDirection: "column",
    gap: 20,
    position: "relative",
  },
  pricingCardHighlighted: {
    borderColor: "#3a3a5a",
    background: "#1e1e2e",
  },
  currentCard: {
    borderColor: COLORS.accent,
    boxShadow: `0 0 0 1px ${COLORS.accent}22`,
  },
  popularBadge: {
    position: "absolute",
    top: -12,
    left: "50%",
    transform: "translateX(-50%)",
    background: COLORS.accent,
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
  pricingTitle: { margin: 0, fontSize: 18, fontWeight: 700, color: COLORS.text },
  pricingPrice: { display: "flex", alignItems: "baseline", flexWrap: "wrap" },
  priceAmount: { fontSize: 32, fontWeight: 800, color: COLORS.text },
  priceInterval: { fontSize: 16, color: COLORS.muted, marginLeft: 2 },
  priceSubtext: { fontSize: 12, color: COLORS.muted, width: "100%", marginTop: 4 },
  pricingFeatures: {
    listStyle: "none",
    padding: 0,
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    fontSize: 13,
    color: COLORS.muted,
    flex: 1,
  },
  planAction: {
    marginTop: "auto",
  },
  currentLabel: {
    fontSize: 13,
    color: COLORS.accent,
    fontWeight: 600,
    textAlign: "center",
    padding: "10px 0",
  },
  pricingButton: {
    width: "100%",
    background: "transparent",
    color: COLORS.text,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    textAlign: "center",
    boxSizing: "border-box",
  },
  pricingButtonHighlighted: {
    background: COLORS.accent,
    color: "#03251c",
    borderColor: COLORS.accent,
  },
};

export const headers = (headersArgs) => boundary.headers(headersArgs);
