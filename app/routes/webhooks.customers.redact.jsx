import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// GDPR mandatory: delete all data we hold for a specific customer.
// We store order IDs mapped to ClickUp task IDs — remove those rows.
export const action = async ({ request }) => {
  const { shop, payload } = await authenticate.webhook(request);

  const orderIds = (payload?.orders_to_redact || []).map(String);

  if (orderIds.length > 0) {
    await prisma.orderTask.deleteMany({
      where: {
        shopDomain: shop,
        shopifyOrderId: { in: orderIds },
      },
    });
  }

  console.log(
    `customers/redact for shop=${shop}: deleted order_tasks for orders=[${orderIds.join(",")}]`
  );

  return new Response(null, { status: 200 });
};
