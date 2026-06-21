import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import { getNotionAuthUrl } from "../clickup.server";
import { signState, verifyState } from "../oauth-state.server";

/**
 * GET /auth/notion
 *
 * Redirects the merchant to the Notion OAuth authorization screen.
 */
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const incoming = url.searchParams.get("state");

  let state = (await verifyState(incoming)) ? incoming : null;
  if (!state) {
    const { session } = await authenticate.admin(request);
    state = await signState(session.shop);
  }

  return redirect(getNotionAuthUrl(state));
};
