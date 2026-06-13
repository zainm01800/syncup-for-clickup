import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// GDPR mandatory: delete all data for a shop 48 hours after uninstall.
export const action = async ({ request }) => {
  const { shop } = await authenticate.webhook(request);

  await Promise.all([
    prisma.orderTask.deleteMany({ where: { shopDomain: shop } }),
    prisma.clickUpConnection.deleteMany({ where: { shopDomain: shop } }),
    prisma.subscription.deleteMany({ where: { shopDomain: shop } }),
  ]);

  console.log(`shop/redact for shop=${shop}: all data deleted`);

  return new Response(null, { status: 200 });
};
