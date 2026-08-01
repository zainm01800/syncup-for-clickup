# SyncUp — Automated E-Commerce Work Management Platform

[![Stack](https://img.shields.io/badge/Stack-React_Router_v7_%7C_Node.js_%7C_Prisma_%7C_PostgreSQL-blue.svg)](https://reactrouter.com/)
[![Platform](https://img.shields.io/badge/Platform-Shopify_App_Store_Production-green.svg)](https://shopify.dev/docs/apps)
[![Security](https://img.shields.io/badge/Security-AES--256--GCM_%7C_HMAC_CSRF_Protected-brightgreen.svg)]()
[![Deployment](https://img.shields.io/badge/Deployment-Vercel_Serverless_%7C_Neon_PostgreSQL-black.svg)](https://syncup-for-clickup.vercel.app)

**SyncUp** is a production-grade, multi-tenant Shopify Embedded App that automates order processing workflows by seamlessly syncing Shopify orders to task management platforms like **ClickUp**, **Notion**, and **Monday.com** in real-time. 

Built with **React Router v7**, **Prisma**, **Neon Serverless PostgreSQL**, and **Shopify App Bridge**, SyncUp automatically generates detailed tasks when orders are placed and automatically marks them complete when orders are fulfilled in Shopify.

---

## 🌟 Executive Summary & Problem Solved

E-commerce merchants managing custom manufacturing, personalized products, or manual fulfillment workflows waste countless hours manually copying order details into project management tools. 

SyncUp eliminates human error and manual data entry by:
- **Instant Order-to-Task Conversion:** Ingesting Shopify order webhooks and creating formatted tasks/pages complete with line items, shipping addresses, customer details, and order metadata.
- **Two-Way Status Synchronization:** Automatically updating task statuses in ClickUp/Notion/Monday when orders are marked as fulfilled, refunded, or updated in Shopify.
- **Smart Multi-List Routing:** Directing orders to specific lists, boards, or databases based on product SKUs, vendor keywords, or line-item tags.

---

## 🛠️ Tech Stack & Key Frameworks

| Layer | Technology / Tool |
| :--- | :--- |
| **Frontend UI** | React 18, `@shopify/app-bridge-react`, Polaris Design System, Tailwind CSS |
| **App Framework** | React Router v7 (SSR & Server Actions / Loaders), Node.js |
| **Database & ORM** | PostgreSQL (Neon Serverless Pooler) via Prisma ORM with `@prisma/adapter-neon` |
| **Authentication & Security** | Shopify OAuth 2.0, Cryptographic HMAC-signed State parameters, AES-256-GCM token encryption |
| **APIs & Protocols** | Shopify GraphQL Admin API, ClickUp REST API v2, Notion API, Webhook Event Ingestion |
| **Infrastructure & Hosting** | Vercel Serverless Functions, Neon PostgreSQL, Shopify Partner Platform |

---

## 🏗️ Architecture & System Data Flow

```mermaid
sequenceDiagram
    autonumber
    actor Customer as Customer / Merchant
    participant Shopify as Shopify Store / Webhooks
    participant SyncUp as SyncUp App (Vercel Serverless)
    participant DB as Neon PostgreSQL (Prisma)
    participant TaskApp as ClickUp / Notion / Monday API

    Customer->>Shopify: Places New Order (#1001)
    Shopify->>SyncUp: HTTP POST /webhooks/orders/create (HMAC Signed)
    SyncUp->>SyncUp: Verify Shopify Webhook HMAC Signature
    SyncUp->>DB: Check Shop Subscription & Reserve Monthly Order Slot
    SyncUp->>DB: Query Decrypted API Access Tokens for Shop
    SyncUp->>TaskApp: POST Create Task / Page (Order #1001 details)
    TaskApp-->>SyncUp: Returns Task ID (e.g. #wdtdx4z1y0)
    SyncUp->>DB: Store Mapping (shopifyOrderId ↔ taskRecordId)
    SyncUp->>DB: Record Audit Event in Activity Log
    
    Note over Shopify, TaskApp: Fulfillment Event
    Shopify->>SyncUp: HTTP POST /webhooks/orders/updated (Fulfillment Trigger)
    SyncUp->>DB: Lookup Task ID for shopifyOrderId
    SyncUp->>TaskApp: PUT Update Task Status ➔ "Complete"
```

---

## ✨ Core Features & Technical Highlights

### 1. Robust Multi-Tenant Architecture
* **Strict Tenant Isolation:** Every database entity is scoped by `shopDomain`, extracted directly from cryptographically authenticated Shopify contexts (`authenticate.admin()` or `authenticate.webhook()`). User-supplied input is never trusted for tenant scoping.
* **Delegated Integration Schema:** Flexible polymorphic design (`PlatformConnection`, `ClickUpMetadata`, `MondayMetadata`, `NotionMetadata`) allowing merchants to seamlessly connect and route to multiple project management tools.

### 2. Enterprise Security & Cryptography
* **Zero-Knowledge Token Encryption:** Third-party OAuth access tokens are encrypted at rest using **AES-256-GCM** with unique IVs (`crypto.server.js`), ensuring integration tokens are never stored in plain text.
* **HMAC CSRF Protection:** OAuth authorization flows utilize HMAC-signed `state` tokens (`oauth-state.server.js`) signed with the application secret, completely eliminating account-linking CSRF vulnerabilities.
* **Shopify Webhook HMAC Verification:** All inbound webhook payloads undergo strict SHA-256 HMAC verification prior to processing.

### 3. High-Concurrency & Data Integrity
* **Atomic Quota Reservation:** Concurrency-safe monthly order counter management (`tryReserveOrderSlot`) prevents race conditions under heavy order bursts.
* **Resilient Error Recovery:** Handles database constraint nuances (such as Neon's native PostgreSQL error `23505` alongside Prisma's `P2002`) and features automated retry queues for external API rate limits.
* **GDPR & PII Privacy Compliance:** Implements all required Shopify GDPR compliance endpoints (`customers/data_request`, `customers/redact`, `shop/redact`). Customer PII is passed to task platforms as needed but is **never stored in the application database**, strictly complying with privacy policies.

### 4. Tiered Monetization & Billing Engine
* **Shopify App Subscription Integration:** Full integration with Shopify's `AppSubscription` GraphQL API supporting Free, Starter, Standard, Growth, and Pro tiers with automated grace periods, upgrade/downgrade logic, and promo-code lock-ins.

---

## 📁 Repository Structure

```
syncup-for-clickup/
├── app/
│   ├── routes/
│   │   ├── app._index.jsx           # Main Merchant Dashboard & Analytics
│   │   ├── app.billing.jsx          # Plan Selection & Subscription Management
│   │   ├── api.jobs.process.jsx     # Asynchronous Sync Job Queue Processor
│   │   ├── auth.clickup*.jsx        # ClickUp OAuth 2.0 Flow Handlers
│   │   ├── auth.notion*.jsx         # Notion OAuth 2.0 Flow Handlers
│   │   └── webhooks.*.jsx           # Shopify Webhooks (Orders, App Uninstall, GDPR)
│   ├── billing.server.js            # Subscription & Quota Enforcement Logic
│   ├── clickup.server.js            # ClickUp API Integration & Field Mapping
│   ├── crypto.server.js             # AES-256-GCM Encryption / Decryption Utilities
│   ├── db.server.js                 # Neon Serverless Prisma Client Singleton
│   ├── oauth-state.server.js        # HMAC Cryptographic State Signer & Verifier
│   ├── plans.js                     # Tier Definitions & Feature Limits
│   └── shopify.server.js            # Shopify App React Router Configuration
├── prisma/
│   └── schema.prisma                # Database Models & Relationships
├── public/                          # Static Assets & Styling System
├── shopify.app.toml                 # Shopify App Configuration & Webhook Subscriptions
├── package.json
└── README.md
```

---

## 📊 Database Schema Overview

The database is built on Neon PostgreSQL and managed via Prisma ORM:

- **`Session`**: Shopify OAuth session tokens and store scopes.
- **`Subscription`**: Merchant billing plans, monthly order usage, trial dates, and sync settings.
- **`PlatformConnection`**: Connected integration credentials (ClickUp, Monday, Notion) with token encryption.
- **`SyncTarget`**: Configured destination lists/boards/databases with routing tags and keywords.
- **`OrderSyncRecord`**: Audit mapping connecting `shopifyOrderId` ➔ `targetRecordId`.
- **`ActivityLog`**: Merchant-facing activity feed and event logs.

---

## ⚡ Local Development Setup

### Prerequisites
- **Node.js**: `v20.19+` or `v22.12+`
- **Shopify Partner Account** & **Shopify CLI** (`npm i -g @shopify/cli`)
- **PostgreSQL Database** (e.g. Neon PostgreSQL or local Postgres)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/zainm01800/syncup-for-clickup.git
   cd syncup-for-clickup
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Create a `.env` file in the root directory:
   ```env
   SHOPIFY_API_KEY=your_shopify_api_key
   SHOPIFY_API_SECRET=your_shopify_api_secret
   SHOPIFY_APP_URL=https://your-app-url.ngrok-free.app
   SCOPES=read_customers,read_orders
   DATABASE_URL=postgresql://user:password@host/neondb?sslmode=require
   ENCRYPTION_KEY=64_character_hex_string
   CLICKUP_CLIENT_ID=your_clickup_client_id
   CLICKUP_CLIENT_SECRET=your_clickup_client_secret
   ```

4. **Initialize Database Schema:**
   ```bash
   npx prisma generate
   npx prisma db push
   ```

5. **Start Development Server:**
   ```bash
   npm run dev
   ```

---

## 📄 License & Author

Developed by **Zain M.**  
*Built for production deployment on the Shopify App Store.*
