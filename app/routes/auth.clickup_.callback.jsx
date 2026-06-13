import { redirect } from "react-router";
import { exchangeClickUpCode, saveToken } from "../clickup.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const shop = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    throw new Response(
      `ClickUp authorisation denied: ${url.searchParams.get("error_description") || error}`,
      { status: 400 },
    );
  }

  if (!code || !shop) {
    throw new Response("Missing ClickUp authorisation code or state", {
      status: 400,
    });
  }

  let accessToken;
  try {
    accessToken = await exchangeClickUpCode(code);
  } catch (err) {
    console.error("ClickUp token exchange error:", err);
    throw new Response(
      `Failed to connect ClickUp: ${err.message}`,
      { status: 502 },
    );
  }

  await saveToken(shop, accessToken);

  const storeHandle = shop.replace(/\.myshopify\.com$/, "");
  return redirect(
    // eslint-disable-next-line no-undef
    `https://admin.shopify.com/store/${storeHandle}/apps/${process.env.SHOPIFY_API_KEY}`,
  );
};
