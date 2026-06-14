# SyncUp — Agent & Contributor Guide

> Context for any AI coding agent (or human) picking up this project. **Read this first.**

## What it is
SyncUp — a Shopify **embedded app** that automatically creates a ClickUp task for every new Shopify order, and marks the task complete when the order is fulfilled. Solo-founder product, currently being submitted to the Shopify App Store.

## Stack & locations
- **Framework:** React Router v7 + `@shopify/shopify-app-react-router` (Node adapter)
- **Hosting:** Vercel — https://syncup-for-clickup.vercel.app (auto-deploys on push to `main`)
- **DB:** Neon PostgreSQL via Prisma (`driverAdapters` preview feature)
- **Repo:** GitHub `zainm01800/syncup-for-clickup`, branch `main`
- **Shopify:** client_id `2eac8af074b2ed8402633158c9719a59`; Dev Dashboard app id `381882564609` (org `222372818`); Partner org `4983727`
- **Dev store:** `syncup-test-store.myshopify.com`
- **Env vars** (set in Vercel — **never commit values**): `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES` (`read_orders,read_customers`), `SHOPIFY_APP_URL`, `DATABASE_URL`, `ENCRYPTION_KEY` (64-hex), `CLICKUP_CLIENT_ID`, `CLICKUP_CLIENT_SECRET`

## Architecture
- **Multi-tenant by shop:** every record is keyed by `shopDomain`. `shop` **always** comes from `authenticate.admin()` / `authenticate.webhook()` — never from user input.
- **Prisma models:** `Session`, `ClickUpConnection` (per shop), `OrderTask` (`shopDomain`+`shopifyOrderId` unique), `Subscription` (per shop), `ActivityLog`.
- **Key files:**
  - `app/shopify.server.js` — Shopify app config
  - `app/clickup.server.js` — ClickUp API client + DB helpers
  - `app/billing.server.js` — plans / Shopify billing
  - `app/crypto.server.js` — AES-256-GCM encryption for the ClickUp token
  - `app/oauth-state.server.js` — HMAC-signed OAuth `state`
  - `app/routes/webhooks.*` — webhook handlers
  - `app/routes/app._index.jsx` — merchant dashboard
  - `app/routes/auth.clickup*.jsx` — ClickUp OAuth flow
- **Webhooks** (declared in `shopify.app.toml`): `orders/create` → create task; `orders/updated` → complete task on fulfillment; `app/uninstalled`; `app/scopes_update`; GDPR `customers/data_request`, `customers/redact`, `shop/redact` (these use `compliance_topics`).
- **Billing:** Shopify-managed (free / starter / growth), real charges (`test: false`).

## Critical non-obvious learnings (don't relearn these the hard way)
1. **Protected Customer Data:** Shopify *redacts* customer name/email/phone/address from **both** webhooks and the Admin API (returns HTTP 200 with `null` fields) unless those fields are selected in **Partner Dashboard → API access requests → Protected customer data access**. The `read_customers` scope alone is **not** enough. Already configured (Name/Email/Phone/Address, reason "Store management") and the data-protection questionnaire is 16/16.
2. **Compliance webhooks** must be registered in `shopify.app.toml` via `compliance_topics`, or App Store review flags "missing mandatory compliance webhooks" **and** the HMAC automated check fails (it tests against those endpoints). Already done.
3. **Neon error codes:** Neon throws PostgreSQL native code `"23505"` for unique-constraint violations, not Prisma's `"P2002"`. `claimOrderSlot` catches both.
4. **Deploying config:** `shopify app deploy --allow-updates --allow-deletes` pushes scope/webhook changes from `shopify.app.toml` to Shopify (creates a new app version). Code changes deploy via `git push` to Vercel.
5. **OAuth state is signed:** ClickUp connect uses an HMAC-signed `state` token (`oauth-state.server.js`, signed with `SHOPIFY_API_SECRET`) to bind the flow to one authenticated shop. **Never trust a raw `shop`/`state` param** in the auth routes — doing so was a fixed account-linking CSRF.

## Current status — App Store submission (active work)
Nearly ready to submit. In the Partner "App Store review" checklist, everything is green **except** the **Embedded app checks**, which auto-verify every ~2 hours from app usage (opening the app on the dev store regenerates the session data they check). When that goes green, the **Submit for review** button unlocks.

Already complete: listing (clean, pricing-free screenshots + copy), protected customer data, automated checks (compliance + HMAC), capabilities (embedded), emergency contact, AI self-review.

## Next steps
1. **(Owner / dashboard)** When the embedded check is green, click **Submit for review**. First confirm: the demo video is **Unlisted/Public** (not Private), and the ClickUp reviewer **test account has 2FA off**.
2. **(Code)** Test the ClickUp OAuth flow end-to-end: **disconnect → reconnect** ClickUp on the dev store and confirm orders still sync. The signed-state change passed unit tests + build but hasn't had a live round-trip.
3. **(Optional)** Replace placeholder template text in `app/routes/_index/route.jsx` (public landing page) with real copy.
4. **(Future)** Generalize the ClickUp-specific connection layer to add **Notion / Monday** — e.g. a `provider` field on the connection + one adapter per tool.

## How to verify changes
- **Build:** `npm run build`
- **End-to-end:** create a draft order in the dev store admin → **Mark as paid** → a task named `Order #N — [Customer]` appears in the connected ClickUp list. Check Vercel function logs for webhook output.
- **OAuth state logic:** pure functions in `app/oauth-state.server.js` (sign/verify) are unit-testable without the browser.

## Guardrails
- **Never commit secrets;** reference env vars by name.
- `shop` must always come from authenticated Shopify context.
- Customer PII flows **to** ClickUp but is **not persisted** in the app DB (only `orderId ↔ taskId`). Keep it that way — it's stated in the privacy policy (`app/routes/privacy.jsx`).
- Do **not** auto-click irreversible dashboard actions (Submit for review, billing) without the owner's explicit confirmation.
