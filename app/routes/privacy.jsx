const COLORS = {
  bg: "#0f0f0f",
  surface: "#1a1a1a",
  border: "#2a2a2a",
  text: "#ffffff",
  muted: "#9a9a9a",
  accent: "#00c48c",
};

export default function PrivacyPolicy() {
  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <header style={styles.header}>
          <div style={styles.logoDot} />
          <h1 style={styles.title}>SyncUp</h1>
        </header>

        <article style={styles.article}>
          <h2 style={styles.h2}>Privacy Policy</h2>
          <p style={styles.meta}>Last updated: June 2026</p>

          <h3 style={styles.h3}>Overview</h3>
          <p style={styles.p}>
            SyncUp (&ldquo;the App&rdquo;) is a Shopify application that
            automatically creates ClickUp tasks when orders are placed in your
            Shopify store, and marks those tasks complete when orders are
            fulfilled. This Privacy Policy explains what data we collect, how we
            use it, and how you can request its deletion.
          </p>

          <h3 style={styles.h3}>Data We Collect</h3>
          <p style={styles.p}>
            <strong>Shop data:</strong> We store your Shopify shop domain and
            authentication tokens required to integrate with Shopify and ClickUp.
          </p>
          <p style={styles.p}>
            <strong>Order data:</strong> When an order is placed, we store the
            Shopify order ID and the corresponding ClickUp task ID so we can mark
            the task complete on fulfillment. We do not store customer names,
            email addresses, payment details, or any other personally identifiable
            information on our servers.
          </p>
          <p style={styles.p}>
            <strong>ClickUp credentials:</strong> We store your ClickUp OAuth
            access token and the ClickUp list ID you choose to sync orders into.
            This data is stored securely and used solely to create and update
            tasks on your behalf.
          </p>
          <p style={styles.p}>
            <strong>Billing data:</strong> If you subscribe to a paid plan, we
            store the Shopify subscription ID and your current plan name. Payment
            processing is handled entirely by Shopify — we never see or store
            credit card numbers or billing details.
          </p>

          <h3 style={styles.h3}>How We Use Your Data</h3>
          <p style={styles.p}>
            We use the data described above exclusively to operate the App —
            creating ClickUp tasks for orders, marking tasks complete on
            fulfillment, and enforcing plan limits. We do not sell, rent, or share
            your data with third parties for marketing purposes.
          </p>

          <h3 style={styles.h3}>Data Retention and Deletion</h3>
          <p style={styles.p}>
            Your data is retained for as long as the App is installed on your
            store. When you uninstall the App, Shopify notifies us and we
            schedule deletion of all your shop data within 48 hours.
          </p>
          <p style={styles.p}>
            To request immediate deletion of your data, please contact us at the
            email below. We will process deletion requests within 30 days.
          </p>

          <h3 style={styles.h3}>Third-Party Services</h3>
          <p style={styles.p}>
            The App integrates with:
          </p>
          <ul style={styles.ul}>
            <li style={styles.li}>
              <strong>Shopify</strong> — to receive order webhooks and process
              billing. Their privacy policy governs their data handling.
            </li>
            <li style={styles.li}>
              <strong>ClickUp</strong> — to create and manage tasks. Their privacy
              policy governs their data handling.
            </li>
            <li style={styles.li}>
              <strong>Neon (PostgreSQL)</strong> — our database provider, hosted
              in the US. Data is encrypted at rest and in transit.
            </li>
            <li style={styles.li}>
              <strong>Vercel</strong> — our hosting provider. Application logs may
              be retained for up to 30 days for debugging purposes.
            </li>
          </ul>

          <h3 style={styles.h3}>GDPR &amp; CCPA</h3>
          <p style={styles.p}>
            If you are a merchant in the European Economic Area or California, you
            have the right to access, correct, or request deletion of your
            personal data. To exercise these rights, contact us at the email
            address below.
          </p>

          <h3 style={styles.h3}>Contact</h3>
          <p style={styles.p}>
            For privacy-related questions or data deletion requests, contact us
            at:{" "}
            <a href="mailto:zain.manda@gmail.com" style={styles.link}>
              zain.manda@gmail.com
            </a>
          </p>
        </article>
      </div>
    </div>
  );
}

const styles = {
  page: {
    background: COLORS.bg,
    color: COLORS.text,
    minHeight: "100vh",
    fontFamily:
      "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding: "60px 24px",
    boxSizing: "border-box",
  },
  container: {
    maxWidth: "720px",
    margin: "0 auto",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    marginBottom: "48px",
  },
  logoDot: {
    width: "36px",
    height: "36px",
    borderRadius: "9px",
    background: COLORS.accent,
    flexShrink: 0,
  },
  title: {
    margin: 0,
    fontSize: "20px",
    fontWeight: 600,
    color: COLORS.text,
  },
  article: {},
  h2: {
    fontSize: "28px",
    fontWeight: 700,
    color: COLORS.text,
    margin: "0 0 8px",
  },
  h3: {
    fontSize: "16px",
    fontWeight: 600,
    color: COLORS.text,
    margin: "32px 0 10px",
  },
  meta: {
    fontSize: "13px",
    color: COLORS.muted,
    margin: "0 0 32px",
  },
  p: {
    fontSize: "15px",
    lineHeight: 1.7,
    color: COLORS.muted,
    margin: "0 0 16px",
  },
  ul: {
    paddingLeft: "20px",
    margin: "0 0 16px",
  },
  li: {
    fontSize: "15px",
    lineHeight: 1.7,
    color: COLORS.muted,
    marginBottom: "8px",
  },
  link: {
    color: COLORS.accent,
  },
};
