import { authenticate } from "../shopify.server";
import {
  getConnection,
  findOrderTask,
  completeTask,
} from "../clickup.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const order = payload;

  if (order.fulfillment_status !== "fulfilled") {
    console.log(`Order ${order.id} is not fulfilled (status: ${order.fulfillment_status}); skipping`);
    return new Response();
  }

  const connection = await getConnection(shop);
  if (!connection?.accessToken) {
    console.log(`No ClickUp connection for ${shop}; skipping`);
    return new Response();
  }

  const record = await findOrderTask(shop, String(order.id));
  if (!record) {
    console.log(`No ClickUp task recorded for order ${order.id}; skipping`);
    return new Response();
  }

  try {
    await completeTask(connection.accessToken, record.clickupTaskId);
    console.log(`Marked ClickUp task ${record.clickupTaskId} complete for order ${order.id}`);
  } catch (error) {
    console.error(`Failed to complete ClickUp task ${record.clickupTaskId} for order ${order.id}:`, error);
  }

  return new Response();
};
