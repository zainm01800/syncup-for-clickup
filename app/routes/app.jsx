import { useEffect } from "react";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <SessionTokenCheckIn />
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/history">Sync History</s-link>
        <s-link href="/app/additional">Additional page</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

function SessionTokenCheckIn() {
  useEffect(() => {
    let cancelled = false;

    async function checkIn() {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const getToken = window.shopify?.idToken;

        if (typeof getToken === "function") {
          const token = await getToken.call(window.shopify);
          if (cancelled || !token) return;

          await fetch("/app/session-token", {
            headers: { Authorization: `Bearer ${token}` },
            credentials: "same-origin",
          });
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    checkIn().catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
