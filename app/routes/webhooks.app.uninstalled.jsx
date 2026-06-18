import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // Delete all data associated with this shop to satisfy GDPR shop/redact requirements
  // and ensure a clean slate on re-install.
  await Promise.all([
    // Shopify session tokens
    db.session.deleteMany({ where: { shop } }),
    // Third-party integration tokens + sync targets (cascade deletes SyncTarget, OrderSyncRecord)
    db.platformConnection.deleteMany({ where: { shopDomain: shop } }),
    // Background sync queue (contains full order JSON — PII must not be retained)
    db.syncJob.deleteMany({ where: { shopDomain: shop } }),
    // Activity feed log entries
    db.activityLog.deleteMany({ where: { shopDomain: shop } }),
    // Billing/subscription record
    db.subscription.deleteMany({ where: { shopDomain: shop } }),
  ]);

  console.log(`app/uninstalled for ${shop}: all data purged`);

  return new Response();
};
