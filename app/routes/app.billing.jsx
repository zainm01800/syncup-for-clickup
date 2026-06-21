import { useEffect, useState } from "react";
import { useLoaderData, useActionData, useNavigation, Form, redirect, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { PLANS, getTranslatedFeatures } from "../plans";
import prisma from "../db.server";
import {
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
  const chargeId = url.searchParams.get("charge_id");
  const replacementBehavior = url.searchParams.get("replacement_behavior");

  const subscription = await getOrCreateSubscription(shop);

  // Callback after Shopify billing approval
  if (activated && PLANS[activated]) {
    let match = null;

    if (chargeId) {
      const fullId = chargeId.startsWith("gid://") 
        ? chargeId 
        : `gid://shopify/AppSubscription/${chargeId}`;
      try {
        const res = await admin.graphql(`#graphql
          query GetSub($id: ID!) {
            node(id: $id) {
              ... on AppSubscription {
                id
                name
                status
              }
            }
          }
        `, {
          variables: { id: fullId }
        });
        const { data } = await res.json();
        const node = data?.node;
        if (node && (node.status === "ACTIVE" || node.status === "PENDING" || node.status === "ACCEPTED")) {
          match = node;
        }
      } catch (err) {
        console.error("Failed to query subscription by charge ID:", err);
      }
    }

    // Fallback if chargeId query did not find it (e.g. status isn't matched or API error)
    if (!match) {
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
      match = activeSubs.find(
        (s) => s.name === plan.shopifyPlanName && s.status === "ACTIVE"
      );
    }

    if (match) {
      const plan = PLANS[activated];
      // Check if they are in the grace period of a cancelled paid plan
      const durationDays = subscription.annualBilling ? 365 : 30;
      const cycleStart = subscription.billingCycleStart || subscription.createdAt;
      const expirationDate = new Date(new Date(cycleStart).getTime() + durationDays * 24 * 60 * 60 * 1000);
      const inGracePeriod = subscription.shopifyChargeStatus === "cancelled" && 
                            subscription.planName !== "free" && 
                            subscription.planName !== "trial" && 
                            new Date() <= expirationDate;

      if (inGracePeriod || replacementBehavior === "APPLY_ON_NEXT_BILLING_CYCLE") {
        await prisma.subscription.update({
          where: { shopDomain: shop },
          data: {
            pendingPlanName: activated,
            pendingShopifyChargeId: match.id,
          },
        });
        return redirect(`/app/billing?billing_success=1&scheduled=1&scheduled_plan=${encodeURIComponent(plan.name)}`);
      }

      const getLimitForPlan = (planName) => {
        if (planName === "trial") return 5;
        const p = PLANS[planName];
        return p ? p.listLimit : 1;
      };
      const currentLimit = getLimitForPlan(subscription.planName);
      const newLimit = getLimitForPlan(activated);

      let removedListNames = null;
      if (newLimit < currentLimit) {
        const { handleDowngradeToListLimit } = await import("../clickup.server");
        removedListNames = await handleDowngradeToListLimit(shop, newLimit);
      }

      await activateSubscription(shop, activated, match.id);

      const query = removedListNames
        ? `&removed_lists=${encodeURIComponent(removedListNames)}`
        : "";
      return redirect(`/app?billing_success=1${query}`);
    }
  }

  const { getConnection } = await import("../clickup.server");
  const connection = await getConnection(shop);
  const selectedPlatform = url.searchParams.get("platform") || connection?.selectedPlatform || "clickup";

  // Count currently-connected lists so we can warn the merchant before a
  // downgrade/cancellation would disconnect any of them (each plan has a listLimit).
  const connectedListCount = connection
    ? await prisma.syncTarget.count({ where: { connectionId: connection.id, isActive: true } })
    : 0;

  const activePaidCount = await prisma.subscription.count({
    where: {
      planName: {
        notIn: ["trial", "free", "expired", "cancelled"],
      },
      shopDomain: {
        not: "syncup-test-store.myshopify.com",
      },
    },
  });

  const isTestModeActive = process.env.SHOPIFY_BILLING_TEST === "true";

  // Calculate expiry date if subscription is cancelled
  let expiryDate = null;
  if (subscription.shopifyChargeStatus === "cancelled" && subscription.planName !== "free" && subscription.planName !== "trial") {
    const durationDays = subscription.annualBilling ? 365 : 30;
    const cycleStart = subscription.billingCycleStart || subscription.createdAt;
    const expirationDate = new Date(new Date(cycleStart).getTime() + durationDays * 24 * 60 * 60 * 1000);
    expiryDate = expirationDate.toISOString();
  }

  // Expose scheduled start date
  let scheduledStartDate = null;
  if (subscription.pendingPlanName) {
    const durationDays = subscription.annualBilling ? 365 : 30;
    const cycleStart = subscription.billingCycleStart || subscription.createdAt;
    const nextBillingDate = new Date(new Date(cycleStart).getTime() + durationDays * 24 * 60 * 60 * 1000);
    scheduledStartDate = nextBillingDate.toISOString();
  }

  const scheduled = url.searchParams.get("scheduled") === "1";
  const scheduledPlan = url.searchParams.get("scheduled_plan") || null;

  return { subscription, selectedPlatform, activePaidCount, isTestModeActive, expiryDate, scheduled, scheduledPlan, scheduledStartDate, connectedListCount };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");
  const planKey = formData.get("plan");

  if (intent === "cancel") {
    const subscription = await getOrCreateSubscription(shop);
    if (subscription.shopifyChargeId) {
      await cancelExistingSubscription(admin, subscription.shopifyChargeId);
    }
    await prisma.subscription.update({
      where: { shopDomain: shop },
      data: { shopifyChargeStatus: "cancelled" },
    });
    // Log activity
    await prisma.activityLog.create({
      data: {
        shopDomain: shop,
        eventType: "plan_cancellation_scheduled",
        description: "Subscription cancellation scheduled; active until billing cycle ends",
      },
    }).catch(e => console.error("Failed to log activity:", e));

    return redirect("/app/billing?billing_success=1");
  }

  if (intent === "cancel_scheduled") {
    const subscription = await getOrCreateSubscription(shop);
    if (subscription.pendingShopifyChargeId) {
      try {
        await cancelExistingSubscription(admin, subscription.pendingShopifyChargeId);
      } catch (e) {
        console.error("Failed to cancel pending subscription on Shopify:", e);
      }
    }
    await prisma.subscription.update({
      where: { shopDomain: shop },
      data: {
        pendingPlanName: null,
        pendingShopifyChargeId: null,
      },
    });
    // Log activity
    await prisma.activityLog.create({
      data: {
        shopDomain: shop,
        eventType: "plan_upgrade_cancelled",
        description: "Scheduled plan upgrade was cancelled",
      },
    }).catch(e => console.error("Failed to log activity:", e));

    return redirect("/app/billing?billing_success=1");
  }

  if (intent === "upgrade" && planKey) {
    const subscription = await getOrCreateSubscription(shop);
    let replacementBehavior = formData.get("replacement_behavior") || "APPLY_IMMEDIATELY";

    // If the subscription is cancelled (in grace period), force scheduling it to avoid charging immediately
    if (subscription.shopifyChargeStatus === "cancelled" && planKey !== "free") {
      replacementBehavior = "APPLY_ON_NEXT_BILLING_CYCLE";
    }

    if (planKey === "free") {
      if (subscription.shopifyChargeId) {
        await cancelExistingSubscription(admin, subscription.shopifyChargeId);
      }
      await downgradeToFree(shop);
      return redirect("/app?billing_success=1");
    } else if (PLANS[planKey]) {
      // DO NOT cancel the old subscription for paid plan upgrades/downgrades.
      // Shopify handles this automatically, supporting proration and scheduling.
      try {
        // For deferred upgrades: pre-set pendingPlanName in the DB NOW (before
        // the merchant approves on Shopify). This allows the subscriptions_update
        // webhook to correctly identify the incoming ACTIVE event as a scheduled
        // upgrade rather than an immediate switch, and leave planName unchanged.
        if (replacementBehavior === "APPLY_ON_NEXT_BILLING_CYCLE") {
          await prisma.subscription.updateMany({
            where: { shopDomain: shop },
            data: { pendingPlanName: planKey },
          });
        }

        const { confirmationUrl } = await createShopifySubscription(
          admin,
          shop,
          planKey,
          replacementBehavior
        );
        return { confirmationUrl };
      } catch (err) {
        // Roll back the pending plan if subscription creation failed
        if (replacementBehavior === "APPLY_ON_NEXT_BILLING_CYCLE") {
          await prisma.subscription.updateMany({
            where: { shopDomain: shop },
            data: { pendingPlanName: null },
          }).catch(() => {});
        }
        return { error: err.message };
      }
    }
  }

  return { error: "Unknown action." };
};

const C = {
  bg: "#0f0f0f",
  surface: "#1a1a1a",
  border: "#2a2a2a",
  text: "#ffffff",
  muted: "#9a9a9a",
  accent: "#00c48c",
};

export default function BillingPage() {
  const { subscription, selectedPlatform, activePaidCount = 0, isTestModeActive, expiryDate, scheduled, scheduledPlan, scheduledStartDate, connectedListCount = 0 } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [billingInterval, setBillingInterval] = useState(
    subscription.planName.endsWith("_annual") ? "annual" : "monthly"
  );
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [activeConfirmPlanKey, setActiveConfirmPlanKey] = useState(null);
  const [upgradeTiming, setUpgradeTiming] = useState("APPLY_IMMEDIATELY");

  useEffect(() => {
    if (actionData?.confirmationUrl) {
      window.top.location.href = actionData.confirmationUrl;
    }
  }, [actionData?.confirmationUrl]);

  useEffect(() => {
    setUpgradeTiming("APPLY_IMMEDIATELY");
  }, [activeConfirmPlanKey]);

  const currentPlanKey = subscription?.planName || "trial";

  const planSpecs = {
    free: {
      key: "free",
      badge: null,
      priceDesc: "Free forever",
      annualPriceDesc: "Free forever",
      billedDesc: "Billed monthly",
      monthlyEquivalent: "0",
    },
    starter: {
      key: "starter",
      badge: "Lite Syncing",
      priceDesc: "$9.99/mo",
      annualPriceDesc: "$8.25/mo",
      billedDesc: "Billed annually as $99",
      monthlyEquivalent: "8.25",
      regMonthly: "$14.99",
      regAnnual: "$149",
    },
    standard: {
      key: "standard",
      badge: "Best for Starters",
      priceDesc: "$19.99/mo",
      annualPriceDesc: "$17.92/mo",
      billedDesc: "Billed annually as $215",
      monthlyEquivalent: "17.92",
      regMonthly: "$29.99",
      regAnnual: "$323",
    },
    growth: {
      key: "growth",
      badge: "Most Popular",
      priceDesc: "$39.99/mo",
      annualPriceDesc: "$35.92/mo",
      billedDesc: "Billed annually as $431",
      monthlyEquivalent: "35.92",
      regMonthly: "$49.99",
      regAnnual: "$539",
    },
    pro: {
      key: "pro",
      badge: "Concierge Setup Included",
      priceDesc: "$79.99/mo",
      annualPriceDesc: "$71.92/mo",
      billedDesc: "Billed annually as $863",
      monthlyEquivalent: "71.92",
      regMonthly: "$99.99",
      regAnnual: "$1079",
    },
  };

  const getCardStyle = (isHighlighted, isCurrent) => {
    let border = `1px solid ${C.border}`;
    let ring = "none";
    let shadow = "none";
    let background = "rgba(26, 26, 26, 0.4)";
    
    if (isHighlighted) {
      border = "1px solid rgba(0, 196, 140, 0.4)";
      shadow = "0 10px 15px -3px rgba(0, 196, 140, 0.05), 0 4px 6px -2px rgba(0, 196, 140, 0.05)";
      background = "rgba(26, 26, 26, 0.6)";
    }
    if (isCurrent) {
      border = `1px solid ${C.accent}`;
      ring = `0 0 0 1px rgba(0, 196, 140, 0.3)`;
    }

    return {
      background,
      border,
      boxShadow: ring !== "none" ? ring : shadow,
      borderRadius: 16,
      padding: 24,
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      position: "relative",
      backdropFilter: "blur(8px)",
      boxSizing: "border-box",
      transition: "border-color 0.3s ease, transform 0.3s ease",
    };
  };

  const getButtonStyle = (isHighlighted) => {
    if (isHighlighted) {
      return {
        width: "100%",
        padding: "12px 0",
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 800,
        backgroundColor: C.accent,
        color: "#03251c",
        border: "none",
        cursor: "pointer",
        transition: "background-color 0.2s ease, transform 0.2s ease",
        boxSizing: "border-box",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      };
    } else {
      return {
        width: "100%",
        padding: "12px 0",
        borderRadius: 12,
        fontSize: 12,
        fontWeight: "bold",
        backgroundColor: C.surface,
        color: C.text,
        border: `1px solid ${C.border}`,
        cursor: "pointer",
        transition: "background-color 0.2s ease, border-color 0.2s ease, transform 0.2s ease",
        boxSizing: "border-box",
      };
    }
  };

  const isPromoActive = activePaidCount < 10;
  // A merchant who subscribed during the launch promo is grandfathered: they keep
  // seeing promo prices even after the global 10-slot pool fills, so the price on
  // this page always matches what Shopify is actually charging them.
  const userSeesPromo = isPromoActive || subscription?.isPromoLocked === true;
  const spotsRemaining = Math.max(0, 10 - activePaidCount);

  return (
    <div style={{
      minHeight: "100vh",
      background: C.bg,
      color: C.text,
      padding: "48px 16px",
      fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      boxSizing: "border-box"
    }}>
      <div style={{
        maxWidth: 1200,
        margin: "0 auto",
      }}>
        
        {/* Navigation & Header */}
        <header style={{
          marginBottom: 40,
          maxWidth: 896,
          marginLeft: "auto",
          marginRight: "auto",
        }}>
          <Link
            to="/app"
            style={{
              fontSize: 12,
              color: C.muted,
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 24,
              transition: "color 0.2s ease",
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = C.text}
            onMouseLeave={(e) => e.currentTarget.style.color = C.muted}
          >
            &larr; Back to Settings
          </Link>
          <h1 style={{
            fontSize: "2rem",
            fontWeight: 800,
            color: C.text,
            letterSpacing: "-0.025em",
            margin: "0 0 12px 0",
          }}>
            Pricing Plans & Billing
          </h1>
          <p style={{
            fontSize: 14,
            color: C.muted,
            lineHeight: 1.6,
            margin: 0,
          }}>
            Select a plan to automate your order workflows. SyncUp uses Shopify secure billing, and all plan pricing is displayed in USD. {isTestModeActive && "Test mode is active. "}You can cancel or change your plan at any time.
          </p>
        </header>

        {/* Grandfathering / Urgency Banner */}
        {isPromoActive ? (
          <div style={{
            background: "rgba(0, 196, 140, 0.05)",
            border: `1px solid rgba(0, 196, 140, 0.2)`,
            color: C.accent,
            padding: 16,
            borderRadius: 12,
            fontSize: 13,
            display: "flex",
            alignItems: "start",
            gap: 12,
            marginBottom: 40,
            maxWidth: 896,
            marginLeft: "auto",
            marginRight: "auto",
            boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.1)",
            backdropFilter: "blur(8px)",
            boxSizing: "border-box"
          }}>
            <span style={{ fontSize: 20, lineHeight: 1 }}>🚀</span>
            <div>
              <strong style={{
                fontWeight: 600,
                display: "block",
                marginBottom: 2,
                color: C.text,
              }}>LAUNCH SPECIAL OFFER</strong>
              Install today to lock in these discounted B2B rates forever. <strong style={{ color: C.text }}>Only {spotsRemaining} slots remaining!</strong> Once our beta ends, pricing will increase for new installs. Existing merchants will remain grandfathered on these plans indefinitely!
            </div>
          </div>
        ) : (
          <div style={{
            background: "rgba(255, 255, 255, 0.03)",
            border: `1px solid ${C.border}`,
            color: C.muted,
            padding: 16,
            borderRadius: 12,
            fontSize: 13,
            display: "flex",
            alignItems: "start",
            gap: 12,
            marginBottom: 40,
            maxWidth: 896,
            marginLeft: "auto",
            marginRight: "auto",
            boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.05)",
            backdropFilter: "blur(8px)",
            boxSizing: "border-box"
          }}>
            <span style={{ fontSize: 20, lineHeight: 1 }}>💡</span>
            <div>
              <strong style={{
                fontWeight: 600,
                display: "block",
                marginBottom: 2,
                color: C.text,
              }}>PROMOTIONAL SLOTS CLAIMED</strong>
              All 10 beta launch promotional slots have been claimed! Standard rates are now active for new installs. Existing promotional subscribers remain grandfathered at their initial rates.
            </div>
          </div>
        )}

        {/* Action Notifications */}
        {scheduled && scheduledPlan && (
          <div style={{
            background: "rgba(0, 196, 140, 0.08)",
            border: `1px solid rgba(0, 196, 140, 0.2)`,
            color: C.accent,
            padding: 16,
            borderRadius: 12,
            fontSize: 14,
            marginBottom: 32,
            maxWidth: 896,
            marginLeft: "auto",
            marginRight: "auto",
            boxSizing: "border-box"
          }}>
            ✓ Your new plan <strong>{scheduledPlan}</strong> has been successfully scheduled and will activate once your current plan expires.
          </div>
        )}

        {subscription.pendingPlanName && (
          <div style={{
            background: "rgba(0, 196, 140, 0.05)",
            border: `1px solid rgba(0, 196, 140, 0.2)`,
            color: C.text,
            padding: 16,
            borderRadius: 12,
            fontSize: 14,
            marginBottom: 32,
            maxWidth: 896,
            marginLeft: "auto",
            marginRight: "auto",
            boxSizing: "border-box",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
          }}>
            <div>
              📅 You have a scheduled upgrade to <strong>{PLANS[subscription.pendingPlanName]?.name || subscription.pendingPlanName}</strong> starting on <strong>{scheduledStartDate ? new Date(scheduledStartDate).toLocaleDateString() : ""}</strong>.
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <Form method="post" style={{ margin: 0, padding: 0 }}>
                <input type="hidden" name="intent" value="cancel_scheduled" />
                <button
                  type="submit"
                  disabled={isSubmitting}
                  style={{
                    backgroundColor: "transparent",
                    color: "#ff4444",
                    border: "1px solid rgba(255, 68, 68, 0.3)",
                    padding: "6px 12px",
                    borderRadius: 8,
                    fontSize: 12,
                    fontWeight: "bold",
                    cursor: isSubmitting ? "not-allowed" : "pointer",
                  }}
                >
                  {isSubmitting ? "Cancelling..." : "Cancel Scheduled Upgrade"}
                </button>
              </Form>
              <Form method="post" style={{ margin: 0, padding: 0 }}>
                <input type="hidden" name="intent" value="upgrade" />
                <input type="hidden" name="plan" value={subscription.pendingPlanName} />
                <input type="hidden" name="replacement_behavior" value="APPLY_IMMEDIATELY" />
                <button
                  type="submit"
                  disabled={isSubmitting}
                  style={{
                    backgroundColor: C.accent,
                    color: "#03251c",
                    border: "none",
                    padding: "6px 12px",
                    borderRadius: 8,
                    fontSize: 12,
                    fontWeight: "bold",
                    cursor: isSubmitting ? "not-allowed" : "pointer",
                  }}
                >
                  {isSubmitting ? "Activating..." : "Activate Now"}
                </button>
              </Form>
            </div>
          </div>
        )}

        {actionData?.error && (
          <div style={{
            background: "rgba(255, 68, 68, 0.08)",
            border: "1px solid rgba(255, 68, 68, 0.2)",
            color: "#ff4444",
            padding: 16,
            borderRadius: 12,
            fontSize: 14,
            marginBottom: 32,
            maxWidth: 896,
            marginLeft: "auto",
            marginRight: "auto",
            boxSizing: "border-box"
          }}>
            ✕ {actionData.error}
          </div>
        )}

        {actionData?.confirmationUrl && (
          <div style={{
            background: "rgba(0, 196, 140, 0.08)",
            border: `1px solid rgba(0, 196, 140, 0.2)`,
            color: C.accent,
            padding: 16,
            borderRadius: 12,
            fontSize: 14,
            marginBottom: 32,
            maxWidth: 896,
            marginLeft: "auto",
            marginRight: "auto",
            boxSizing: "border-box"
          }}>
            ⚡ Redirecting to Shopify billing approval page…
          </div>
        )}

        {/* Monthly/Annual Toggle */}
        <div style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: 12,
          marginBottom: 48,
        }}>
          <span style={{
            fontSize: 12,
            fontWeight: 600,
            color: billingInterval === "monthly" ? C.text : C.muted,
            transition: "color 0.2s ease",
          }}>
            Monthly Billing
          </span>
          <button
            type="button"
            style={{
              position: "relative",
              display: "inline-flex",
              height: 24,
              width: 44,
              flexShrink: 0,
              cursor: "pointer",
              borderRadius: 9999,
              border: "2px solid transparent",
              backgroundColor: C.surface,
              transition: "background-color 0.2s ease",
              outline: "none",
              padding: 0,
            }}
            onClick={() => setBillingInterval(billingInterval === "monthly" ? "annual" : "monthly")}
            role="switch"
            aria-checked={billingInterval === "annual"}
          >
            <span
              aria-hidden="true"
              style={{
                pointerEvents: "none",
                display: "inline-block",
                height: 20,
                width: 20,
                borderRadius: 9999,
                backgroundColor: C.accent,
                boxShadow: "0 1px 3px rgba(0, 0, 0, 0.3)",
                transform: billingInterval === "annual" ? "translateX(20px)" : "translateX(0)",
                transition: "transform 0.2s ease-in-out",
              }}
            />
          </button>
          <span style={{
            fontSize: 12,
            fontWeight: 600,
            color: billingInterval === "annual" ? C.accent : C.muted,
            transition: "color 0.2s ease",
            display: "flex",
            alignItems: "center",
          }}>
            Annual Billing
            <span style={{
              backgroundColor: "rgba(0, 196, 140, 0.1)",
              color: C.accent,
              fontSize: 10,
              padding: "2px 8px",
              borderRadius: 9999,
              fontWeight: "bold",
              marginLeft: 6,
              border: `1px solid rgba(0, 196, 140, 0.2)`,
              display: "inline-block",
            }}>
              Save ~10%
            </span>
          </span>
        </div>

        {/* Current plan indicator — stays visible regardless of the monthly/annual toggle,
            so the merchant never loses sight of which plan they're on. */}
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <span style={{
            display: "inline-block",
            fontSize: 12,
            fontWeight: 600,
            color: C.accent,
            backgroundColor: "rgba(0, 196, 140, 0.08)",
            border: "1px solid rgba(0, 196, 140, 0.2)",
            padding: "6px 14px",
            borderRadius: 9999,
          }}>
            Your current plan: {PLANS[currentPlanKey]?.name || (currentPlanKey === "trial" ? "Free Trial" : "Free Plan")}
          </span>
        </div>

        {/* Pricing Grid */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 24,
          alignItems: "stretch",
        }}>
          {["starter", "standard", "growth", "pro"].map((key) => {
            const planKey = key === "free" ? "free" : `${key}_${billingInterval}`;
            const plan = PLANS[planKey];
            if (!plan) return null;

            const isCurrent = currentPlanKey === planKey;
            const isHighlighted = key === "growth";
            const spec = planSpecs[key];

            let displayPrice = "";
            let regularPrice = null;
            let billedInfo = null;

            if (key === "free") {
              displayPrice = "Free/mo";
            } else {
              if (billingInterval === "annual") {
                if (userSeesPromo) {
                  displayPrice = spec.annualPriceDesc;
                  regularPrice = `$${(parseFloat(spec.regAnnual.replace("$", "")) / 12).toFixed(2)}/mo`;
                  billedInfo = `${spec.billedDesc}`;
                } else {
                  displayPrice = `$${(parseFloat(spec.regAnnual.replace("$", "")) / 12).toFixed(2)}/mo`;
                  billedInfo = `Billed annually as ${spec.regAnnual}`;
                }
              } else {
                if (userSeesPromo) {
                  displayPrice = spec.priceDesc;
                  regularPrice = spec.regMonthly;
                } else {
                  displayPrice = spec.regMonthly;
                }
              }
            }

            const PLAN_LEVELS = {
              free: 0,
              trial: 0,
              starter_monthly: 1,
              starter_annual: 1,
              standard_monthly: 2,
              standard_annual: 2,
              growth_monthly: 3,
              growth_annual: 3,
              pro_monthly: 4,
              pro_annual: 4,
            };

            const currentLevel = PLAN_LEVELS[currentPlanKey] || 0;
            const targetLevel = PLAN_LEVELS[planKey] || 0;
            const isDowngradeOption = targetLevel < currentLevel;
            const isUpgradeOption = targetLevel > currentLevel;

            // Upgrade-cost hint shown on the card: the per-period difference between
            // this plan and the merchant's current plan at the displayed interval.
            const intervalTextCard = billingInterval === "annual" ? "yr" : "mo";
            const currentBase = (currentPlanKey || "").replace(/_(monthly|annual)$/, "");
            const currentAtInterval = PLANS[`${currentBase}_${billingInterval}`];
            const effPlanPrice = (p) =>
              p ? (userSeesPromo ? p.price : p.regularPrice || p.price) : 0;
            const upgradeDiff = effPlanPrice(plan) - effPlanPrice(currentAtInterval);
            const isUpgradeFromPaid =
              isUpgradeOption &&
              !!currentAtInterval &&
              upgradeDiff > 0 &&
              currentPlanKey !== "trial" &&
              currentPlanKey !== "free";

            return (
              <div
                key={key}
                style={getCardStyle(isHighlighted, isCurrent)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = "translateY(-4px)";
                  e.currentTarget.style.borderColor = isCurrent ? C.accent : isHighlighted ? "rgba(0, 196, 140, 0.6)" : "rgba(255, 255, 255, 0.15)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "translateY(0)";
                  e.currentTarget.style.borderColor = isCurrent ? C.accent : isHighlighted ? "rgba(0, 196, 140, 0.4)" : C.border;
                }}
              >
                {/* Visual Badges */}
                {isCurrent && (
                  <div style={{
                    position: "absolute",
                    top: 12,
                    right: 12,
                    backgroundColor: "rgba(0, 196, 140, 0.15)",
                    border: `1px solid rgba(0, 196, 140, 0.3)`,
                    color: C.accent,
                    fontSize: 9,
                    fontWeight: 900,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    padding: "2px 8px",
                    borderRadius: 9999,
                  }}>
                    Active
                  </div>
                )}
                {isHighlighted && (
                  <div style={{
                    position: "absolute",
                    top: -12,
                    left: "50%",
                    transform: "translateX(-50%)",
                    backgroundColor: C.accent,
                    color: "#03251c",
                    fontSize: 10,
                    fontWeight: 900,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    padding: "4px 14px",
                    borderRadius: 9999,
                    boxShadow: "0 10px 15px -3px rgba(0, 196, 140, 0.2)",
                    whiteSpace: "nowrap",
                  }}>
                    {spec.badge}
                  </div>
                )}

                {/* Card Top */}
                <div>
                  <div style={{ marginBottom: 16 }}>
                    <span style={{
                      color: C.muted,
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                      display: "block",
                      marginBottom: 4,
                    }}>
                      {key} tier
                    </span>
                    <h3 style={{
                      fontSize: 18,
                      fontWeight: 700,
                      color: C.text,
                      margin: 0,
                      letterSpacing: "-0.025em",
                    }}>{plan.name}</h3>
                  </div>

                  {/* Price */}
                  <div style={{ marginBottom: 24 }}>
                    <div style={{
                      display: "flex",
                      alignItems: "baseline",
                      flexWrap: "wrap",
                      gap: 6,
                    }}>
                      {key !== "free" && regularPrice && (
                        <span style={{
                          fontSize: 14,
                          color: C.muted,
                          textDecoration: "line-through",
                          marginRight: 4,
                          fontWeight: 500,
                        }}>
                          {regularPrice}
                        </span>
                      )}
                      <span style={{
                        fontSize: 30,
                        fontWeight: 800,
                        color: C.text,
                        letterSpacing: "-0.025em",
                      }}>
                        {key === "free" ? "$0" : displayPrice.split("/")[0]}
                      </span>
                      <span style={{
                        color: C.muted,
                        fontSize: 14,
                        fontWeight: 500,
                      }}>
                        /{key === "free" ? "mo" : displayPrice.split("/")[1]}
                      </span>
                    </div>

                    {/* Annual info */}
                    {billingInterval === "annual" && key !== "free" && billedInfo && (
                      <div style={{
                        fontSize: 11,
                        color: C.muted,
                        marginTop: 6,
                        fontWeight: 500,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}>
                        <span style={{
                          display: "inline-block",
                          width: 6,
                          height: 6,
                          borderRadius: 9999,
                          backgroundColor: C.accent,
                        }} />
                        {billedInfo}
                      </div>
                    )}
                  </div>

                  {/* Divider */}
                  <div style={{
                    height: 1,
                    backgroundColor: C.border,
                    marginBottom: 24,
                    border: "none",
                    marginTop: 16,
                  }} />

                  {/* Features */}
                  <ul style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                    marginBottom: 32,
                    padding: 0,
                    listStyle: "none",
                  }}>
                    {getTranslatedFeatures(plan.features, selectedPlatform).map((feat) => (
                      <li key={feat} style={{
                        display: "flex",
                        alignItems: "start",
                      }}>
                        <span style={{
                          color: C.accent,
                          marginRight: 8,
                          flexShrink: 0,
                          fontWeight: "bold",
                        }}>✓</span>
                        <span style={{
                          fontSize: 13,
                          color: "#d4d4d8",
                          lineHeight: 1.4,
                        }}>{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Card Action */}
                <div style={{ marginTop: "auto" }}>
                  {subscription.pendingPlanName === planKey ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
                      <div style={{
                        width: "100%",
                        textAlign: "center",
                        padding: "12px 0",
                        borderRadius: 12,
                        fontSize: 12,
                        fontWeight: "bold",
                        border: `1px solid rgba(0, 196, 140, 0.3)`,
                        color: C.accent,
                        backgroundColor: "rgba(0, 196, 140, 0.05)",
                        cursor: "default",
                        boxSizing: "border-box",
                        display: "block",
                      }}>
                        Scheduled (Starts {scheduledStartDate ? new Date(scheduledStartDate).toLocaleDateString() : (expiryDate ? new Date(expiryDate).toLocaleDateString() : "")})
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <Form method="post" style={{ margin: 0, padding: 0, flex: 1 }}>
                          <input type="hidden" name="intent" value="cancel_scheduled" />
                          <button
                            type="submit"
                            disabled={isSubmitting}
                            style={{
                              width: "100%",
                              padding: "8px 0",
                              borderRadius: 8,
                              fontSize: 10,
                              fontWeight: "bold",
                              backgroundColor: "transparent",
                              color: "#ff4444",
                              border: "1px solid rgba(255, 68, 68, 0.3)",
                              cursor: isSubmitting ? "not-allowed" : "pointer",
                              transition: "background-color 0.2s ease",
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "rgba(255, 68, 68, 0.05)"}
                            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                          >
                            Cancel
                          </button>
                        </Form>
                        <Form method="post" style={{ margin: 0, padding: 0, flex: 1 }}>
                          <input type="hidden" name="intent" value="upgrade" />
                          <input type="hidden" name="plan" value={planKey} />
                          <input type="hidden" name="replacement_behavior" value="APPLY_IMMEDIATELY" />
                          <button
                            type="submit"
                            disabled={isSubmitting}
                            style={{
                              width: "100%",
                              padding: "8px 0",
                              borderRadius: 8,
                              fontSize: 10,
                              fontWeight: "bold",
                              backgroundColor: C.accent,
                              color: "#03251c",
                              border: "none",
                              cursor: isSubmitting ? "not-allowed" : "pointer",
                              transition: "opacity 0.2s ease",
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.opacity = "0.9"}
                            onMouseLeave={(e) => e.currentTarget.style.opacity = "1"}
                          >
                            Start Now
                          </button>
                        </Form>
                      </div>
                    </div>
                  ) : isDowngradeOption && subscription.shopifyChargeStatus !== "cancelled" ? (
                    <div style={{
                      width: "100%",
                      textAlign: "center",
                      padding: "12px 0",
                      borderRadius: 12,
                      fontSize: 12,
                      fontWeight: "bold",
                      border: `1px dashed ${C.border}`,
                      color: C.muted,
                      backgroundColor: "rgba(255, 255, 255, 0.02)",
                      cursor: "not-allowed",
                      boxSizing: "border-box",
                    }}>
                      {key === "free" ? "Cancel your plan to move to Free" : `Downgrades aren't available mid-cycle. Cancel your plan, then choose ${plan.name.split(" ")[0]} after it expires.`}
                    </div>
                  ) : key === "free" && subscription.shopifyChargeStatus === "cancelled" ? (
                    <div style={{
                      width: "100%",
                      textAlign: "center",
                      padding: "12px 0",
                      borderRadius: 12,
                      fontSize: 12,
                      fontWeight: "bold",
                      border: `1px solid rgba(0, 196, 140, 0.1)`,
                      color: C.muted,
                      backgroundColor: "rgba(255, 255, 255, 0.01)",
                      cursor: "default",
                      boxSizing: "border-box",
                    }}>
                      Activates Automatically
                    </div>
                  ) : isCurrent ? (
                    subscription.shopifyChargeStatus === "cancelled" ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{
                          width: "100%",
                          textAlign: "center",
                          padding: "12px 0",
                          borderRadius: 12,
                          fontSize: 12,
                          fontWeight: "bold",
                          border: `1px solid rgba(255, 165, 0, 0.3)`,
                          color: "orange",
                          backgroundColor: "rgba(255, 165, 0, 0.05)",
                          cursor: "default",
                          boxSizing: "border-box",
                          display: "block",
                        }}>
                          Expires {expiryDate ? new Date(expiryDate).toLocaleDateString() : ""}
                        </div>
                        <Form method="post" style={{ margin: 0, padding: 0 }}>
                          <input type="hidden" name="intent" value="upgrade" />
                          <input type="hidden" name="plan" value={planKey} />
                          <button
                            type="submit"
                            style={getButtonStyle(true)}
                            disabled={isSubmitting}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.backgroundColor = "#34d399";
                              e.currentTarget.style.transform = "scale(1.02)";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.backgroundColor = C.accent;
                              e.currentTarget.style.transform = "scale(1)";
                            }}
                          >
                            {isSubmitting ? "Reconnecting..." : "Re-subscribe"}
                          </button>
                        </Form>
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{
                          width: "100%",
                          textAlign: "center",
                          padding: "12px 0",
                          borderRadius: 12,
                          fontSize: 12,
                          fontWeight: "bold",
                          border: `1px solid rgba(0, 196, 140, 0.2)`,
                          color: C.accent,
                          backgroundColor: "rgba(0, 196, 140, 0.05)",
                          cursor: "default",
                          boxSizing: "border-box",
                          display: "block",
                        }}>
                          Current Plan
                        </div>
                        {currentPlanKey !== "free" && currentPlanKey !== "trial" && (
                          showCancelConfirm ? (
                            <div style={{
                              marginTop: 8,
                              padding: 12,
                              borderRadius: 10,
                              backgroundColor: "rgba(255, 68, 68, 0.05)",
                              border: "1px solid rgba(255, 68, 68, 0.2)",
                              fontSize: 11,
                              lineHeight: 1.4,
                              boxSizing: "border-box",
                              textAlign: "left",
                            }}>
                              <div style={{ color: "#ff4444", fontWeight: "bold", marginBottom: 6 }}>
                                Stop future charges?
                              </div>
                              <p style={{ color: C.muted, margin: "0 0 12px 0", fontSize: 11 }}>
                                You will not be charged again. {plan.name.split(" ")[0]} features will remain active until the end of your billing cycle on{" "}
                                <strong>
                                  {(() => {
                                    const pDays = subscription.annualBilling ? 365 : 30;
                                    const cStart = subscription.billingCycleStart || subscription.createdAt;
                                    return new Date(new Date(cStart).getTime() + pDays * 24 * 60 * 60 * 1000).toLocaleDateString();
                                  })()}
                                </strong>.
                              </p>
                              {connectedListCount > 1 && (
                                <p style={{ color: "#ffb84d", margin: "0 0 12px 0", fontSize: 11, fontWeight: 600 }}>
                                  ⚠ Heads up: when your plan expires you'll move to the Free plan (1 list), so {connectedListCount - 1} of your {connectedListCount} connected lists will be disconnected.
                                </p>
                              )}
                              <div style={{ display: "flex", gap: 8 }}>
                                <Form method="post" style={{ margin: 0, padding: 0, flex: 1 }}>
                                  <input type="hidden" name="intent" value="cancel" />
                                  <button
                                    type="submit"
                                    disabled={isSubmitting}
                                    style={{
                                      width: "100%",
                                      padding: "8px 0",
                                      borderRadius: 8,
                                      fontSize: 10,
                                      fontWeight: "bold",
                                      backgroundColor: "#ff4444",
                                      color: "#ffffff",
                                      border: "none",
                                      cursor: "pointer",
                                    }}
                                  >
                                    {isSubmitting ? "Cancelling..." : "Yes, Cancel"}
                                  </button>
                                </Form>
                                <button
                                  type="button"
                                  onClick={() => setShowCancelConfirm(false)}
                                  style={{
                                    flex: 1,
                                    padding: "8px 0",
                                    borderRadius: 8,
                                    fontSize: 10,
                                    fontWeight: "bold",
                                    backgroundColor: C.surface,
                                    color: C.text,
                                    border: `1px solid ${C.border}`,
                                    cursor: "pointer",
                                  }}
                                >
                                  Keep Plan
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setShowCancelConfirm(true)}
                              style={{
                                ...getButtonStyle(false),
                                borderColor: "rgba(255, 68, 68, 0.2)",
                                color: "#ff4444",
                                backgroundColor: "rgba(255, 68, 68, 0.02)",
                              }}
                            >
                              Cancel Subscription
                            </button>
                          )
                        )}
                      </div>
                    )
                  ) : (
                    <>
                      {isUpgradeFromPaid && (
                        <div style={{
                          fontSize: 11,
                          color: C.accent,
                          textAlign: "center",
                          marginBottom: 8,
                          fontWeight: 600,
                        }}>
                          +${upgradeDiff.toFixed(2)}/{intervalTextCard} to upgrade from {PLANS[currentPlanKey]?.name?.split(" ")[0] || "your plan"}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => setActiveConfirmPlanKey(planKey)}
                        style={getButtonStyle(isHighlighted)}
                        disabled={isSubmitting}
                      onMouseEnter={(e) => {
                        if (isHighlighted) {
                          e.currentTarget.style.backgroundColor = "#34d399";
                          e.currentTarget.style.transform = "scale(1.02)";
                        } else {
                          e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.05)";
                          e.currentTarget.style.borderColor = "rgba(255,255,255,0.2)";
                          e.currentTarget.style.transform = "scale(1.02)";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (isHighlighted) {
                          e.currentTarget.style.backgroundColor = C.accent;
                          e.currentTarget.style.transform = "scale(1)";
                        } else {
                          e.currentTarget.style.backgroundColor = C.surface;
                          e.currentTarget.style.borderColor = C.border;
                          e.currentTarget.style.transform = "scale(1)";
                        }
                      }}
                    >
                      {isSubmitting
                        ? "Connecting..."
                        : isDowngradeOption
                        ? (key === "free" ? "Downgrade to Free" : `Downgrade to ${plan.name.split(" ")[0]}`)
                        : key === "free"
                        ? "Select Free"
                        : `Get ${plan.name.split(" ")[0]}`}
                    </button>
                    </>
                  )}
                </div>

              </div>
            );
          })}
        </div>

        {/* Sticky Billing Footnote */}
        <p style={{
          textAlign: "center",
          fontSize: 11,
          color: C.muted,
          marginTop: 48,
          maxWidth: 512,
          marginLeft: "auto",
          marginRight: "auto",
          lineHeight: 1.6,
        }}>
          Shopify manages all subscriptions securely. Upgrades take effect instantly with a prorated charge. Downgrades aren't available mid-cycle — cancel and re-subscribe after your cycle ends.
        </p>

        {/* Plain-English FAQ about plan changes */}
        <details style={{ maxWidth: 640, margin: "24px auto 0", fontSize: 12, color: C.muted }}>
          <summary style={{ cursor: "pointer", color: C.text, fontWeight: 600, padding: "8px 0" }}>
            What happens when I change plans?
          </summary>
          <ul style={{ marginTop: 8, lineHeight: 1.7, paddingLeft: 20 }}>
            <li>Your synced order history and activity log are always preserved.</li>
            <li>Your task name/description templates and sync settings stay the same.</li>
            <li>Upgrades are instant — you only pay the prorated difference for this cycle.</li>
            <li>Downgrading or cancelling may reduce your connected lists to the new plan's limit (Free = 1 list).</li>
          </ul>
        </details>
      {/* Plan Change Confirmation Modal */}
      {activeConfirmPlanKey && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100vw",
          height: "100vh",
          backgroundColor: "rgba(0, 0, 0, 0.75)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          backdropFilter: "blur(4px)",
        }}>
          <div style={{
            backgroundColor: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 16,
            padding: 24,
            maxWidth: 480,
            width: "90%",
            boxSizing: "border-box",
            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 10px 10px -5px rgba(0, 0, 0, 0.3)",
          }}>
            {(() => {
              const targetPlan = PLANS[activeConfirmPlanKey];
              const currentPlan = PLANS[currentPlanKey];
              
              const durationDays = subscription.annualBilling ? 365 : 30;
              const cycleStart = subscription.billingCycleStart || subscription.createdAt;
              const expirationDate = new Date(new Date(cycleStart).getTime() + durationDays * 24 * 60 * 60 * 1000);
              const expiryString = expirationDate.toLocaleDateString();

              const remainingTrialDays = (() => {
                if (subscription.planName === "trial" && subscription.trialEndDate) {
                  const diffMs = new Date(subscription.trialEndDate).getTime() - Date.now();
                  if (diffMs > 0) {
                    return Math.max(1, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
                  }
                }
                return 0;
              })();
              const trialEndDateString = subscription.trialEndDate ? new Date(subscription.trialEndDate).toLocaleDateString() : "";

              const PLAN_LEVELS = {
                free: 0,
                trial: 0,
                starter_monthly: 1,
                starter_annual: 1,
                standard_monthly: 2,
                standard_annual: 2,
                growth_monthly: 3,
                growth_annual: 3,
                pro_monthly: 4,
                pro_annual: 4,
              };
              const currentLevel = PLAN_LEVELS[currentPlanKey] || 0;
              const targetLevel = PLAN_LEVELS[activeConfirmPlanKey] || 0;
              const isUpgrade = targetLevel > currentLevel;

              const isCurrentPaid = currentPlanKey !== "free" && currentPlanKey !== "trial" && subscription.shopifyChargeStatus === "active";
              const showUpgradeTimingChoice = isCurrentPaid && isUpgrade;

              const getPlanPrice = (planKey) => {
                const plan = PLANS[planKey];
                if (!plan) return 0;
                if (userSeesPromo) {
                  return plan.price;
                }
                return plan.regularPrice || plan.price;
              };

              const currentPrice = getPlanPrice(currentPlanKey);
              const targetPrice = getPlanPrice(activeConfirmPlanKey);
              const diffPrice = targetPrice - currentPrice;
              const intervalText = targetPlan?.interval === "ANNUAL" ? "yr" : "mo";

              return (
                <>
                  <h3 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 12px 0", color: C.text }}>
                    {showUpgradeTimingChoice ? `Upgrade to ${targetPlan?.name?.split(" ")[0] || "New"} Plan` : "Confirm Plan Change"}
                  </h3>
                  
                  {showUpgradeTimingChoice ? (
                    <div>
                      <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, margin: "0 0 20px 0" }}>
                        Choose when you would like your upgrade to the <strong style={{ color: C.text }}>{targetPlan?.name || activeConfirmPlanKey}</strong> to take effect:
                      </p>
                      
                      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 24 }}>
                        <label style={{
                          display: "block",
                          padding: "14px 16px",
                          borderRadius: 12,
                          border: upgradeTiming === "APPLY_IMMEDIATELY" ? `1px solid ${C.accent}` : `1px solid ${C.border}`,
                          backgroundColor: upgradeTiming === "APPLY_IMMEDIATELY" ? "rgba(0, 196, 140, 0.05)" : "transparent",
                          cursor: "pointer",
                          transition: "border-color 0.2s ease, background-color 0.2s ease",
                          boxSizing: "border-box",
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
                            <input
                              type="radio"
                              name="timing_choice"
                              value="APPLY_IMMEDIATELY"
                              checked={upgradeTiming === "APPLY_IMMEDIATELY"}
                              onChange={() => setUpgradeTiming("APPLY_IMMEDIATELY")}
                              style={{ accentColor: C.accent, cursor: "pointer" }}
                            />
                            <span style={{ fontSize: 13, fontWeight: "bold", color: C.text }}>
                              Upgrade right now
                            </span>
                            <span style={{ fontSize: 13, fontWeight: 800, color: C.accent }}>
                              · Pay ${diffPrice.toFixed(2)} today
                            </span>
                          </div>
                          <div style={{ fontSize: 11, color: C.muted, paddingLeft: 24, lineHeight: 1.4 }}>
                            You pay a <strong style={{ color: C.text }}>prorated amount for the rest of this cycle</strong> (based on the ${diffPrice.toFixed(2)}/{intervalText} difference between plans), then <strong style={{ color: C.text }}>${targetPrice.toFixed(2)}/{intervalText}</strong> on every renewal after that. Shopify credits the unused time on your current plan. The new plan is active immediately.
                          </div>
                        </label>

                        <label style={{
                          display: "block",
                          padding: "14px 16px",
                          borderRadius: 12,
                          border: upgradeTiming === "APPLY_ON_NEXT_BILLING_CYCLE" ? `1px solid ${C.accent}` : `1px solid ${C.border}`,
                          backgroundColor: upgradeTiming === "APPLY_ON_NEXT_BILLING_CYCLE" ? "rgba(0, 196, 140, 0.05)" : "transparent",
                          cursor: "pointer",
                          transition: "border-color 0.2s ease, background-color 0.2s ease",
                          boxSizing: "border-box",
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
                            <input
                              type="radio"
                              name="timing_choice"
                              value="APPLY_ON_NEXT_BILLING_CYCLE"
                              checked={upgradeTiming === "APPLY_ON_NEXT_BILLING_CYCLE"}
                              onChange={() => setUpgradeTiming("APPLY_ON_NEXT_BILLING_CYCLE")}
                              style={{ accentColor: C.accent, cursor: "pointer" }}
                            />
                            <span style={{ fontSize: 13, fontWeight: "bold", color: C.text }}>
                              Start next cycle
                            </span>
                            <span style={{ fontSize: 13, fontWeight: 800, color: C.text }}>
                              · ${targetPrice.toFixed(2)}/{intervalText}
                            </span>
                          </div>
                           <div style={{ fontSize: 11, color: C.muted, paddingLeft: 24, lineHeight: 1.4 }}>
                             Keep your current plan for now. The <strong style={{ color: C.text }}>{targetPlan?.name?.split(" ")[0] || "new"} plan</strong> starts automatically on your next billing cycle (<strong>{expiryString}</strong>) at the full price of <strong style={{ color: C.text }}>${targetPrice.toFixed(2)}/{intervalText}</strong>. You are not charged until it starts.
                           </div>
                        </label>
                      </div>
                    </div>
                  ) : (
                    <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, margin: "0 0 24px 0" }}>
                      {currentPlanKey === "trial" && remainingTrialDays > 0
                        ? `You are subscribing to the ${targetPlan?.name || activeConfirmPlanKey} ($${targetPrice.toFixed(2)}/${intervalText}). This plan will activate immediately with full features, and you will receive a free trial for your remaining ${remainingTrialDays} day(s) first. Your first billing cycle will start automatically on ${trialEndDateString} after your trial ends. You will not be billed until then.`
                        : (subscription.shopifyChargeStatus === "cancelled"
                            ? `You are scheduling the ${targetPlan?.name || activeConfirmPlanKey}. It will automatically activate when your current ${currentPlan?.name || currentPlanKey} expires on ${expiryString}. You will not be charged for this new plan until it starts (Price: $${targetPrice.toFixed(2)}/${intervalText}).`
                            : `You are switching to the ${targetPlan?.name || activeConfirmPlanKey} ($${targetPrice.toFixed(2)}/${intervalText}). This new plan will start immediately. Shopify will calculate a prorated credit for any unused time on your current ${currentPlan?.name || currentPlanKey} and apply it to your next billing cycle.`
                          )
                      }
                    </p>
                  )}

                  <div style={{ display: "flex", gap: 12, justifyContent: "end" }}>
                    <button
                      type="button"
                      onClick={() => setActiveConfirmPlanKey(null)}
                      style={{
                        padding: "10px 18px",
                        borderRadius: 10,
                        fontSize: 12,
                        fontWeight: "bold",
                        backgroundColor: "transparent",
                        color: C.text,
                        border: `1px solid ${C.border}`,
                        cursor: "pointer",
                      }}
                    >
                      Cancel
                    </button>
                    <Form method="post" style={{ margin: 0, padding: 0 }}>
                      <input type="hidden" name="intent" value="upgrade" />
                      <input type="hidden" name="plan" value={activeConfirmPlanKey} />
                      <input type="hidden" name="replacement_behavior" value={upgradeTiming} />
                      <button
                        type="submit"
                        style={{
                          padding: "10px 18px",
                          borderRadius: 10,
                          fontSize: 12,
                          fontWeight: "bold",
                          backgroundColor: C.accent,
                          color: "#03251c",
                          border: "none",
                          cursor: "pointer",
                        }}
                      >
                        Confirm & Continue
                      </button>
                    </Form>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
