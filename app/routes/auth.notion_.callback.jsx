/* global process */
import { redirect } from "react-router";
import {
  exchangeNotionCode,
  saveNotionToken,
  logActivity,
} from "../clickup.server";
import { verifyState } from "../oauth-state.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  const shop = await verifyState(url.searchParams.get("state"));

  if (!shop) {
    const msg = encodeURIComponent(
      "Your Notion connection link expired or was invalid. Please try connecting again."
    );
    return redirect(`/?clickup_error=${msg}`);
  }

  const storeHandle = shop.replace(/\.myshopify\.com$/, "");
  const appUrl = `https://admin.shopify.com/store/${storeHandle}/apps/${process.env.SHOPIFY_API_KEY}`;

  if (error) {
    const msg = encodeURIComponent(
      `Notion authorization was denied: ${url.searchParams.get("error_description") || error}`
    );
    return redirect(`${appUrl}?clickup_error=${msg}`);
  }

  if (!code) {
    return redirect(
      `${appUrl}?clickup_error=${encodeURIComponent("Missing authorization code — please try connecting again.")}`
    );
  }

  try {
    const { accessToken, workspaceId, workspaceName } = await exchangeNotionCode(code);

    // Save token
    await saveNotionToken(shop, accessToken, workspaceId, workspaceName);

    logActivity(shop, "clickup_connected", `Connected to Notion (${workspaceName})`);

    return redirect(appUrl);
  } catch (err) {
    console.error("Notion OAuth callback error:", err);
    const msg = encodeURIComponent("Failed to connect Notion. Please try again.");
    return redirect(`${appUrl}?clickup_error=${msg}`);
  }
};
