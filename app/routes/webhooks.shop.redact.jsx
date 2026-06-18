import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// GDPR mandatory: delete all data for a shop 48 hours after uninstall.
export const action = async ({ request }) => {
  const { shop } = await authenticate.webhook(request);

  await Promise.all([
    prisma.orderSyncRecord.deleteMany({ where: { shopDomain: shop } }),
    prisma.platformConnection.deleteMany({ where: { shopDomain: shop } }),
    // SyncJob stores full Shopify order JSON (customer name, email, address) — must be purged
    prisma.syncJob.deleteMany({ where: { shopDomain: shop } }),
    prisma.subscription.deleteMany({ where: { shopDomain: shop } }),
    prisma.activityLog.deleteMany({ where: { shopDomain: shop } }),
    prisma.session.deleteMany({ where: { shop: shop } }),
  ]);


  console.log(`shop/redact for shop=${shop}: all data deleted`);

  return new Response(null, { status: 200 });
};
