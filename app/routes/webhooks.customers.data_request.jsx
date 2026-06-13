import { authenticate } from "../shopify.server";

// GDPR mandatory: respond to customer data access requests.
// We store Shopify order IDs linked to ClickUp task IDs — no PII is stored server-side.
export const action = async ({ request }) => {
  const { shop, payload } = await authenticate.webhook(request);

  const customerId = payload?.customer?.id;
  const orderIds = (payload?.orders_requested || []).map(String);

  console.log(
    `customers/data_request for shop=${shop} customer=${customerId} orders=${orderIds.join(",")}`
  );

  return new Response(null, { status: 200 });
};
