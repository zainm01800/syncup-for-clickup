export const PLANS = {
  free: {
    key: "free",
    name: "Free Plan",
    price: 0,
    interval: "EVERY_30_DAYS",
    shopifyPlanName: "SyncUp Free Plan",
    annual: false,
    listLimit: 1,
    monthlyOrderLimit: 5,
    features: [
      "Up to 5 synced orders / mo",
      "1 ClickUp list connection",
      "Basic order status completion sync",
      "Rich text sync in standard task description body (Note: Subject to ClickUp's native free plan custom field limits)",
    ],
  },
  standard_monthly: {
    key: "standard_monthly",
    name: "Standard Monthly",
    price: 29.99,
    regularPrice: 49.99,
    interval: "EVERY_30_DAYS",
    shopifyPlanName: "SyncUp Standard Monthly",
    annual: false,
    listLimit: 1,
    monthlyOrderLimit: 150,
    features: [
      "Up to 150 synced orders / mo",
      "1 ClickUp list connection",
      "Status auto-completion sync (Shopify fulfillment -> ClickUp complete)",
      "Rich text sync in standard task description body",
    ],
  },
  standard_annual: {
    key: "standard_annual",
    name: "Standard Annual",
    price: 239,
    regularPrice: 399,
    interval: "ANNUAL",
    shopifyPlanName: "SyncUp Standard Annual",
    annual: true,
    listLimit: 1,
    monthlyOrderLimit: 150,
    features: [
      "Up to 150 synced orders / mo",
      "1 ClickUp list connection",
      "Status auto-completion sync (Shopify fulfillment -> ClickUp complete)",
      "Rich text sync in standard task description body",
    ],
  },
  growth_monthly: {
    key: "growth_monthly",
    name: "Growth Monthly",
    price: 49.99,
    regularPrice: 79.99,
    interval: "EVERY_30_DAYS",
    shopifyPlanName: "SyncUp Growth Monthly",
    annual: false,
    listLimit: 5,
    monthlyOrderLimit: null,
    features: [
      "Unlimited synced orders / mo",
      "Up to 5 ClickUp list connections",
      "ClickUp Custom Field Mapping (Map addresses, totals, and emails directly to ClickUp columns)",
      "Smart Multi-List Routing (Route orders based on product SKU, title, or vendor keywords)",
      "Automated error retry queue (Resilient background processing of API limits)",
    ],
  },
  growth_annual: {
    key: "growth_annual",
    name: "Growth Annual",
    price: 419,
    regularPrice: 699,
    interval: "ANNUAL",
    shopifyPlanName: "SyncUp Growth Annual",
    annual: true,
    listLimit: 5,
    monthlyOrderLimit: null,
    features: [
      "Unlimited synced orders / mo",
      "Up to 5 ClickUp list connections",
      "ClickUp Custom Field Mapping (Map addresses, totals, and emails directly to ClickUp columns)",
      "Smart Multi-List Routing (Route orders based on product SKU, title, or vendor keywords)",
      "Automated error retry queue (Resilient background processing of API limits)",
    ],
  },
  pro_monthly: {
    key: "pro_monthly",
    name: "Pro Monthly",
    price: 99.99,
    regularPrice: 149.99,
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
    price: 839,
    regularPrice: 1199,
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
