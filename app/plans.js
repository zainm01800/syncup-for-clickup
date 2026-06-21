export const PLANS = {
  free: {
    key: "free",
    name: "Free Plan",
    price: 0,
    interval: "EVERY_30_DAYS",
    shopifyPlanName: "SyncUp Free Plan",
    annual: false,
    listLimit: 1,
    monthlyOrderLimit: 10,
    features: [
      "Up to 10 synced orders / mo",
      "1 ClickUp list connection",
      "Basic order status completion sync",
      "Rich text sync in standard task description body (Note: Subject to ClickUp's native free plan custom field limits)",
    ],
  },
  starter_monthly: {
    key: "starter_monthly",
    name: "Starter Monthly",
    price: 9.99,
    regularPrice: 14.99,
    interval: "EVERY_30_DAYS",
    shopifyPlanName: "SyncUp Starter Monthly",
    annual: false,
    listLimit: 1,
    monthlyOrderLimit: 100,
    features: [
      "Up to 100 synced orders / mo",
      "1 ClickUp list connection",
      "Status auto-completion sync (Shopify fulfillment -> ClickUp complete)",
      "Rich text sync in standard task description body",
    ],
  },
  starter_annual: {
    key: "starter_annual",
    name: "Starter Annual",
    price: 99,
    regularPrice: 149,
    interval: "ANNUAL",
    shopifyPlanName: "SyncUp Starter Annual",
    annual: true,
    listLimit: 1,
    monthlyOrderLimit: 100,
    features: [
      "Up to 100 synced orders / mo",
      "1 ClickUp list connection",
      "Status auto-completion sync (Shopify fulfillment -> ClickUp complete)",
      "Rich text sync in standard task description body",
    ],
  },
  standard_monthly: {
    key: "standard_monthly",
    name: "Standard Monthly",
    price: 19.99,
    regularPrice: 29.99,
    interval: "EVERY_30_DAYS",
    shopifyPlanName: "SyncUp Standard Monthly",
    annual: false,
    listLimit: 1,
    monthlyOrderLimit: 500,
    features: [
      "Up to 500 synced orders / mo",
      "1 ClickUp list connection",
      "Status auto-completion sync (Shopify fulfillment -> ClickUp complete)",
      "Rich text sync in standard task description body",
    ],
  },
  standard_annual: {
    key: "standard_annual",
    name: "Standard Annual",
    price: 215,
    regularPrice: 323,
    interval: "ANNUAL",
    shopifyPlanName: "SyncUp Standard Annual",
    annual: true,
    listLimit: 1,
    monthlyOrderLimit: 500,
    features: [
      "Up to 500 synced orders / mo",
      "1 ClickUp list connection",
      "Status auto-completion sync (Shopify fulfillment -> ClickUp complete)",
      "Rich text sync in standard task description body",
    ],
  },
  growth_monthly: {
    key: "growth_monthly",
    name: "Growth Monthly",
    price: 39.99,
    regularPrice: 49.99,
    interval: "EVERY_30_DAYS",
    shopifyPlanName: "SyncUp Growth Monthly",
    annual: false,
    listLimit: 5,
    monthlyOrderLimit: 2500,
    features: [
      "Up to 2,500 synced orders / mo",
      "Up to 5 ClickUp list connections",
      "ClickUp Custom Field Mapping (Map addresses, totals, and emails directly to ClickUp columns)",
      "Smart Multi-List Routing (Route orders based on product SKU, title, or vendor keywords)",
      "Automated error retry queue (Resilient background processing of API limits)",
    ],
  },
  growth_annual: {
    key: "growth_annual",
    name: "Growth Annual",
    price: 431,
    regularPrice: 539,
    interval: "ANNUAL",
    shopifyPlanName: "SyncUp Growth Annual",
    annual: true,
    listLimit: 5,
    monthlyOrderLimit: 2500,
    features: [
      "Up to 2,500 synced orders / mo",
      "Up to 5 ClickUp list connections",
      "ClickUp Custom Field Mapping (Map addresses, totals, and emails directly to ClickUp columns)",
      "Smart Multi-List Routing (Route orders based on product SKU, title, or vendor keywords)",
      "Automated error retry queue (Resilient background processing of API limits)",
    ],
  },
  pro_monthly: {
    key: "pro_monthly",
    name: "Pro Monthly",
    price: 79.99,
    regularPrice: 99.99,
    interval: "EVERY_30_DAYS",
    shopifyPlanName: "SyncUp Pro Monthly",
    annual: false,
    listLimit: 999,
    monthlyOrderLimit: null,
    features: [
      "Unlimited synced orders / mo",
      "Unlimited ClickUp list connections",
      "Priority real-time webhook processing queue",
      "Priority developer support",
    ],
  },
  pro_annual: {
    key: "pro_annual",
    name: "Pro Annual",
    price: 863,
    regularPrice: 1079,
    interval: "ANNUAL",
    shopifyPlanName: "SyncUp Pro Annual",
    annual: true,
    listLimit: 999,
    monthlyOrderLimit: null,
    features: [
      "Unlimited synced orders / mo",
      "Unlimited ClickUp list connections",
      "Priority real-time webhook processing queue",
      "Priority developer support",
    ],
  },
};

export const PLAN_LEVELS = {
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

export function getTranslatedFeatures(features, platform = "clickup") {
  if (!platform) platform = "clickup";
  const p = platform.toLowerCase();
  
  return features.map((feat) => {
    let result = feat;
    if (p === "monday") {
      result = result
        .replace(/ClickUp lists/g, "Monday boards")
        .replace(/ClickUp list/g, "Monday board")
        .replace(/ClickUp Custom Field Mapping/g, "Monday Column Mapping")
        .replace(/ClickUp custom field/g, "Monday column")
        .replace(/ClickUp/g, "Monday.com");
    } else if (p === "notion") {
      result = result
        .replace(/ClickUp lists/g, "Notion databases")
        .replace(/ClickUp list/g, "Notion database")
        .replace(/ClickUp Custom Field Mapping/g, "Notion Property Mapping")
        .replace(/ClickUp custom field/g, "Notion property")
        .replace(/ClickUp/g, "Notion");
    }
    return result;
  });
}
