import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // Create a new background SyncJob row
  try {
    await prisma.syncJob.create({
      data: {
        shopDomain: shop,
        shopifyOrderId: String(payload.id),
        payload: JSON.stringify(payload),
        status: "pending",
      }
    });

    // Fire-and-forget: Trigger the background processing endpoint asynchronously
    const host = request.headers.get("host");
    const protocol = host.includes("localhost") || host.includes("127.0.0.1") ? "http" : "https";
    const triggerUrl = `${protocol}://${host}/api/jobs/process?secret=${process.env.SHOPIFY_API_SECRET}`;

    fetch(triggerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      }
    }).catch((err) => {
      console.error("Failed to trigger background jobs process:", err);
    });

  } catch (dbErr) {
    console.error("Failed to write webhook payload to sync queue:", dbErr);
  }

  return Response.json({ ok: true });
};
