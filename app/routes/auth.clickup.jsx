import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { getClickUpAuthUrl } from "../clickup.server";

/**
 * GET /auth/clickup
 *
 * Redirects the merchant to the ClickUp OAuth authorisation screen. This is a
 * top-level navigation (the "Connect ClickUp" button opens it with
 * target="_top"), so we accept the shop via the `shop` query param. If it is
 * absent we fall back to the authenticated Shopify session.
 */
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  let shop = url.searchParams.get("shop");

  if (!shop) {
    const { session } = await authenticate.admin(request);
    shop = session.shop;
  }

  return redirect(getClickUpAuthUrl(shop));
};
