import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { getClickUpAuthUrl } from "../clickup.server";
import { signState, verifyState } from "../oauth-state.server";

/**
 * GET /auth/clickup
 *
 * Redirects the merchant to the ClickUp OAuth authorisation screen. This is a
 * top-level navigation (the "Connect ClickUp" button opens it with
 * target="_top").
 *
 * The shop is carried in an HMAC-signed `state` token minted by the dashboard
 * loader. We accept that signed token; if it's missing/invalid we authenticate
 * the request and mint a fresh one. We never trust a raw `shop` value from the
 * URL — that's what allowed connecting ClickUp to another store.
 */
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const incoming = url.searchParams.get("state");

  let state = (await verifyState(incoming)) ? incoming : null;
  if (!state) {
    const { session } = await authenticate.admin(request);
    state = await signState(session.shop);
  }

  return redirect(getClickUpAuthUrl(state));
};
