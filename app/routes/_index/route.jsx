import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  // ClickUp strips paths from redirect URIs and lands here at /.
  // Forward to the dedicated callback handler.
  if (url.searchParams.get("code") && url.searchParams.get("state")) {
    throw redirect(`/auth/clickup/callback?${url.searchParams.toString()}`);
  }

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <div className={styles.header}>
          <div className={styles.logoMark}>
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#00c48c"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" />
              <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
            </svg>
          </div>
          <h1 className={styles.heading}>SyncUp</h1>
        </div>
        
        <h2 className={styles.title}>Automate your Shopify workflows directly in ClickUp and Notion</h2>
        <p className={styles.text}>
          Connect your store in seconds. Automatically create tasks or pages for new orders in ClickUp or Notion, and mark them complete when fulfilled.
        </p>

        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" placeholder="my-store-name.myshopify.com" />
              <span className={styles.hint}>Enter your shop domain to get started</span>
            </label>
            <button className={styles.button} type="submit">
              Install App
            </button>
          </Form>
        )}

        <ul className={styles.list}>
          <li>
            <strong>Instant Sync</strong>. A detailed task or page is created automatically in ClickUp or Notion as soon as a customer places a new order.
          </li>
          <li>
            <strong>Two-Way Fulfillment Sync</strong>. Fulfilling an order in Shopify completes the task in your workspace. Alternatively, marking a task complete in ClickUp or Notion automatically triggers Shopify fulfillment.
          </li>
          <li>
            <strong>Real-time Logs</strong>. Monitor sync status, connection health, and view an activity log directly inside your Shopify admin dashboard.
          </li>
        </ul>
      </div>
    </div>
  );
}

