import { redirect } from "react-router";
import {
  exchangeClickUpCode,
  saveToken,
  getTeams,
  logActivity,
} from "../clickup.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const shop = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const storeHandle = shop ? shop.replace(/\.myshopify\.com$/, "") : null;
  const appUrl = storeHandle
    ? `https://admin.shopify.com/store/${storeHandle}/apps/${process.env.SHOPIFY_API_KEY}`
    : "/";

  if (error) {
    const msg = encodeURIComponent(
      `ClickUp authorisation was denied: ${url.searchParams.get("error_description") || error}`
    );
    return redirect(`${appUrl}?clickup_error=${msg}`);
  }

  if (!code || !shop) {
    return redirect(`${appUrl}?clickup_error=${encodeURIComponent("Missing authorisation code — please try connecting again.")}`);
  }

  let accessToken;
  try {
    accessToken = await exchangeClickUpCode(code);
  } catch (err) {
    console.error("ClickUp token exchange error:", err);
    const msg = encodeURIComponent(
      "Failed to connect ClickUp. Please try again."
    );
    return redirect(`${appUrl}?clickup_error=${msg}`);
  }

  // Fetch workspace name — non-fatal if it errors
  let workspaceName = null;
  try {
    const teams = await getTeams(accessToken);
    workspaceName = teams[0]?.name || null;
  } catch (e) {
    console.error("Could not fetch ClickUp workspace name:", e);
  }

  await saveToken(shop, accessToken, workspaceName);
  logActivity(shop, "clickup_connected", `Connected to ClickUp${workspaceName ? ` (${workspaceName})` : ""}`);

  return redirect(appUrl);
};
