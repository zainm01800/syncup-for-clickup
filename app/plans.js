export const PLANS = {
  free: {
    key: "free",
    name: "Free",
    price: 0,
    monthlyOrderLimit: 50,
    features: [
      "Up to 50 orders/month",
      "Automatic ClickUp task creation",
      "Single list connection",
      "Order fulfillment sync",
    ],
  },
  starter: {
    key: "starter",
    name: "Starter",
    price: 19,
    monthlyOrderLimit: null,
    shopifyPlanName: "SyncUp Starter",
    features: [
      "Unlimited orders/month",
      "Automatic ClickUp task creation",
      "Single list connection",
      "Order fulfillment sync",
      "Email support",
    ],
  },
  growth: {
    key: "growth",
    name: "Growth",
    price: 39,
    monthlyOrderLimit: null,
    shopifyPlanName: "SyncUp Growth",
    features: [
      "Unlimited orders/month",
      "Automatic ClickUp task creation",
      "Multiple list connections",
      "Order fulfillment sync",
      "Priority support",
      "Abandoned cart sync (coming soon)",
    ],
  },
};
