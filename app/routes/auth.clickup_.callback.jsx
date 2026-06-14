import { redirect } from "react-router";
import {
  exchangeClickUpCode,
  saveToken,
  getTeams,
  logActivity,
} from "../clickup.server";
import { verifyState } from "../oauth-state.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  // The shop is derived ONLY by verifying the signed `state` token — never from
  // a raw caller-supplied value. A forged callback therefore can't attach a
  // ClickUp account to a store it doesn't control.
  const shop = await verifyState(url.searchParams.get("state"));

  if (!shop) {
    // Missing / tampered / expired state — refuse to save anything.
    const msg = encodeURIComponent(
      "Your ClickUp connection link expired or was invalid. Please try connecting again."
    );
    return redirect(`/?clickup_error=${msg}`);
  }

  const storeHandle = shop.replace(/\.myshopify\.com$/, "");
  const appUrl = `https://admin.shopify.com/store/${storeHandle}/apps/${process.env.SHOPIFY_API_KEY}`;

  if (error) {
    const msg = encodeURIComponent(
      `ClickUp authorisation was denied: ${url.searchParams.get("error_description") || error}`
    );
    return redirect(`${appUrl}?clickup_error=${msg}`);
  }

  if (!code) {
    return redirect(
      `${appUrl}?clickup_error=${encodeURIComponent("Missing authorisation code — please try connecting again.")}`
    );
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
