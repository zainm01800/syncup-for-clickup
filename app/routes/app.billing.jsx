import { useEffect, useState } from "react";
import { useLoaderData, useActionData, useNavigation, Form, redirect, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { PLANS, getTranslatedFeatures } from "../plans";
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

  return { subscription, selectedPlatform };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");
  const planKey = formData.get("plan");

  if (intent === "upgrade" && planKey) {
    if (planKey === "free") {
      const subscription = await getOrCreateSubscription(shop);
      if (subscription.shopifyChargeId) {
        await cancelExistingSubscription(admin, subscription.shopifyChargeId);
      }
      await downgradeToFree(shop);
      return redirect("/app?billing_success=1");
    } else if (PLANS[planKey]) {
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
  }

  return { error: "Unknown action." };
};

export default function BillingPage() {
  const { subscription, selectedPlatform } = useLoaderData();
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

  // Display configurations matching the required specs
  const planSpecs = {
    free: {
      key: "free",
      badge: null,
      priceDesc: "Free forever",
      annualPriceDesc: "Free forever",
      billedDesc: "Billed monthly",
      monthlyEquivalent: "0",
    },
    standard: {
      key: "standard",
      badge: "Best for Starters",
      priceDesc: "$29.99/mo",
      annualPriceDesc: "$19.99/mo",
      billedDesc: "Billed annually as $239",
      monthlyEquivalent: "19.99",
      regMonthly: "$49.99",
      regAnnual: "$399",
    },
    growth: {
      key: "growth",
      badge: "Most Popular",
      priceDesc: "$49.99/mo",
      annualPriceDesc: "$34.99/mo",
      billedDesc: "Billed annually as $419",
      monthlyEquivalent: "34.99",
      regMonthly: "$79.99",
      regAnnual: "$699",
    },
    pro: {
      key: "pro",
      badge: "Concierge Setup Included",
      priceDesc: "$99.99/mo",
      annualPriceDesc: "$69.99/mo",
      billedDesc: "Billed annually as $839",
      monthlyEquivalent: "69.99",
      regMonthly: "$149.99",
      regAnnual: "$1199",
    },
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 py-12 px-4 sm:px-6 lg:px-8 font-sans">
      <div className="max-w-7xl mx-auto">
        
        {/* Navigation & Header */}
        <header className="mb-10 max-w-4xl mx-auto">
          <Link
            to="/app"
            className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors inline-flex items-center gap-1.5 mb-6"
          >
            &larr; Back to Settings
          </Link>
          <h1 className="text-3xl font-extrabold text-white tracking-tight sm:text-4xl mb-3">
            Pricing Plans & Billing
          </h1>
          <p className="text-sm text-zinc-400 leading-relaxed">
            Select a plan to automate your order workflows. SyncUp uses Shopify secure billing, and all plan pricing is displayed in USD. Test mode is active.
          </p>
        </header>

        {/* Grandfathering / Urgency Banner */}
        <div className="bg-emerald-950/20 border border-emerald-500/30 text-emerald-400 p-4 rounded-xl text-xs sm:text-sm flex items-start gap-3 mb-10 max-w-4xl mx-auto shadow-lg shadow-emerald-950/10 backdrop-blur-sm">
          <span className="text-xl leading-none">🚀</span>
          <div>
            <strong className="font-semibold block mb-0.5 text-emerald-300">LAUNCH SPECIAL OFFER</strong>
            Install today to lock in these discounted B2B rates forever. Once our beta ends, pricing will increase for new installs. Existing merchants will remain grandfathered on these plans indefinitely!
          </div>
        </div>

        {/* Action Notifications */}
        {actionData?.error && (
          <div className="bg-red-950/30 border border-red-500/30 text-red-400 p-4 rounded-xl text-sm mb-8 max-w-4xl mx-auto">
            ✕ {actionData.error}
          </div>
        )}

        {actionData?.confirmationUrl && (
          <div className="bg-emerald-950/30 border border-emerald-500/30 text-emerald-400 p-4 rounded-xl text-sm mb-8 max-w-4xl mx-auto animate-pulse">
            ⚡ Redirecting to Shopify billing approval page…
          </div>
        )}

        {/* Monthly/Annual Toggle */}
        <div className="flex justify-center items-center gap-3 mb-12">
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

        {/* Pricing Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 items-stretch">
          {["free", "standard", "growth", "pro"].map((key) => {
            const planKey = key === "free" ? "free" : `${key}_${billingInterval}`;
            const plan = PLANS[planKey];
            if (!plan) return null;

            const isCurrent = currentPlanKey === planKey;
            const isHighlighted = key === "growth";
            const spec = planSpecs[key];

            const displayPrice = billingInterval === "annual" && key !== "free" 
              ? spec.annualPriceDesc 
              : spec.priceDesc;

            const regularPrice = billingInterval === "annual" && key !== "free"
              ? spec.regAnnual
              : spec.regMonthly;

            const isDowngradeOption = key === "free" && 
              (currentPlanKey.startsWith("standard") || currentPlanKey.startsWith("growth") || currentPlanKey.startsWith("pro"));

            return (
              <div
                key={key}
                className={`bg-zinc-900/40 border rounded-2xl p-6 flex flex-col justify-between transition-all duration-300 relative backdrop-blur-sm ${
                  isHighlighted 
                    ? "border-emerald-500/40 shadow-xl shadow-emerald-950/10 hover:border-emerald-500/60" 
                    : "border-zinc-800 hover:border-zinc-700"
                } ${isCurrent ? "border-emerald-400 ring-1 ring-emerald-400/30" : ""}`}
              >
                {/* Visual Badges */}
                {isCurrent && (
                  <div className="absolute top-3 right-3 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[9px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full">
                    Active
                  </div>
                )}
                {isHighlighted && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-emerald-500 text-zinc-950 text-[10px] font-black uppercase tracking-wider px-3.5 py-1 rounded-full shadow-lg shadow-emerald-500/20">
                    {spec.badge}
                  </div>
                )}

                {/* Card Top */}
                <div>
                  <div className="mb-4">
                    <span className="text-zinc-500 text-[10px] font-semibold tracking-wider uppercase block mb-1">
                      {key} tier
                    </span>
                    <h3 className="text-lg font-bold text-white tracking-tight">{plan.name}</h3>
                  </div>

                  {/* Price */}
                  <div className="mb-6">
                    <div className="flex items-baseline flex-wrap gap-1.5">
                      {key !== "free" && regularPrice && (
                        <span className="text-sm text-zinc-500 line-through mr-1 font-medium">
                          {regularPrice}
                        </span>
                      )}
                      <span className="text-3xl font-extrabold text-white tracking-tight">
                        {key === "free" ? "$0" : displayPrice.split("/")[0]}
                      </span>
                      <span className="text-zinc-400 text-sm font-medium">
                        {key === "free" ? "/mo" : `/${displayPrice.split("/")[1]}`}
                      </span>
                    </div>

                    {/* Annual info */}
                    {billingInterval === "annual" && key !== "free" && (
                      <div className="text-[11px] text-zinc-400 mt-1.5 font-medium flex items-center gap-1">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                        {spec.billedDesc} ({spec.priceDesc} equivalent)
                      </div>
                    )}
                  </div>

                  {/* Divider */}
                  <div className="h-px bg-zinc-800/80 mb-6"></div>

                  {/* Features */}
                  <ul className="space-y-3 mb-8 text-xs sm:text-sm text-zinc-300">
                    {getTranslatedFeatures(plan.features, selectedPlatform).map((feat) => (
                      <li key={feat} className="flex items-start">
                        <span className="text-emerald-400 mr-2 flex-shrink-0 font-bold">✓</span>
                        <span className="leading-snug">{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Card Action */}
                <div className="mt-auto">
                  {isCurrent ? (
                    <div className="w-full text-center py-2.5 rounded-xl text-xs font-bold border border-emerald-500/20 text-emerald-400 bg-emerald-500/5 cursor-default">
                      Current Plan
                    </div>
                  ) : (
                    <Form method="post">
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
                        {isSubmitting
                          ? "Connecting..."
                          : isDowngradeOption
                          ? "Downgrade to Free"
                          : key === "free"
                          ? "Select Free"
                          : `Get ${plan.name.split(" ")[0]}`}
                      </button>
                    </Form>
                  )}
                </div>

              </div>
            );
          })}
        </div>

        {/* Sticky Billing Footnote */}
        <p className="text-center text-[11px] text-zinc-500 mt-12 max-w-lg mx-auto leading-relaxed">
          Shopify manages all subscriptions securely. You can cancel or change your plan at any time. Moving between paid plans uses immediate replacement overrides.
        </p>

      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
