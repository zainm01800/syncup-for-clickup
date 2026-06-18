# SyncUp — Complete Codebase Consolidation

This document groups the entire source code of all the integration adapters, database configurations, routing controls, and webhook handlers of the SyncUp project.

---

## File: [.graphqlrc.js](file:///c:/Users/zainm/syncup-for-clickup/.graphqlrc.js)

```javascript
import fs from "fs";
import { ApiVersion } from "@shopify/shopify-app-react-router/server";
import { shopifyApiProject, ApiType } from "@shopify/api-codegen-preset";
function getConfig() {
  const config = {
    projects: {
      default: shopifyApiProject({
        apiType: ApiType.Admin,
        apiVersion: ApiVersion.October25,
        documents: [
          "./app/**/*.{js,ts,jsx,tsx}",
          "./app/.server/**/*.{js,ts,jsx,tsx}",
        ],
        outputDir: "./app/types",
      }),
    },
  };
  let extensions = [];
  try {
    extensions = fs.readdirSync("./extensions");
  } catch {
    // ignore if no extensions
  }
  for (const entry of extensions) {
    const extensionPath = `./extensions/${entry}`;
    const schema = `${extensionPath}/schema.graphql`;
    if (!fs.existsSync(schema)) {
      continue;
    }
    config.projects[entry] = {
      schema,
      documents: [`${extensionPath}/**/*.graphql`],
    };
  }
  return config;
}
const config = getConfig();
export default config;
```

---

## File: [.mcp.json](file:///c:/Users/zainm/syncup-for-clickup/.mcp.json)

```json
{
  "mcpServers": {
    "shopify-dev-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@shopify/dev-mcp@latest"]
    }
  }
}
```

---

## File: [AGENTS.md](file:///c:/Users/zainm/syncup-for-clickup/AGENTS.md)

```markdown
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
```

---

## File: [app/adapters/core.js](file:///c:/Users/zainm/syncup-for-clickup/app/adapters/core.js)

```javascript
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extracts standard order mapping variables from raw Shopify JSON.
 */
export function extractOrderSourceFields(order, customerName, shippingCost) {
  const email = order.customer?.email || order.email || "";
  const phone = order.customer?.phone || order.billing_address?.phone || order.shipping_address?.phone || "";
  const total = order.total_price ?? "0.00";
  const subtotal = order.subtotal_price ?? "0.00";
  
  let shippingAddress = "";
  const addr = order.shipping_address;
  if (addr) {
    const addrParts = [
      addr.address1,
      addr.address2,
      [addr.city, addr.province_code || addr.province, addr.zip]
        .filter(Boolean)
        .join(", "),
      addr.country,
    ].filter(Boolean);
    shippingAddress = addrParts.join(", ");
  }

  const orderNotes = order.note?.trim() || "";
  const createdAt = order.created_at || new Date().toISOString();

  return {
    order_number: String(order.order_number || order.id || ""),
    customer_name: customerName || "Guest",
    customer_email: email,
    customer_phone: phone,
    total_price: total,
    subtotal_price: subtotal,
    shipping_price: shippingCost,
    shipping_address: shippingAddress,
    order_notes: orderNotes,
    created_at: createdAt
  };
}

/**
 * Base abstract Integration Adapter class.
 */
export class IntegrationAdapter {
  async createRecord() {
    throw new Error("createRecord() not implemented");
  }

  async completeRecord() {
    throw new Error("completeRecord() not implemented");
  }

  async testConnection() {
    throw new Error("testConnection() not implemented");
  }

  async fetchTargets() {
    throw new Error("fetchTargets() not implemented");
  }

  async fetchFields() {
    throw new Error("fetchFields() not implemented");
  }
}

/**
 * Helper to call ClickUp API REST requests.
 */
async function clickupRequest(endpoint, token, options = {}) {
  const url = `https://api.clickup.com/api/v2${endpoint}`;
  const headers = {
    Authorization: token,
    "Content-Type": "application/json",
    ...options.headers,
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ClickUp API failed at ${endpoint} (${res.status}): ${body}`);
  }
  return res.json();
}

function normalizeClickUpFieldType(type) {
  if (typeof type === "number" || !isNaN(Number(type))) {
    const typeNum = Number(type);
    const mappings = {
      0: "attachment",
      1: "checkbox",
      2: "currency",
      3: "date",
      4: "dropdown",
      5: "email",
      6: "emoji",
      7: "formula",
      8: "location",
      9: "number",
      10: "people",
      11: "phone",
      12: "progress",
      13: "rating",
      14: "relationship",
      15: "rollup",
      16: "short_text",
      17: "tasks",
      18: "text",
      19: "url"
    };
    return mappings[typeNum] || "text";
  }
  return String(type || "").toLowerCase();
}

/**
 * ClickUp Integration Adapter
 */
export class ClickUpAdapter extends IntegrationAdapter {
  constructor(apiToken) {
    super();
    this.apiToken = apiToken;
  }

  async createRecord(targetResourceId, { name, description, priority, startDate, dueDate, tags, rawOrder, customerName, shippingCost, fieldMappings, isFreePlan, subtasks, attachments }) {
    const body = {
      name,
      description,
      priority: priority ?? 3,
      tags: tags ?? ["shopify-order"],
    };
    if (startDate) body.start_date = startDate;
    if (dueDate) body.due_date = dueDate;

    // 2. Set custom fields if not free plan (batch set in initial creation body)
    if (!isFreePlan && fieldMappings) {
      let mappings = [];
      try {
        mappings = typeof fieldMappings === "string" ? JSON.parse(fieldMappings) : fieldMappings;
      } catch (e) {
        console.error("Failed to parse ClickUp mappings in adapter:", e);
      }

      if (Array.isArray(mappings) && mappings.length > 0) {
        const orderValues = extractOrderSourceFields(rawOrder, customerName, shippingCost);
        const customFieldsBody = [];
        for (const mapping of mappings) {
          const rawVal = orderValues[mapping.shopifySourceField];
          if (rawVal !== undefined && rawVal !== null && String(rawVal).trim() !== "") {
            try {
              const formattedVal = this.formatFieldForClickUp(rawVal, mapping.clickupFieldType);
              customFieldsBody.push({
                id: mapping.clickupFieldId,
                value: formattedVal,
              });
            } catch (err) {
              console.error(`Failed to format field ${mapping.clickupFieldId}:`, err);
            }
          }
        }
        if (customFieldsBody.length > 0) {
          body.custom_fields = customFieldsBody;
        }
      }
    }

    // 1. Create main task (including custom fields in the POST body to avoid sequential writes)
    const task = await clickupRequest(`/list/${targetResourceId}/task`, this.apiToken, {
      method: "POST",
      body: JSON.stringify(body),
    });

    const taskId = task.id;

    // 3. Process attachments
    if (attachments && attachments.length > 0) {
      for (const asset of attachments) {
        try {
          await this.uploadAttachment(taskId, asset.url, asset.filename);
          await sleep(800); // Throttling
        } catch (err) {
          console.error(`Failed to upload attachment ${asset.filename} to ClickUp:`, err);
        }
      }
    }

    // 4. Create subtasks
    if (subtasks && subtasks.length > 0) {
      for (const subName of subtasks) {
        try {
          await clickupRequest(`/list/${targetResourceId}/task`, this.apiToken, {
            method: "POST",
            body: JSON.stringify({
              name: subName,
              parent: taskId,
              priority: priority ?? 3,
            }),
          });
          await sleep(800); // Throttling
        } catch (err) {
          console.error(`Failed to create subtask ${subName} in ClickUp:`, err);
        }
      }
    }

    return taskId;
  }

  async completeRecord(targetRecordId) {
    await clickupRequest(`/task/${targetRecordId}`, this.apiToken, {
      method: "PUT",
      body: JSON.stringify({ status: "complete" }),
    });
  }

  async testConnection() {
    try {
      await clickupRequest("/user", this.apiToken);
      return true;
    } catch {
      return false;
    }
  }

  formatFieldForClickUp(value, type) {
    if (value === null || value === undefined) return null;
    const stringVal = String(value).trim();
    if (!stringVal) return null;

    const normalizedType = normalizeClickUpFieldType(type);
    switch (normalizedType) {
      case "number":
      case "currency": {
        const parsed = parseFloat(stringVal.replace(/[^0-9.-]/g, ""));
        return isNaN(parsed) ? null : parsed;
      }
      case "date": {
        const parsedDate = new Date(stringVal);
        return isNaN(parsedDate.getTime()) ? null : parsedDate.getTime();
      }
      case "boolean":
      case "checkbox": {
        return stringVal === "true" || stringVal === "1" || value === true;
      }
      default:
        return stringVal;
    }
  }

  async uploadAttachment(taskId, fileUrl, filename) {
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }
    const blob = await response.blob();
    const formData = new FormData();
    formData.append("attachment", blob, filename);

    const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/attachment`, {
      method: "POST",
      headers: { Authorization: this.apiToken },
      body: formData,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ClickUp upload failed (${res.status}): ${text}`);
    }
  }

  async fetchTargets() {
    const lists = [];
    const teamsData = await clickupRequest(`/team`, this.apiToken);
    const teams = teamsData.teams || [];

    for (const team of teams) {
      const spacesData = await clickupRequest(`/team/${team.id}/space`, this.apiToken);
      const spaces = spacesData.spaces || [];
      for (const space of spaces) {
        // Folderless lists
        const spaceListData = await clickupRequest(`/space/${space.id}/list`, this.apiToken);
        const spaceLists = spaceListData.lists || [];
        for (const list of spaceLists) {
          lists.push({ id: list.id, name: `${space.name} / ${list.name}` });
        }
        // Lists inside folders
        const foldersData = await clickupRequest(`/space/${space.id}/folder`, this.apiToken);
        const folders = foldersData.folders || [];
        for (const folder of folders) {
          const folderListData = await clickupRequest(`/folder/${folder.id}/list`, this.apiToken);
          const folderLists = folderListData.lists || [];
          for (const list of folderLists) {
            lists.push({
              id: list.id,
              name: `${space.name} / ${folder.name} / ${list.name}`,
            });
          }
        }
      }
    }
    return lists;
  }

  async fetchFields(targetResourceId) {
    const data = await clickupRequest(`/list/${targetResourceId}/field`, this.apiToken);
    const fields = data.fields || [];
    return fields.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
    }));
  }
}


/**
 * Monday.com Integration Adapter
 */
export class MondayAdapter extends IntegrationAdapter {
  constructor(apiToken) {
    super();
    this.apiToken = apiToken;
    this.endpoint = "https://api.monday.com/v2";
  }

  async graphql(query, variables = {}) {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: this.apiToken,
        "Content-Type": "application/json",
        "API-Version": "2024-04",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Monday API GraphQL failed (${res.status}): ${body}`);
    }

    const data = await res.json();
    if (data.errors) {
      throw new Error(`Monday GraphQL error: ${JSON.stringify(data.errors)}`);
    }
    return data.data;
  }

  formatFieldForMonday(value, type) {
    if (value === null || value === undefined) return null;
    const stringVal = String(value).trim();
    if (!stringVal) return null;

    const t = String(type || "").toLowerCase();
    if (t === "status" || t === "color") {
      return { label: stringVal };
    } else if (t === "date") {
      const dateObj = new Date(stringVal);
      if (isNaN(dateObj.getTime())) return null;
      return { date: dateObj.toISOString().split("T")[0] };
    } else if (t === "numbers" || t === "numeric" || t === "number") {
      const parsed = parseFloat(stringVal.replace(/[^0-9.-]/g, ""));
      return isNaN(parsed) ? null : String(parsed);
    } else if (t === "email") {
      return { email: stringVal, text: stringVal };
    } else if (t === "phone") {
      return { phone: stringVal, countryShortName: "US" };
    }
    return stringVal;
  }

  async createRecord(targetResourceId, { name, description, rawOrder, customerName, shippingCost, fieldMappings, subtasks, attachments }) {
    // 1. Build column values from mappings
    const columnValues = {};

    let mappings = [];
    try {
      mappings = typeof fieldMappings === "string" ? JSON.parse(fieldMappings) : fieldMappings;
    } catch (e) {
      console.error("Failed to parse Monday mappings in adapter:", e);
    }

    if (Array.isArray(mappings) && mappings.length > 0) {
      const orderValues = extractOrderSourceFields(rawOrder, customerName, shippingCost);
      for (const mapping of mappings) {
        const rawVal = orderValues[mapping.shopifySourceField];
        if (rawVal !== undefined && rawVal !== null && String(rawVal).trim() !== "") {
          const colId = mapping.mondayColumnId || mapping.clickupFieldId;
          const colType = mapping.mondayColumnType || mapping.clickupFieldType || "text";
          columnValues[colId] = this.formatFieldForMonday(rawVal, colType);
        }
      }
    }

    const query = `
      mutation ($boardId: ID!, $itemName: String!, $columnVals: JSON!) {
        create_item (board_id: $boardId, item_name: $itemName, column_values: $columnVals) {
          id
        }
      }
    `;

    const variables = {
      boardId: targetResourceId,
      itemName: name,
      columnVals: JSON.stringify(columnValues),
    };

    // 2. Create Monday item
    const data = await this.graphql(query, variables);
    const itemId = data.create_item.id;

    // 3. Post description as an update (Monday's native comment box)
    if (description) {
      const updateQuery = `
        mutation ($itemId: ID!, $body: String!) {
          create_update (item_id: $itemId, body: $body) {
            id
          }
        }
      `;
      try {
        await this.graphql(updateQuery, { itemId, body: description });
        await sleep(800);
      } catch (err) {
        console.error("Failed to write Monday item update comment:", err);
      }
    }

    // 4. Create sub-items (subtasks)
    if (subtasks && subtasks.length > 0) {
      const subQuery = `
        mutation ($parentId: ID!, $itemName: String!) {
          create_subitem (parent_item_id: $parentId, item_name: $itemName) {
            id
          }
        }
      `;
      for (const subName of subtasks) {
        try {
          await this.graphql(subQuery, { parentId: itemId, itemName: subName });
          await sleep(800);
        } catch (err) {
          console.error(`Failed to create Monday subitem ${subName}:`, err);
        }
      }
    }

    // 5. Upload files (links written to updates/comments box)
    if (attachments && attachments.length > 0) {
      let linksText = "🎨 **Production Assets:**\n";
      for (const asset of attachments) {
        linksText += `• [${asset.filename}](${asset.url})\n`;
      }
      try {
        await this.graphql(`
          mutation ($itemId: ID!, $body: String!) {
            create_update (item_id: $itemId, body: $body) {
              id
            }
          }
        `, { itemId, body: linksText });
        await sleep(800);
      } catch (err) {
        console.error("Failed to append asset links updates to Monday:", err);
      }
    }

    return itemId;
  }

  async completeRecord(targetRecordId) {
    const query = `
      mutation ($itemId: ID!, $columnVals: JSON!) {
        change_multiple_column_values (item_id: $itemId, column_values: $columnVals) {
          id
        }
      }
    `;
    const variables = {
      itemId: targetRecordId,
      columnVals: JSON.stringify({ status: { label: "Done" } }),
    };
    try {
      await this.graphql(query, variables);
    } catch (err) {
      console.warn("Monday status set failed (custom status column may not be named 'status'). Falling back to update comment.");
      await this.graphql(`
        mutation ($itemId: ID!, $body: String!) {
          create_update (item_id: $itemId, body: $body) {
            id
          }
        }
      `, { itemId: targetRecordId, body: "✅ Order has been FULFILLED in Shopify." });
    }
  }

  async fetchTargets() {
    const query = `
      query {
        boards (limit: 100) {
          id
          name
        }
      }
    `;
    const data = await this.graphql(query);
    const boards = data.boards || [];
    return boards.map((b) => ({ id: b.id, name: b.name }));
  }

  async fetchFields(targetResourceId) {
    const query = `
      query ($boardId: [ID!]) {
        boards (ids: $boardId) {
          columns {
            id
            title
            type
          }
        }
      }
    `;
    const data = await this.graphql(query, { boardId: [targetResourceId] });
    const board = data.boards?.[0];
    const columns = board?.columns || [];
    return columns.map((c) => ({
      id: c.id,
      name: c.title,
      type: c.type,
    }));
  }
}


/**
 * Notion Integration Adapter
 */
export class NotionAdapter extends IntegrationAdapter {
  constructor(apiToken) {
    super();
    this.apiToken = apiToken;
    this.baseUrl = "https://api.notion.com/v1";
  }

  async notionFetch(endpoint, options = {}) {
    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Notion API failed at ${endpoint} (${res.status}): ${body}`);
    }
    return res.json();
  }

  async createRecord(targetResourceId, { name, description, rawOrder, customerName, shippingCost, fieldMappings, subtasks, attachments }) {
    const properties = {
      Name: {
        title: [
          { text: { content: name } },
        ],
      },
    };

    let mappings = [];
    try {
      mappings = typeof fieldMappings === "string" ? JSON.parse(fieldMappings) : fieldMappings;
    } catch (e) {
      console.error("Failed to parse Notion mappings in adapter:", e);
    }

    if (Array.isArray(mappings) && mappings.length > 0) {
      const orderValues = extractOrderSourceFields(rawOrder, customerName, shippingCost);
      for (const mapping of mappings) {
        const rawVal = orderValues[mapping.shopifySourceField];
        if (rawVal !== undefined && rawVal !== null && String(rawVal).trim() !== "") {
          const propId = mapping.notionPropertyId || mapping.clickupFieldId;
          const type = (mapping.notionPropertyType || "rich_text").toLowerCase();
          if (type === "number") {
            properties[propId] = { number: parseFloat(String(rawVal).replace(/[^0-9.-]/g, "")) };
          } else if (type === "email") {
            properties[propId] = { email: String(rawVal) };
          } else if (type === "phone_number") {
            properties[propId] = { phone_number: String(rawVal) };
          } else if (type === "url") {
            properties[propId] = { url: String(rawVal) };
          } else if (type === "checkbox") {
            properties[propId] = { checkbox: rawVal === "true" || rawVal === "1" || rawVal === true };
          } else {
            properties[propId] = { rich_text: [{ text: { content: String(rawVal) } }] };
          }
        }
      }
    }

    const children = [];
    if (description) {
      const descLines = description.split("\n");
      for (const line of descLines) {
        if (line.trim() !== "") {
          children.push({
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ text: { content: line } }],
            },
          });
        }
      }
    }

    const page = await this.notionFetch("/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { database_id: targetResourceId },
        properties,
        children: children.length > 0 ? children.slice(0, 100) : undefined,
      }),
    });

    const pageId = page.id;

    if (subtasks && subtasks.length > 0) {
      const subBlocks = subtasks.map((subName) => ({
        object: "block",
        type: "to_do",
        to_do: {
          rich_text: [{ text: { content: subName } }],
          checked: false,
        },
      }));

      try {
        await this.notionFetch(`/blocks/${pageId}/children`, {
          method: "PATCH",
          body: JSON.stringify({ children: subBlocks }),
        });
        await sleep(800);
      } catch (err) {
        console.error("Failed to append subtasks to Notion page:", err);
      }
    }

    if (attachments && attachments.length > 0) {
      const assetBlocks = [
        {
          object: "block",
          type: "heading_3",
          heading_3: {
            rich_text: [{ text: { content: "🎨 Production Assets" } }],
          },
        },
      ];
      for (const asset of attachments) {
        assetBlocks.push({
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                text: {
                  content: `🔗 ${asset.filename}`,
                  link: { url: asset.url },
                },
              },
            ],
          },
        });
      }

      try {
        await this.notionFetch(`/blocks/${pageId}/children`, {
          method: "PATCH",
          body: JSON.stringify({ children: assetBlocks }),
        });
        await sleep(800);
      } catch (err) {
        console.error("Failed to append files block to Notion:", err);
      }
    }

    return pageId;
  }

  async completeRecord(targetRecordId) {
    try {
      await this.notionFetch(`/pages/${targetRecordId}`, {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            Status: {
              select: { name: "Done" },
            },
          },
        }),
      });
    } catch (err) {
      console.warn("Notion Status column set failed. Appending completion note instead.");
      await this.notionFetch(`/blocks/${targetRecordId}/children`, {
        method: "PATCH",
        body: JSON.stringify({
          children: [
            {
              object: "block",
              type: "paragraph",
              paragraph: {
                rich_text: [{ text: { content: "✅ Order has been FULFILLED in Shopify.", annotations: { bold: true, color: "green" } } }],
              },
            },
          ],
        }),
      });
    }
  }

  async fetchTargets() {
    const data = await this.notionFetch("/search", {
      method: "POST",
      body: JSON.stringify({
        filter: {
          value: "database",
          property: "object",
        },
      }),
    });
    const results = data.results || [];
    return results.map((db) => {
      const titleObj = db.title || [];
      const name = titleObj.map((t) => t.plain_text).join("") || "Unnamed Database";
      return { id: db.id, name };
    });
  }

  async fetchFields(targetResourceId) {
    const db = await this.notionFetch(`/databases/${targetResourceId}`, {
      method: "GET",
    });
    const properties = db.properties || {};
    return Object.entries(properties).map(([propName, propDef]) => ({
      id: propName,
      name: propName,
      type: propDef.type,
    }));
  }
}

```

---

## File: [app/adapters/factory.js](file:///c:/Users/zainm/syncup-for-clickup/app/adapters/factory.js)

```javascript
import { decryptToken } from "../crypto.server.js";
import { ClickUpAdapter, MondayAdapter, NotionAdapter } from "./core.js";

export class IntegrationFactory {
  /**
   * Instantiates an operational adapter class based on the provider config.
   * @param {string} provider CLICKUP, MONDAY, or NOTION.
   * @param {string} encryptedAccessToken Encrypted OAuth or API token.
   * @returns {Promise<IntegrationAdapter>} The platform adapter instance.
   */
  static async getAdapter(provider, encryptedAccessToken) {
    if (!encryptedAccessToken) {
      throw new Error(`Access token missing for provider: ${provider}`);
    }
    const decryptedToken = await decryptToken(encryptedAccessToken);
    if (!decryptedToken) {
      throw new Error(`Failed to decrypt access token for provider: ${provider}`);
    }

    const p = String(provider).toUpperCase();
    switch (p) {
      case "CLICKUP":
        return new ClickUpAdapter(decryptedToken);
      case "MONDAY":
        return new MondayAdapter(decryptedToken);
      case "NOTION":
        return new NotionAdapter(decryptedToken);
      default:
        throw new Error(`Unsupported integration provider value: ${provider}`);
    }
  }
}
```

---

## File: [app/billing.server.js](file:///c:/Users/zainm/syncup-for-clickup/app/billing.server.js)

```javascript
import prisma from "./db.server";
import { PLANS } from "./plans";
export { PLANS };

function isNewMonth(date) {
  if (!date) return false;
  const now = new Date();
  const d = new Date(date);
  return (
    now.getMonth() !== d.getMonth() || now.getFullYear() !== d.getFullYear()
  );
}

async function logActivity(shop, eventType, description) {
  await prisma.activityLog
    .create({ data: { shopDomain: shop, eventType, description } })
    .catch((e) => console.error("Billing logActivity failed:", e));
}

export async function getOrCreateSubscription(shop) {
  let sub = await prisma.subscription.findUnique({
    where: { shopDomain: shop },
  });

  if (!sub) {
    const trialStart = new Date();
    const trialEnd = new Date(trialStart.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 days trial duration
    sub = await prisma.subscription.create({
      data: {
        shopDomain: shop,
        planName: "trial",
        trialStartDate: trialStart,
        trialEndDate: trialEnd,
        isTrialActive: true,
        status: "active",
        twoWaySyncEnabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await logActivity(shop, "trial_started", "14-day free trial started");
    return sub;
  }

  // Handle monthly resetting of sync count for active subscriptions
  if (sub.billingCycleStart && isNewMonth(sub.billingCycleStart)) {
    sub = await prisma.subscription.update({
      where: { shopDomain: shop },
      data: { ordersSyncedThisMonth: 0, billingCycleStart: new Date() },
    });
  }

  // Also verify if trial has expired and transition state
  if (sub.planName === "trial" && sub.status === "active") {
    const now = new Date();
    if (now > sub.trialEndDate) {
      try {
        const { handleDowngradeToListLimit } = await import("./clickup.server");
        await handleDowngradeToListLimit(shop, 1);
      } catch (e) {
        console.error("Failed to trim lists on trial end:", e);
      }

      sub = await prisma.subscription.update({
        where: { shopDomain: shop },
        data: {
          planName: "free",
          status: "active",
          isTrialActive: false,
          billingCycleStart: now,
          ordersSyncedThisMonth: 0,
        },
      });
      await logActivity(shop, "trial_expired", "Free trial expired; transitioned to Free Plan (5 orders/mo limit)");
    }
  }

  return sub;
}

export async function incrementOrderCount(shop) {
  await prisma.subscription.update({
    where: { shopDomain: shop },
    data: {
      ordersSyncedThisMonth: { increment: 1 },
      ordersSyncedAllTime: { increment: 1 },
    },
  });
}

export function isSubscriptionActive(subscription) {
  if (
    subscription.status === "paused" ||
    subscription.status === "expired" ||
    subscription.status === "cancelled" ||
    subscription.planName === "expired" ||
    subscription.planName === "cancelled"
  ) {
    return false;
  }
  if (subscription.planName === "trial") {
    const now = new Date();
    if (now > new Date(subscription.trialEndDate)) {
      return false;
    }
  } else {
    const plan = PLANS[subscription.planName];
    if (plan && plan.monthlyOrderLimit !== null) {
      if (subscription.ordersSyncedThisMonth >= plan.monthlyOrderLimit) {
        return false;
      }
    }
  }
  return true;
}

export function getTrialBannerStatus(subscription) {
  if (!subscription) return null;

  if (subscription.planName === "free") {
    const plan = PLANS.free;
    if (subscription.ordersSyncedThisMonth >= plan.monthlyOrderLimit) {
      return {
        expired: true,
        color: "red",
        message: `Monthly order limit reached (${subscription.ordersSyncedThisMonth}/${plan.monthlyOrderLimit} orders synced). Upgrade to keep syncing.`,
      };
    }
    return {
      expired: false,
      color: "green",
      message: `Free Plan active — ${subscription.ordersSyncedThisMonth}/${plan.monthlyOrderLimit} orders synced this month.`,
    };
  }

  // Check paid plan monthly order limits
  if (subscription.planName !== "trial" && subscription.planName !== "expired" && subscription.planName !== "cancelled") {
    const plan = PLANS[subscription.planName];
    if (plan && plan.monthlyOrderLimit !== null) {
      if (subscription.ordersSyncedThisMonth >= plan.monthlyOrderLimit) {
        return {
          expired: true,
          color: "red",
          message: `Monthly order limit reached (${subscription.ordersSyncedThisMonth}/${plan.monthlyOrderLimit} orders synced). Upgrade to keep syncing.`,
        };
      }
    }
  }

  if (
    subscription.status === "expired" ||
    subscription.planName === "expired" ||
    subscription.status === "cancelled" ||
    subscription.planName === "cancelled"
  ) {
    return {
      expired: true,
      color: "red",
      message: "Syncing is paused — upgrade to resume",
    };
  }

  if (subscription.planName !== "trial") return null;

  const now = new Date();
  const trialStart = new Date(subscription.trialStartDate);
  const trialEnd = new Date(subscription.trialEndDate);

  if (now > trialEnd) {
    return {
      expired: true,
      color: "red",
      message: "Syncing is paused — upgrade to resume",
    };
  }

  const msRemaining = trialEnd.getTime() - now.getTime();
  const hoursRemaining = msRemaining / (1000 * 60 * 60);

  if (hoursRemaining <= 24) {
    return {
      expired: false,
      color: "red",
      message: "Your free trial expires today.",
    };
  } else if (hoursRemaining <= 48) {
    return {
      expired: false,
      color: "orange",
      message: "Your free trial ends tomorrow.",
    };
  } else if (hoursRemaining <= 72) {
    return {
      expired: false,
      color: "yellow",
      message: "Your free trial ends in 2 days. Choose a plan to keep syncing.",
    };
  } else {
    const days = Math.ceil(hoursRemaining / 24);
    return {
      expired: false,
      color: "green",
      message: `Trial active — ${days} days remaining`,
    };
  }
}

export async function createShopifySubscription(admin, shop, planKey) {
  const plan = PLANS[planKey];
  if (!plan) throw new Error("Plan not found");

  const activePaidCount = await prisma.subscription.count({
    where: {
      planName: {
        notIn: ["trial", "free", "expired", "cancelled"],
      },
      shopDomain: {
        not: "syncup-test-store.myshopify.com",
      },
    },
  });
  const isPromoActive = activePaidCount < 10;
  
  let chargedPrice = plan.price;
  if (!isPromoActive && planKey !== "free") {
    chargedPrice = plan.regularPrice || plan.price;
  }

  const returnUrl = `${process.env.SHOPIFY_APP_URL}/app/billing?activated=${planKey}`;
  const interval = plan.interval; // ANNUAL or EVERY_30_DAYS

  const res = await admin.graphql(
    `#graphql
    mutation CreateSubscription(
      $name: String!
      $lineItems: [AppSubscriptionLineItemInput!]!
      $returnUrl: URL!
      $test: Boolean
      $replacementBehavior: AppSubscriptionReplacementBehavior
    ) {
      appSubscriptionCreate(
        name: $name
        lineItems: $lineItems
        returnUrl: $returnUrl
        test: $test
        replacementBehavior: $replacementBehavior
      ) {
        appSubscription {
          id
          status
        }
        confirmationUrl
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        name: plan.shopifyPlanName,
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: { amount: parseFloat(chargedPrice.toFixed(2)), currencyCode: "USD" },
                interval: interval,
              },
            },
          },
        ],
        returnUrl,
        // Use real charges in production. Set SHOPIFY_BILLING_TEST=true in .env for local sandbox testing.
        test: process.env.SHOPIFY_BILLING_TEST === "true",
        replacementBehavior: "APPLY_IMMEDIATELY",
      },
    }
  );

  const { data } = await res.json();
  const result = data?.appSubscriptionCreate;

  if (result?.userErrors?.length > 0) {
    throw new Error(result.userErrors.map((e) => e.message).join(", "));
  }

  return {
    confirmationUrl: result.confirmationUrl,
    chargeId: result.appSubscription?.id,
  };
}

export async function cancelExistingSubscription(admin, chargeId) {
  if (!chargeId) return;
  try {
    await admin.graphql(
      `#graphql
      mutation CancelSubscription($id: ID!) {
        appSubscriptionCancel(id: $id) {
          appSubscription { id status }
          userErrors { field message }
        }
      }`,
      { variables: { id: chargeId } }
    );
  } catch (e) {
    console.error("Error cancelling Shopify subscription:", e);
  }
}

export async function activateSubscription(shop, planKey, chargeId) {
  const plan = PLANS[planKey];
  const now = new Date();

  return prisma.subscription.upsert({
    where: { shopDomain: shop },
    update: {
      planName: planKey,
      shopifyChargeId: chargeId,
      shopifyChargeStatus: "active",
      isTrialActive: false,
      status: "active",
      billingCycleStart: now,
      annualBilling: plan.annual,
    },
    create: {
      shopDomain: shop,
      planName: planKey,
      shopifyChargeId: chargeId,
      shopifyChargeStatus: "active",
      isTrialActive: false,
      status: "active",
      billingCycleStart: now,
      annualBilling: plan.annual,
      trialStartDate: now,
      trialEndDate: now,
    },
  });
}

export async function downgradeToFree(shop) {
  try {
    const { handleDowngradeToListLimit } = await import("./clickup.server");
    await handleDowngradeToListLimit(shop, 1);
  } catch (e) {
    console.error("Failed to trim lists on downgrade to free:", e);
  }

  return prisma.subscription.update({
    where: { shopDomain: shop },
    data: {
      planName: "free",
      shopifyChargeId: null,
      shopifyChargeStatus: null,
      status: "active",
      billingCycleStart: new Date(),
      ordersSyncedThisMonth: 0,
      subtasksEnabled: false,
      twoWaySyncEnabled: false,
      taskDescriptionTemplate: null,
    },
  });
}
```

---

## File: [app/clickup.server.js](file:///c:/Users/zainm/syncup-for-clickup/app/clickup.server.js)

```javascript
import prisma from "./db.server";
import { encryptToken, decryptToken } from "./crypto.server";


// Fallback used only when the orders/create webhook payload arrives without a
// customer name (e.g. before protected-customer-data fields were granted, or
// for guest-ish edge cases). Looks the customer up via the Admin API.
export async function fetchShopifyCustomer(shop, customerId) {
  if (!customerId) return null;
  const session = await prisma.session.findFirst({
    where: { shop, isOnline: false },
    select: { accessToken: true },
  });
  if (!session?.accessToken) return null;
  try {
    const res = await fetch(
      `https://${shop}/admin/api/2026-07/customers/${customerId}.json`,
      { headers: { "X-Shopify-Access-Token": session.accessToken } }
    );
    if (!res.ok) return null;
    const { customer } = await res.json();
    return customer ?? null;
  } catch {
    return null;
  }
}

// ClickUp OAuth + API endpoints (see https://clickup.com/api).
const CLICKUP_AUTHORIZE_URL = "https://app.clickup.com/api";
const CLICKUP_TOKEN_URL = "https://api.clickup.com/api/v2/oauth/token";
const CLICKUP_API_BASE = "https://api.clickup.com/api/v2";

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export function getClickUpAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.CLICKUP_CLIENT_ID || "",
    // ClickUp strips paths from redirect URIs — must use bare origin.
    redirect_uri: process.env.SHOPIFY_APP_URL || "",
    // `state` is an HMAC-signed token (see oauth-state.server.js) that binds
    // this flow to one authenticated shop — never the raw shop domain.
    state,
  });
  return `${CLICKUP_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeClickUpCode(code) {
  const params = new URLSearchParams({
    client_id: process.env.CLICKUP_CLIENT_ID || "",
    client_secret: process.env.CLICKUP_CLIENT_SECRET || "",
    code,
    redirect_uri: process.env.SHOPIFY_APP_URL || "",
  });

  const response = await fetch(`${CLICKUP_TOKEN_URL}?${params.toString()}`, {
    method: "POST",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `ClickUp token exchange failed (${response.status}): ${body}`
    );
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error("ClickUp token exchange did not return an access_token");
  }
  return data.access_token;
}

// ---------------------------------------------------------------------------
// ClickUp REST API helpers
// ClickUp expects the access token directly in the Authorization header
// (no "Bearer " prefix).
// ---------------------------------------------------------------------------

async function clickupRequest(path, token, options = {}) {
  const response = await fetch(`${CLICKUP_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `ClickUp ${options.method || "GET"} ${path} failed (${response.status}): ${body}`
    );
  }

  return response.json();
}

// Retry once after a short delay. Webhook handlers need to stay under 5s,
// so we use a 1-second backoff rather than the full 5s called for in spec.
export async function withRetry(fn, retries = 1, delayMs = 1000) {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((r) => setTimeout(r, delayMs));
    return withRetry(fn, retries - 1, delayMs);
  }
}

/** GET /team — the workspaces (teams) the connected user can access. */
export async function getTeams(token) {
  const data = await clickupRequest(`/team`, token);
  return data.teams || [];
}

/** GET /team/{team_id}/space */
export async function getSpaces(token, teamId) {
  const data = await clickupRequest(`/team/${teamId}/space`, token);
  return data.spaces || [];
}

/** GET /space/{space_id}/folder */
async function getFolders(token, spaceId) {
  const data = await clickupRequest(`/space/${spaceId}/folder`, token);
  return data.folders || [];
}

/** GET /space/{space_id}/list — folderless lists inside a space. */
async function getSpaceLists(token, spaceId) {
  const data = await clickupRequest(`/space/${spaceId}/list`, token);
  return data.lists || [];
}

/** GET /folder/{folder_id}/list — lists inside a folder. */
async function getFolderLists(token, folderId) {
  const data = await clickupRequest(`/folder/${folderId}/list`, token);
  return data.lists || [];
}

/**
 * Walk every workspace → space → folder → list (and folderless lists) and
 * return a flat array of objects { id, name } the merchant can sync into.
 * Each name is prefixed with its path so duplicates are distinguishable.
 */
export async function getAllLists(token) {
  const lists = [];
  const teams = await getTeams(token);

  for (const team of teams) {
    const spaces = await getSpaces(token, team.id);
    for (const space of spaces) {
      // Folderless lists
      const spaceListItems = await getSpaceLists(token, space.id);
      for (const list of spaceListItems) {
        lists.push({ id: list.id, name: `${space.name} / ${list.name}` });
      }
      // Lists inside folders
      const folders = await getFolders(token, space.id);
      for (const folder of folders) {
        const folderLists = await getFolderLists(token, folder.id);
        for (const list of folderLists) {
          lists.push({
            id: list.id,
            name: `${space.name} / ${folder.name} / ${list.name}`,
          });
        }
      }
    }
  }

  return lists;
}

/** POST /list/{list_id}/task — create a task in the chosen list. */
export async function createTask(token, listId, { name, description, priority, startDate, dueDate, tags }) {
  const body = { name, description };
  if (priority !== undefined) body.priority = priority;
  if (startDate !== undefined) body.start_date = startDate;
  if (dueDate !== undefined) body.due_date = dueDate;
  if (tags !== undefined) body.tags = tags;

  return clickupRequest(`/list/${listId}/task`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** PUT /task/{task_id} — mark a task complete. */
export async function completeTask(token, taskId) {
  return clickupRequest(`/task/${taskId}`, token, {
    method: "PUT",
    body: JSON.stringify({ status: "complete" }),
  });
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Connection / Session helpers
// ---------------------------------------------------------------------------

export async function getConnection(shop) {
  const conn = await prisma.platformConnection.findFirst({
    where: { shopDomain: shop, isActive: true },
    include: {
      clickUpMetadata: true,
      mondayMetadata: true,
      notionMetadata: true,
      syncTargets: { where: { isActive: true } },
    },
  });
  if (!conn) return null;
  const accessToken = await decryptToken(conn.encryptedAccessToken);
  if (!accessToken) return null;

  const listConnections = conn.syncTargets.map((t) => ({
    id: t.targetResourceId,
    name: t.targetResourceName,
    keyword: t.keyword || "",
    routingLocationId: t.routingLocationId || null,
    routingTag: t.routingTag || null,
  }));

  let metadata = null;
  if (conn.provider === "CLICKUP") metadata = conn.clickUpMetadata;
  else if (conn.provider === "MONDAY") metadata = conn.mondayMetadata;
  else if (conn.provider === "NOTION") metadata = conn.notionMetadata;

  return {
    id: conn.id,
    shopDomain: conn.shopDomain,
    accessToken,
    selectedPlatform: conn.provider.toLowerCase(),
    workspaceName: metadata?.workspaceName || (conn.provider === "CLICKUP" ? "ClickUp Workspace" : conn.provider === "MONDAY" ? "Monday.com Workspace" : "Notion Workspace"),
    listId: listConnections[0]?.id || null,
    listName: listConnections[0]?.name || null,
    listConnections,
    fieldMappings: metadata?.fieldMappings || "[]",
    isFreePlan: metadata?.isFreePlan || false,
    healthStatus: conn.healthStatus || "healthy",
    lastHealthCheck: conn.lastHealthCheck,
  };
}

export async function getAllConnections(shop) {
  const conns = await prisma.platformConnection.findMany({
    where: { shopDomain: shop, isActive: true },
    include: {
      clickUpMetadata: true,
      mondayMetadata: true,
      notionMetadata: true,
      syncTargets: { where: { isActive: true } },
    },
  });

  const results = [];
  for (const conn of conns) {
    const accessToken = await decryptToken(conn.encryptedAccessToken);
    if (!accessToken) continue;

    const listConnections = conn.syncTargets.map((t) => ({
      id: t.targetResourceId,
      name: t.targetResourceName,
      keyword: t.keyword || "",
      routingLocationId: t.routingLocationId || null,
      routingTag: t.routingTag || null,
    }));

    let metadata = null;
    if (conn.provider === "CLICKUP") metadata = conn.clickUpMetadata;
    else if (conn.provider === "MONDAY") metadata = conn.mondayMetadata;
    else if (conn.provider === "NOTION") metadata = conn.notionMetadata;

    results.push({
      id: conn.id,
      shopDomain: conn.shopDomain,
      accessToken,
      selectedPlatform: conn.provider.toLowerCase(),
      workspaceName: metadata?.workspaceName || (conn.provider === "CLICKUP" ? "ClickUp Workspace" : conn.provider === "MONDAY" ? "Monday.com Workspace" : "Notion Workspace"),
      listId: listConnections[0]?.id || null,
      listName: listConnections[0]?.name || null,
      listConnections,
      fieldMappings: metadata?.fieldMappings || "[]",
      isFreePlan: metadata?.isFreePlan || false,
      healthStatus: conn.healthStatus || "healthy",
      lastHealthCheck: conn.lastHealthCheck,
    });
  }
  return results;
}

export async function saveToken(shop, accessToken, workspaceName = null, isFreePlan = false) {
  const encryptedToken = await encryptToken(accessToken);

  const conn = await prisma.platformConnection.upsert({
    where: {
      shopDomain_provider: {
        shopDomain: shop,
        provider: "CLICKUP"
      }
    },
    update: {
      encryptedAccessToken: encryptedToken,
      isActive: true
    },
    create: {
      shopDomain: shop,
      provider: "CLICKUP",
      encryptedAccessToken: encryptedToken,
      isActive: true
    }
  });

  await prisma.clickUpMetadata.upsert({
    where: { connectionId: conn.id },
    update: {
      workspaceId: "migrated_workspace",
      workspaceName: workspaceName || "ClickUp Workspace",
      isFreePlan: isFreePlan
    },
    create: {
      connectionId: conn.id,
      workspaceId: "migrated_workspace",
      workspaceName: workspaceName || "ClickUp Workspace",
      isFreePlan: isFreePlan
    }
  });

  return conn;
}

export async function saveListConnections(shop, listConnections) {
  const activeConn = await prisma.platformConnection.findFirst({
    where: { shopDomain: shop, isActive: true },
  });

  if (!activeConn) {
    throw new Error("No active connection found for this shop");
  }

  const decryptedToken = await decryptToken(activeConn.encryptedAccessToken);

  const incomingIds = listConnections.map((c) => c.id).filter(Boolean);
  await prisma.syncTarget.updateMany({
    where: {
      connectionId: activeConn.id,
      targetResourceId: { notIn: incomingIds },
    },
    data: { isActive: false },
  });

  for (const target of listConnections) {
    if (target.id) {
      await prisma.syncTarget.upsert({
        where: {
          connectionId_targetResourceId: {
            connectionId: activeConn.id,
            targetResourceId: target.id,
          },
        },
        update: {
          targetResourceName: target.name || "",
          keyword: target.keyword || null,
          routingLocationId: target.routingLocationId || null,
          routingTag: target.routingTag || null,
          isActive: true,
        },
        create: {
          connectionId: activeConn.id,
          targetResourceId: target.id,
          targetResourceName: target.name || "",
          keyword: target.keyword || null,
          routingLocationId: target.routingLocationId || null,
          routingTag: target.routingTag || null,
          isActive: true,
        },
      });
    }
  }

  if (activeConn.provider === "CLICKUP") {
    try {
      await registerClickUpWebhook(shop, decryptedToken);
    } catch (err) {
      console.error("Failed to register ClickUp webhook on connection save:", err);
    }
  } else if (activeConn.provider === "MONDAY") {
    for (const target of listConnections) {
      if (target.id) {
        try {
          await registerMondayWebhook(target.id, decryptedToken);
        } catch (err) {
          console.error(`Failed to register Monday webhook on board ${target.id} on save:`, err);
        }
      }
    }
  }

  return activeConn;
}

export async function handleDowngradeToListLimit(shop, listLimit = 1) {
  const activeConn = await prisma.platformConnection.findFirst({
    where: { shopDomain: shop, isActive: true },
    include: { syncTargets: { where: { isActive: true }, orderBy: { createdAt: "asc" } } }
  });
  if (!activeConn) return null;

  const activeTargets = activeConn.syncTargets;
  if (activeTargets.length > listLimit) {
    const removed = activeTargets.slice(listLimit);
    const removedNames = removed.map((c) => c.targetResourceName).join(", ");

    const removedIds = removed.map((c) => c.id);
    await prisma.syncTarget.updateMany({
      where: { id: { in: removedIds } },
      data: { isActive: false }
    });

    logActivity(
      shop,
      "plan_cancelled",
      `Plan limit check: kept ${listLimit} list/board/database(s). Removed extra connections: ${removedNames}`
    );

    return removedNames;
  }
  return null;
}

export async function disconnect(shop) {
  return prisma.platformConnection.deleteMany({ where: { shopDomain: shop } });
}

/**
 * Schedules a fulfillment retry by marking the OrderSyncRecord status as "retrying".
 *
 * NOTE: The previous implementation used setTimeout(), which is silently killed when a
 * Vercel serverless function finishes responding. This durable approach instead marks the
 * record as "retrying" in the database. The next time Shopify fires an orders/updated
 * webhook for this order (which happens multiple times during the fulfillment lifecycle),
 * the handler will find the record in "retrying" state and attempt completion again.
 */
export async function scheduleFulfillmentRetry(shop, shopifyOrderId, clickupTaskId, orderNumber) {
  try {
    await prisma.orderSyncRecord.updateMany({
      where: { shopDomain: shop, shopifyOrderId },
      data: { syncStatus: "retrying" },
    });
    console.log(`Marked order ${shopifyOrderId} for retry on next Shopify webhook fire.`);
  } catch (err) {
    console.error(`Failed to mark order ${shopifyOrderId} as retrying:`, err);
    // Fall back to logging the failure so the merchant can see it in the activity feed
    logActivity(
      shop,
      "sync_failed",
      `Order #${orderNumber} fulfillment sync failed and could not be scheduled for retry: ${err.message}`,
      shopifyOrderId,
      clickupTaskId
    );
  }
}



// ---------------------------------------------------------------------------
// Activity log — fire-and-forget, never blocks callers
// ---------------------------------------------------------------------------

export function logActivity(shop, eventType, description, shopifyOrderId = null, clickupTaskId = null) {
  const data = { shopDomain: shop, eventType, description };
  if (shopifyOrderId) data.shopifyOrderId = shopifyOrderId;
  if (clickupTaskId) data.clickupTaskId = clickupTaskId;

  prisma.activityLog
    .create({ data })
    .catch((e) => console.error("logActivity failed:", e));
}

export async function getRecentActivity(shop, limit = 5) {
  return prisma.activityLog.findMany({
    where: { shopDomain: shop },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** GET /list/{list_id}/field — get list custom fields. */
export async function fetchListCustomFields(token, listId) {
  const data = await clickupRequest(`/list/${listId}/field`, token);
  return data.fields || [];
}

/** POST /task/{task_id}/field/{field_id} — set custom field value. */
export async function setCustomFieldValue(token, taskId, fieldId, value) {
  return clickupRequest(`/task/${taskId}/field/${fieldId}`, token, {
    method: "POST",
    body: JSON.stringify({ value }),
  });
}

/** Formats raw Shopify values to ClickUp-safe Custom Field types. */
export function formatFieldValueForClickUp(value, type) {
  if (value === null || value === undefined) return null;
  const stringVal = String(value).trim();
  if (!stringVal) return null;

  switch (type.toLowerCase()) {
    case "number":
    case "currency": {
      const parsed = parseFloat(stringVal.replace(/[^0-9.-]/g, ""));
      return isNaN(parsed) ? null : parsed;
    }
    case "date": {
      const parsedDate = new Date(stringVal);
      return isNaN(parsedDate.getTime()) ? null : parsedDate.getTime();
    }
    case "boolean":
    case "checkbox": {
      return stringVal === "true" || stringVal === "1" || value === true;
    }
    default:
      return stringVal;
  }
}

/** Formats mapped Shopify attributes into a clean Markdown table. */
export function compileMarkdownTable(order, mappings, customerName, orderNumber) {
  const tableLines = [];
  tableLines.push("");
  tableLines.push("📋 Mapped Order Columns:");
  tableLines.push("| ClickUp Column | Value |");
  tableLines.push("| :--- | :--- |");
  
  const extractVal = (fieldId) => {
    switch (fieldId) {
      case "order_number":
        return orderNumber;
      case "customer_name":
        return customerName;
      case "customer_email":
        return order.customer?.email || order.email || "";
      case "customer_phone":
        return (
          order.customer?.phone ||
          order.billing_address?.phone ||
          order.shipping_address?.phone ||
          ""
        );
      case "total_price":
        return order.total_price || "0.00";
      case "subtotal_price":
        return order.subtotal_price || "0.00";
      case "shipping_price": {
        const shippingCost = order.shipping_lines?.reduce(
          (sum, s) => sum + parseFloat(s.price || "0"),
          0
        );
        return shippingCost !== undefined ? shippingCost.toFixed(2) : "0.00";
      }
      case "shipping_address": {
        const addr = order.shipping_address;
        if (!addr) return "";
        return [
          addr.address1,
          addr.address2,
          addr.city,
          addr.province,
          addr.zip,
          addr.country,
        ]
          .filter(Boolean)
          .join(", ");
      }
      case "order_notes":
        return order.note || "";
      case "created_at":
        return order.created_at || "";
      default:
        return "";
    }
  };

  for (const m of mappings) {
    const rawVal = extractVal(m.shopifySourceField);
    if (rawVal) {
      tableLines.push(`| **${m.clickupFieldName}** | ${rawVal} |`);
    }
  }

  return tableLines.join("\n");
}

/** Queries ClickUp to fetch the active workspace plan name. */
export async function fetchWorkspacePlan(token) {
  try {
    const response = await fetch("https://api.clickup.com/api/v2/team", {
      headers: { Authorization: token }
    });
    if (!response.ok) return "free";
    const data = await response.json();
    const primaryTeam = data.teams?.[0] || null;
    if (primaryTeam) {
      const planVal = primaryTeam.plan;
      const planStr = typeof planVal === "object" && planVal !== null ? planVal.name : planVal;
      return (planStr || "free").toLowerCase();
    }
    return "free";
  } catch (err) {
    console.error("Failed to fetch ClickUp workspace plan:", err);
    return "free";
  }
}

/** Uploads a file via multipart form-data to a ClickUp task's attachments. */
export async function uploadTaskAttachment(token, taskId, fileUrl, filename) {
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download design file: ${response.statusText}`);
  }
  const blob = await response.blob();

  const formData = new FormData();
  formData.append("attachment", blob, filename);

  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/attachment`, {
    method: "POST",
    headers: { Authorization: token },
    body: formData
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ClickUp upload failed (${res.status}): ${body}`);
  }

  return res.json();
}

export async function registerClickUpWebhook(shop, token) {
  try {
    const teams = await getTeams(token);
    if (!teams || teams.length === 0) return null;
    const teamId = teams[0].id;
    
    const appUrl = process.env.SHOPIFY_APP_URL || "https://syncup-for-clickup.vercel.app";
    const endpointUrl = `${appUrl}/api/webhooks/clickup`;
    
    // Check if webhook already exists for this team to avoid duplicates
    let existingWebhooks = [];
    try {
      const resWebhooks = await clickupRequest(`/team/${teamId}/webhook`, token);
      existingWebhooks = resWebhooks.webhooks || [];
    } catch (err) {
      console.warn("Failed to fetch existing ClickUp webhooks:", err.message);
    }
    
    const alreadyExists = existingWebhooks.find(w => w.endpoint === endpointUrl);
    if (alreadyExists) {
      console.log("ClickUp webhook already registered:", alreadyExists.id);
      return alreadyExists.id;
    }
    
    const res = await clickupRequest(`/team/${teamId}/webhook`, token, {
      method: "POST",
      body: JSON.stringify({
        endpoint: endpointUrl,
        events: ["taskStatusUpdated"]
      })
    });
    
    console.log("ClickUp webhook registered successfully:", res.id);
    return res.id;
  } catch (e) {
    console.error("Failed to register ClickUp webhook:", e);
    return null;
  }
}

export async function registerMondayWebhook(boardId, token) {
  try {
    const appUrl = process.env.SHOPIFY_APP_URL || "https://syncup-for-clickup.vercel.app";
    const endpointUrl = `${appUrl}/api/webhooks/monday`;
    
    const query = `
      mutation create_webhook($boardId: ID!, $url: String!) {
        create_webhook(board_id: $boardId, url: $url, event: change_column_value) {
          id
        }
      }
    `;
    const variables = { boardId: String(boardId), url: endpointUrl };
    
    const response = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
        "API-Version": "2024-04"
      },
      body: JSON.stringify({ query, variables })
    });
    
    const data = await response.json();
    if (data.errors) {
      console.warn("Monday webhook registration returned errors:", data.errors);
      return null;
    }
    
    const webhookId = data.data?.create_webhook?.id;
    console.log(`Monday webhook registered on board ${boardId}:`, webhookId);
    return webhookId;
  } catch (e) {
    console.error(`Failed to register Monday webhook on board ${boardId}:`, e);
    return null;
  }
}

```

---

## File: [app/crypto.server.js](file:///c:/Users/zainm/syncup-for-clickup/app/crypto.server.js)

```javascript
/* global globalThis */
// AES-256-GCM encryption using the Web Crypto API (globalThis.crypto.subtle).
// Available in Node.js 19+ and modern browsers — requires no node: imports,
// which avoids Vite's commonjs--resolver flagging this as a server-only module
// during the client build's static analysis phase.

const ALGORITHM = "AES-GCM";
const ENC_PREFIX = "enc:";
const IV_BYTES = 12;

function hexToBytes(hex) {
  const buf = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    buf[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return buf;
}

function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getKeyBytes() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY env var must be a 64-character hex string (32 bytes). " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return hexToBytes(hex);
}

async function importKey() {
  return globalThis.crypto.subtle.importKey(
    "raw",
    getKeyBytes(),
    { name: ALGORITHM },
    false,
    ["encrypt", "decrypt"]
  );
}

// Returns "enc:{ivHex}:{combinedCiphertextAndTagHex}"
export async function encryptToken(plaintext) {
  const key = await importKey();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipherBuf = await globalThis.crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `${ENC_PREFIX}${bytesToHex(iv)}:${bytesToHex(cipherBuf)}`;
}

export async function decryptToken(data) {
  if (!data || !data.startsWith(ENC_PREFIX)) {
    // Legacy plaintext token — return as-is so existing connections keep working.
    return data;
  }
  const parts = data.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 2) {
    // Old 3-part format from previous node:crypto implementation.
    // Can't decrypt without node:crypto; return null to trigger reconnection.
    return null;
  }
  const key = await importKey();
  const iv = hexToBytes(parts[0]);
  const combined = hexToBytes(parts[1]);
  const decrypted = await globalThis.crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    key,
    combined
  );
  return new TextDecoder().decode(decrypted);
}
```

---

## File: [app/db.server.js](file:///c:/Users/zainm/syncup-for-clickup/app/db.server.js)

```javascript
import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

function createClient() {
  const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

let prisma;

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = createClient();
  }
  prisma = global.prismaGlobal;
} else {
  prisma = createClient();
}

export default prisma;
```

---

## File: [app/entry.server.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/entry.server.jsx)

```jsx
import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";

export const streamTimeout = 5000;

export default async function handleRequest(
  request,
  responseStatusCode,
  responseHeaders,
  reactRouterContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);

  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("Referrer-Policy", "strict-origin-when-cross-origin");
  responseHeaders.set("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()");

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  if (shop) {
    const cleanShop = shop.replace(/[^a-zA-Z0-9.-]/g, "");
    responseHeaders.set("X-Frame-Options", `ALLOW-FROM https://${cleanShop}`);
  }
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      },
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
```

---

## File: [app/oauth-state.server.js](file:///c:/Users/zainm/syncup-for-clickup/app/oauth-state.server.js)

```javascript
/* global globalThis */
// Signs and verifies the OAuth `state` parameter for the ClickUp connect flow.
//
// The shop is bound into an HMAC-signed, time-limited token that is minted ONLY
// inside an authenticated request (the app dashboard loader). Both the connect
// initiation and the OAuth callback derive the shop by verifying this token —
// never from a raw, caller-supplied value — so a forged callback cannot attach
// a ClickUp account to another merchant's store.

const STATE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecodeToString(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacHex(message) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw new Error("SHOPIFY_API_SECRET is required to sign OAuth state.");
  }
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );
  return bytesToHex(sig);
}

// Constant-time string comparison to avoid leaking the signature via timing.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/** Mint a signed state token for `shop`. */
export async function signState(shop) {
  const payload = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ shop, ts: Date.now() }))
  );
  const sig = await hmacHex(payload);
  return `${payload}.${sig}`;
}

/** Returns the shop if `state` is a valid, unexpired token we signed; else null. */
export async function verifyState(state) {
  if (!state || typeof state !== "string" || !state.includes(".")) return null;
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;

  const expected = await hmacHex(payload);
  if (!timingSafeEqual(sig, expected)) return null;

  let data;
  try {
    data = JSON.parse(b64urlDecodeToString(payload));
  } catch {
    return null;
  }
  if (!data || typeof data.shop !== "string" || typeof data.ts !== "number") {
    return null;
  }
  if (Date.now() - data.ts > STATE_TTL_MS) return null;

  return data.shop;
}
```

---

## File: [app/plans.js](file:///c:/Users/zainm/syncup-for-clickup/app/plans.js)

```javascript
export const PLANS = {
  free: {
    key: "free",
    name: "Free Plan",
    price: 0,
    interval: "EVERY_30_DAYS",
    shopifyPlanName: "SyncUp Free Plan",
    annual: false,
    listLimit: 1,
    monthlyOrderLimit: 5,
    features: [
      "Up to 5 synced orders / mo",
      "1 ClickUp list connection",
      "Basic order status completion sync",
      "Rich text sync in standard task description body (Note: Subject to ClickUp's native free plan custom field limits)",
    ],
  },
  standard_monthly: {
    key: "standard_monthly",
    name: "Standard Monthly",
    price: 19.99,
    regularPrice: 29.99,
    interval: "EVERY_30_DAYS",
    shopifyPlanName: "SyncUp Standard Monthly",
    annual: false,
    listLimit: 1,
    monthlyOrderLimit: 150,
    features: [
      "Up to 150 synced orders / mo",
      "1 ClickUp list connection",
      "Status auto-completion sync (Shopify fulfillment -> ClickUp complete)",
      "Rich text sync in standard task description body",
    ],
  },
  standard_annual: {
    key: "standard_annual",
    name: "Standard Annual",
    price: 215,
    regularPrice: 323,
    interval: "ANNUAL",
    shopifyPlanName: "SyncUp Standard Annual",
    annual: true,
    listLimit: 1,
    monthlyOrderLimit: 150,
    features: [
      "Up to 150 synced orders / mo",
      "1 ClickUp list connection",
      "Status auto-completion sync (Shopify fulfillment -> ClickUp complete)",
      "Rich text sync in standard task description body",
    ],
  },
  growth_monthly: {
    key: "growth_monthly",
    name: "Growth Monthly",
    price: 39.99,
    regularPrice: 49.99,
    interval: "EVERY_30_DAYS",
    shopifyPlanName: "SyncUp Growth Monthly",
    annual: false,
    listLimit: 5,
    monthlyOrderLimit: null,
    features: [
      "Unlimited synced orders / mo",
      "Up to 5 ClickUp list connections",
      "ClickUp Custom Field Mapping (Map addresses, totals, and emails directly to ClickUp columns)",
      "Smart Multi-List Routing (Route orders based on product SKU, title, or vendor keywords)",
      "Automated error retry queue (Resilient background processing of API limits)",
    ],
  },
  growth_annual: {
    key: "growth_annual",
    name: "Growth Annual",
    price: 431,
    regularPrice: 539,
    interval: "ANNUAL",
    shopifyPlanName: "SyncUp Growth Annual",
    annual: true,
    listLimit: 5,
    monthlyOrderLimit: null,
    features: [
      "Unlimited synced orders / mo",
      "Up to 5 ClickUp list connections",
      "ClickUp Custom Field Mapping (Map addresses, totals, and emails directly to ClickUp columns)",
      "Smart Multi-List Routing (Route orders based on product SKU, title, or vendor keywords)",
      "Automated error retry queue (Resilient background processing of API limits)",
    ],
  },
  pro_monthly: {
    key: "pro_monthly",
    name: "Pro Monthly",
    price: 79.99,
    regularPrice: 99.99,
    interval: "EVERY_30_DAYS",
    shopifyPlanName: "SyncUp Pro Monthly",
    annual: false,
    listLimit: 999,
    monthlyOrderLimit: null,
    features: [
      "Unlimited synced orders / mo",
      "Unlimited ClickUp list connections",
      "Priority real-time webhook processing queue",
      "Priority developer support",
    ],
  },
  pro_annual: {
    key: "pro_annual",
    name: "Pro Annual",
    price: 863,
    regularPrice: 1079,
    interval: "ANNUAL",
    shopifyPlanName: "SyncUp Pro Annual",
    annual: true,
    listLimit: 999,
    monthlyOrderLimit: null,
    features: [
      "Unlimited synced orders / mo",
      "Unlimited ClickUp list connections",
      "Priority real-time webhook processing queue",
      "Priority developer support",
    ],
  },
};

export function getTranslatedFeatures(features, platform = "clickup") {
  if (!platform) platform = "clickup";
  const p = platform.toLowerCase();
  
  return features.map((feat) => {
    let result = feat;
    if (p === "monday") {
      result = result
        .replace(/ClickUp lists/g, "Monday boards")
        .replace(/ClickUp list/g, "Monday board")
        .replace(/ClickUp Custom Field Mapping/g, "Monday Column Mapping")
        .replace(/ClickUp custom field/g, "Monday column")
        .replace(/ClickUp/g, "Monday.com");
    } else if (p === "notion") {
      result = result
        .replace(/ClickUp lists/g, "Notion databases")
        .replace(/ClickUp list/g, "Notion database")
        .replace(/ClickUp Custom Field Mapping/g, "Notion Property Mapping")
        .replace(/ClickUp custom field/g, "Notion property")
        .replace(/ClickUp/g, "Notion");
    }
    return result;
  });
}
```

---

## File: [app/root.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/root.jsx)

```jsx
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from "react-router";

export const loader = async () => {
  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData() || {};

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {apiKey && <meta name="shopify-api-key" content={apiKey} />}
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

```

---

## File: [app/routes/api.jobs.process.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/api.jobs.process.jsx)

```jsx
/* global process */

export const loader = async ({ request }) => {
  return handleJobProcess(request);
};

export const action = async ({ request }) => {
  return handleJobProcess(request);
};

// Helper function to check if order satisfies routing constraints
function satisfiesRoutingConstraints(targetConn, order) {
  // 1. Tag constraint
  if (targetConn.routingTag && targetConn.routingTag.trim()) {
    const tag = targetConn.routingTag.trim().toLowerCase();
    
    // Check order tags (comma separated string)
    const orderTags = order.tags ? order.tags.split(",").map(t => t.trim().toLowerCase()) : [];
    const hasOrderTagMatch = orderTags.includes(tag);
    
    // Check line items product tags if available
    const lineItems = order.line_items || [];
    const hasLineTagMatch = lineItems.some(
      (item) =>
        item.product_tags &&
        String(item.product_tags).toLowerCase().includes(tag)
    );
    
    if (!hasOrderTagMatch && !hasLineTagMatch) return false;
  }

  // 2. Location constraint
  if (targetConn.routingLocationId && targetConn.routingLocationId.trim()) {
    const locId = targetConn.routingLocationId.trim();
    const lineItems = order.line_items || [];
    const hasLocationMatch = lineItems.some(
      (item) => String(item.location_id) === locId
    );
    if (!hasLocationMatch) return false;
  }

  // 3. Keyword constraint (legacy keyword routing)
  if (targetConn.keyword && targetConn.keyword.trim()) {
    const kw = targetConn.keyword.trim().toLowerCase();
    const lineItems = order.line_items || [];
    const hasKeywordMatch = lineItems.some(
      (item) =>
        (item.title && item.title.toLowerCase().includes(kw)) ||
        (item.vendor && item.vendor.toLowerCase().includes(kw)) ||
        (item.sku && item.sku.toLowerCase().includes(kw))
    );
    if (!hasKeywordMatch) return false;
  }

  return true;
}

// Custom safe dependency-free liquid template compiler
function compileLiquidTemplate(template, order, customerName, orderNumber, shippingMethod, itemCount, orderTotal, paymentStatus, adminOrderUrl) {
  if (!template) return "";

  let compiled = template;

  // 1. Pre-process line item loops: {% for item in line_items %} ... {% endfor %}
  const loopRegex = /\{%\s*for\s+(\w+)\s+in\s+line_items\s*%\}([\s\S]*?)\{%\s*endfor\s*%\}/g;
  compiled = compiled.replace(loopRegex, (_, varName, loopContent) => {
    const items = order.line_items || [];
    return items.map((item) => {
      const variant = item.variant_title ? ` (${item.variant_title})` : "";
      const sku = item.sku ? ` [${item.sku}]` : "";
      
      return loopContent
        .replace(new RegExp(`{{\\s*${varName}\\.title\\s*}}`, "g"), item.title || "")
        .replace(new RegExp(`{{\\s*${varName}\\.quantity\\s*}}`, "g"), String(item.quantity || 1))
        .replace(new RegExp(`{{\\s*${varName}\\.sku\\s*}}`, "g"), item.sku || "")
        .replace(new RegExp(`{{\\s*${varName}\\.variant\\s*}}`, "g"), variant)
        .replace(new RegExp(`{{\\s*${varName}\\.price\\s*}}`, "g"), item.price || "0.00");
    }).join("");
  });

  // 2. Resolve global order variables
  const variables = {
    "order.order_number": orderNumber,
    "order.customer_name": customerName,
    "order.email": order.customer?.email || order.email || "",
    "order.phone": order.customer?.phone || order.billing_address?.phone || order.shipping_address?.phone || "",
    "order.total": orderTotal,
    "order.shipping_method": shippingMethod,
    "order.item_count": String(itemCount),
    "order.payment_status": paymentStatus,
    "order.notes": order.note || "",
    "order.admin_url": adminOrderUrl,
    "order.shipping_address": order.shipping_address 
      ? [order.shipping_address.address1, order.shipping_address.city, order.shipping_address.province, order.shipping_address.zip, order.shipping_address.country].filter(Boolean).join(", ")
      : ""
  };

  for (const [key, val] of Object.entries(variables)) {
    const reg = new RegExp(`{{\\s*${key}\\s*}}`, "g");
    compiled = compiled.replace(reg, val);
  }

  return compiled;
}

async function syncToPlatformConnection({
  prisma,
  connection,
  subscription,
  order,
  orderNumber,
  customerName,
  shippingMethodName,
  itemCount,
  orderTotal,
  paymentStatus,
  adminOrderUrl,
  assetLinks,
  incrementOrderCount,
  logActivity,
  compileMarkdownTable,
  ClickUpAdapter,
  MondayAdapter,
  NotionAdapter
}) {
  const shopDomain = connection.shopDomain;
  const isGrowthOrPro = subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial";

  // 1. Determine target list ID using routing constraints
  let targetListId = null;
  let targetListName = null;

  if (connection.listConnections && connection.listConnections.length > 0) {
    let matchedTarget = null;
    if (isGrowthOrPro) {
      matchedTarget = connection.listConnections.find(tc => satisfiesRoutingConstraints(tc, order));
    }
    if (matchedTarget) {
      targetListId = matchedTarget.id;
      targetListName = matchedTarget.name;
    } else {
      // Fallback: use first target connection
      targetListId = connection.listConnections[0].id;
      targetListName = connection.listConnections[0].name;
    }
  } else {
    targetListId = connection.listId;
    targetListName = connection.listName;
  }

  if (!targetListId) {
    return { success: false, error: `No target list or board configured for platform ${connection.selectedPlatform}` };
  }

  // 2. Check Idempotency: Has this order already synced to this target?
  const existingRecord = await prisma.orderSyncRecord.findFirst({
    where: {
      shopDomain,
      shopifyOrderId: String(order.id),
      syncTarget: {
        connectionId: connection.id,
        targetResourceId: targetListId
      }
    }
  });

  if (existingRecord) {
    return { success: true, skipped: true, reason: "already_synced", targetRecordId: existingRecord.targetRecordId };
  }

  // 3. Resolve task name template
  const resolveTemplate = (template, vals) =>
    template
      .replace(/{order_number}/g, vals.orderNumber)
      .replace(/{customer_name}/g, vals.customerName)
      .replace(/{order_total}/g, vals.orderTotal)
      .replace(/{shipping_method}/g, vals.shippingMethod)
      .replace(/{item_count}/g, vals.itemCount)
      .replace(/{payment_status}/g, vals.paymentStatus);

  const taskName = subscription.taskNameTemplate
    ? resolveTemplate(subscription.taskNameTemplate, {
        orderNumber,
        customerName,
        orderTotal,
        shippingMethod: shippingMethodName,
        itemCount: String(itemCount),
        paymentStatus,
      })
    : `Order #${orderNumber} — ${customerName}`;

  // 4. Build description (using custom template if Pro/Growth and configured, otherwise rich markdown)
  let description = "";
  
  if (isGrowthOrPro && subscription.taskDescriptionTemplate?.trim()) {
    description = compileLiquidTemplate(
      subscription.taskDescriptionTemplate,
      order,
      customerName,
      orderNumber,
      shippingMethodName,
      itemCount,
      orderTotal,
      paymentStatus,
      adminOrderUrl
    );
  } else {
    // Rich markdown fallback
    const lines = [];
    lines.push("👤 Customer:");
    lines.push(`   Name:  ${customerName}`);
    const email = order.customer?.email || order.email;
    if (email) lines.push(`   Email: ${email}`);
    const phone = order.customer?.phone || order.billing_address?.phone || order.shipping_address?.phone;
    if (phone) lines.push(`   Phone: ${phone}`);
    lines.push("");

    lines.push("📦 Items:");
    if (order.line_items?.length > 0) {
      for (const item of order.line_items) {
        const variant = item.variant_title ? ` (${item.variant_title})` : "";
        const sku = item.sku ? ` [${item.sku}]` : "";
        lines.push(`  • ${item.quantity}x ${item.title}${variant}${sku}`);
      }
    } else {
      lines.push("  (no items)");
    }
    lines.push("");

    const currency = order.currency || "";
    const subtotal = order.subtotal_price ?? "0.00";
    const shippingCost = order.shipping_lines?.reduce((sum, s) => sum + parseFloat(s.price || "0"), 0).toFixed(2) ?? "0.00";
    const total = order.total_price ?? "0.00";

    lines.push(`💰 Subtotal: ${currency} ${subtotal}`);
    lines.push(`🚚 Shipping: ${currency} ${shippingCost}`);
    lines.push(`   Total:    ${currency} ${total}`);

    if (paymentStatus) {
      const payEmoji = paymentStatus === "paid" ? "✅" : "⏳";
      lines.push(`${payEmoji} Payment: ${paymentStatus}`);
    }
    lines.push("");

    if (order.shipping_lines?.length > 0) {
      const method = order.shipping_lines[0].title;
      if (method) lines.push(`📬 Ship via: ${method}`);
    }

    const addr = order.shipping_address;
    if (addr) {
      const addrParts = [
        addr.address1,
        addr.address2,
        [addr.city, addr.province_code || addr.province, addr.zip].filter(Boolean).join(", "),
        addr.country,
      ].filter(Boolean);
      lines.push(`📍 Ship to: ${addrParts.join(", ")}`);
    }

    if (order.note?.trim()) {
      lines.push("");
      lines.push(`📝 Notes: ${order.note.trim()}`);
    }

    if (assetLinks.length > 0) {
      lines.push("");
      lines.push("🎨 Production Assets:");
      for (const asset of assetLinks) {
        lines.push(`  • ${asset.itemName} (${asset.propName}):`);
        lines.push(`    🔗 ${asset.url}`);
      }
    }

    lines.push("");
    lines.push(`🔗 View order: ${adminOrderUrl}`);
    description = lines.join("\n");
  }

  // 5. Bypassing Custom Field API writes entirely on ClickUp Free plan using a compiled Markdown table
  if (connection.isFreePlan && isGrowthOrPro && connection.fieldMappings) {
    try {
      const mappings = JSON.parse(connection.fieldMappings);
      if (Array.isArray(mappings) && mappings.length > 0) {
        const mdTable = compileMarkdownTable(order, mappings, customerName, orderNumber);
        description = `${description}\n${mdTable}`;
      }
    } catch (e) {
      console.error("Free Plan mapping builder failed:", e);
    }
  }

  const orderCreatedAt = order.created_at ? new Date(order.created_at).getTime() : Date.now();
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

  // Compile subtask names (only if enabled by plan + subscription setting)
  const subtasksEnabled = isGrowthOrPro && subscription.subtasksEnabled;
  const subtaskNames = [];
  if (order.line_items?.length > 0) {
    for (const item of order.line_items) {
      const subtaskName = `${item.quantity}x ${item.title}${item.variant_title ? ` (${item.variant_title})` : ""}`;
      subtaskNames.push(subtaskName);
    }
  }

  // Compile attachment assets (Growth & Pro plans only)
  const attachmentAssets = [];
  if (isGrowthOrPro && assetLinks.length > 0) {
    for (const asset of assetLinks) {
      const urlParts = asset.url.split("/");
      let filename = urlParts[urlParts.length - 1].split("?")[0] || "design_file.pdf";
      filename = `${asset.itemName.replace(/[^a-zA-Z0-9.-]/g, "_")}_${filename}`;
      attachmentAssets.push({ url: asset.url, filename });
    }
  }

  // Instantiate adapter
  let adapter;
  const platform = connection.selectedPlatform || "clickup";
  if (platform === "clickup") {
    adapter = new ClickUpAdapter(connection.accessToken);
  } else if (platform === "monday") {
    adapter = new MondayAdapter(connection.accessToken);
  } else if (platform === "notion") {
    adapter = new NotionAdapter(connection.accessToken);
  }

  if (!adapter) {
    throw new Error(`Unsupported selectedPlatform integration: ${platform}`);
  }

  // Sync record creation through adapter
  const targetRecordId = await adapter.createRecord(targetListId, {
    name: taskName,
    description,
    priority: 3,
    startDate: orderCreatedAt,
    dueDate: orderCreatedAt + twoDaysMs,
    tags: ["shopify-order"],
    rawOrder: order,
    customerName,
    shippingCost: order.shipping_lines?.reduce((sum, s) => sum + parseFloat(s.price || "0"), 0).toFixed(2) ?? "0.00",
    fieldMappings: isGrowthOrPro ? connection.fieldMappings : null,
    isFreePlan: connection.isFreePlan,
    subtasks: subtaskNames,
    attachments: attachmentAssets
  });

  // Record in database
  const activeConn = await prisma.platformConnection.findFirst({
    where: { shopDomain, id: connection.id }
  });
  if (activeConn) {
    const syncTarget = await prisma.syncTarget.upsert({
      where: {
        connectionId_targetResourceId: {
          connectionId: activeConn.id,
          targetResourceId: targetListId
        }
      },
      update: {},
      create: {
        connectionId: activeConn.id,
        targetResourceId: targetListId,
        targetResourceName: targetListName || "Active Target"
      }
    });

    await prisma.orderSyncRecord.create({
      data: {
        shopDomain,
        shopifyOrderId: String(order.id),
        syncTargetId: syncTarget.id,
        targetRecordId: targetRecordId,
        syncStatus: "synced",
        orderNumber: orderNumber
      }
    });
    await incrementOrderCount(shopDomain);

    // Tag the Shopify order
    try {
      const { default: shopifyPrisma } = await import("../db.server");
      const sessionRec = await shopifyPrisma.session.findFirst({
        where: { shop: shopDomain, isOnline: false },
      });
      if (sessionRec?.accessToken) {
        const tagMutation = `mutation tagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`;
        const shopifyAdminUrl = `https://${shopDomain}/admin/api/2024-01/graphql.json`;
        await fetch(shopifyAdminUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": sessionRec.accessToken,
          },
          body: JSON.stringify({
            query: tagMutation,
            variables: {
              id: `gid://shopify/Order/${order.id}`,
              tags: [`syncup-${platform}`],
            },
          }),
        }).catch((tagErr) => console.error("Order tagging failed:", tagErr));
      }
    } catch (tagErr) {
      console.error("Order tagging error:", tagErr);
    }
  }

  logActivity(
    shopDomain,
    "order_synced",
    `Order #${orderNumber} (${customerName}) synced to ${connection.selectedPlatform === "clickup" ? "ClickUp" : connection.selectedPlatform === "monday" ? "Monday.com" : "Notion"}`,
    String(order.id),
    targetRecordId
  );

  return { success: true, targetRecordId };
}

async function handleJobProcess(request) {
  // Dynamic imports to prevent server-only modules from leaking into client bundle builds
  const [
    { default: prisma },
    {
      getConnection,
      getAllConnections,
      fetchShopifyCustomer,
      logActivity,
      compileMarkdownTable,
    },
    { getOrCreateSubscription, isSubscriptionActive, incrementOrderCount },
    { ClickUpAdapter, MondayAdapter, NotionAdapter }
  ] = await Promise.all([
    import("../db.server"),
    import("../clickup.server"),
    import("../billing.server"),
    import("../adapters/core.js")
  ]);

  // Validate authorization
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") || request.headers.get("Authorization")?.replace("Bearer ", "");
  
  if (!secret || secret !== process.env.SHOPIFY_API_SECRET) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // Get up to 5 pending or failed jobs to process
  const jobs = await prisma.syncJob.findMany({
    where: {
      status: { in: ["pending", "failed"] },
      attempts: { lt: 3 },
    },
    orderBy: { createdAt: "asc" },
    take: 5,
  });

  if (jobs.length === 0) {
    return Response.json({ ok: true, processed: 0 });
  }

  const results = [];

  for (const job of jobs) {
    // Claim job state to avoid race conditions
    try {
      const claimResult = await prisma.syncJob.updateMany({
        where: { id: job.id, status: job.status, attempts: job.attempts },
        data: { status: "processing" }
      });
      if (claimResult.count === 0) {
        continue; 
      }
    } catch (e) {
      continue;
    }

    try {
      const payload = JSON.parse(job.payload);
      const { shopDomain } = job;
      
      const subscription = await getOrCreateSubscription(shopDomain);
      if (!isSubscriptionActive(subscription)) {
        throw new Error(`Subscription inactive for ${shopDomain}`);
      }

      // Check sync trigger setting
      const syncTrigger = subscription.syncTrigger || "payment_confirmed";
      if (syncTrigger === "payment_confirmed" && payload.financial_status !== "paid") {
        await prisma.syncJob.update({
          where: { id: job.id },
          data: { status: "completed" }
        });
        results.push({ jobId: job.id, success: true, skipped: true, reason: "trigger:not_paid" });
        continue;
      }
      if (syncTrigger === "on_fulfillment_start" && !payload.fulfillment_status) {
        await prisma.syncJob.update({
          where: { id: job.id },
          data: { status: "completed" }
        });
        results.push({ jobId: job.id, success: true, skipped: true, reason: "trigger:not_fulfilling" });
        continue;
      }

      // Determine active connections to process based on Pro tier allowance
      const isPro = subscription.planName.startsWith("pro");
      let activeConnections = [];
      if (isPro) {
        activeConnections = await getAllConnections(shopDomain);
      } else {
        const conn = await getConnection(shopDomain);
        activeConnections = conn ? [conn] : [];
      }

      if (activeConnections.length === 0) {
        throw new Error(`No active platform connections configured for ${shopDomain}`);
      }

      const order = payload;
      const orderNumber = String(order.order_number ?? order.number ?? order.id);

      let customerName =
        [order.customer?.first_name, order.customer?.last_name]
          .filter(Boolean).join(" ").trim() ||
        order.customer?.name ||
        [order.billing_address?.first_name, order.billing_address?.last_name]
          .filter(Boolean).join(" ").trim() ||
        [order.shipping_address?.first_name, order.shipping_address?.last_name]
          .filter(Boolean).join(" ").trim() ||
        order.billing_address?.name ||
        order.shipping_address?.name ||
        order.customer?.email ||
        order.email;

      if (!customerName && order.customer?.id) {
        const fullCustomer = await fetchShopifyCustomer(shopDomain, order.customer.id);
        if (fullCustomer) {
          customerName =
            [fullCustomer.first_name, fullCustomer.last_name].filter(Boolean).join(" ").trim() ||
            fullCustomer.email;
        }
      }

      customerName = customerName || "Guest";

      const storeHandle = shopDomain.replace(/\.myshopify\.com$/, "");
      const adminOrderUrl = `https://admin.shopify.com/store/${storeHandle}/orders/${order.id}`;

      const shippingMethodName = order.shipping_lines?.[0]?.title || "";
      const itemCount = (order.line_items || []).length;
      const orderTotal = `${order.currency || ""} ${order.total_price || "0.00"}`;
      const paymentStatus = order.financial_status || "";

      // Parse Line Items for custom properties (artwork)
      const assetLinks = [];
      if (order.line_items?.length > 0) {
        for (const item of order.line_items) {
          if (Array.isArray(item.properties)) {
            for (const prop of item.properties) {
              const val = String(prop.value || "").trim();
              const isUrl = val.startsWith("http://") || val.startsWith("https://");
              const isFile = /\.(jpg|jpeg|png|gif|pdf|svg|webp|tiff|zip|ai|psd|eps|csv|txt)/i.test(val);
              if (isUrl && isFile) {
                assetLinks.push({
                  itemName: item.title,
                  propName: prop.name,
                  url: val
                });
              }
            }
          }
        }
      }

      // Fan out sync requests to all active connections
      const syncPromises = activeConnections.map((connection) =>
        syncToPlatformConnection({
          prisma,
          connection,
          subscription,
          order,
          orderNumber,
          customerName,
          shippingMethodName,
          itemCount,
          orderTotal,
          paymentStatus,
          adminOrderUrl,
          assetLinks,
          incrementOrderCount,
          logActivity,
          compileMarkdownTable,
          ClickUpAdapter,
          MondayAdapter,
          NotionAdapter
        })
      );

      const syncResults = await Promise.allSettled(syncPromises);

      // Check if any errors occurred
      const errors = [];
      for (let i = 0; i < syncResults.length; i++) {
        const res = syncResults[i];
        if (res.status === "rejected") {
          errors.push(`[${activeConnections[i].selectedPlatform}] ${res.reason.message}`);
        } else if (res.value?.success === false) {
          errors.push(`[${activeConnections[i].selectedPlatform}] ${res.value.error}`);
        }
      }

      if (errors.length > 0) {
        throw new Error(errors.join(" | "));
      }

      // Delete completed job — the full order JSON in `payload` contains customer PII
      // (name, email, address). OrderSyncRecord already tracks what was synced.
      await prisma.syncJob.delete({ where: { id: job.id } });
      results.push({ jobId: job.id, success: true });


    } catch (err) {
      console.error(`Sync Job ${job.id} failed:`, err);
      await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          attempts: { increment: 1 },
          lastError: err.message,
        }
      });
      results.push({ jobId: job.id, success: false, error: err.message });
    }
  }

  return Response.json({ ok: true, processed: jobs.length, results });
}
```

---

## File: [app/routes/api.reconciliation.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/api.reconciliation.jsx)

```jsx
import prisma from "../db.server";

/**
 * SECURE CRON ENDPOINT: /api/reconciliation
 * Triggered via Vercel Crons, GitHub Actions, or scheduled events.
 * 
 * Supports two processing modes:
 * 1. Global Scan: Reconciles all active storefront subscriptions in batches.
 * 2. Targeted Scan: Pass ?shop=mystore.myshopify.com to reconcile a single shop.
 */
export const loader = async ({ request }) => {
  return handleReconciliation(request);
};

export const action = async ({ request }) => {
  return handleReconciliation(request);
};

async function handleReconciliation(request) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") || request.headers.get("Authorization")?.replace("Bearer ", "");

  // 1. Authenticate the cron scheduler against your API secret key
  if (!secret || secret !== process.env.SHOPIFY_API_SECRET) {
    return Response.json({ ok: false, error: "Unauthorized access" }, { status: 401 });
  }

  // 1.5 GDPR: Purge failed sync jobs older than 7 days to protect customer PII
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const purgeResult = await prisma.syncJob.deleteMany({
      where: {
        status: "failed",
        updatedAt: { lt: sevenDaysAgo }
      }
    });
    if (purgeResult.count > 0) {
      console.log(`[GDPR Cleanup] Purged ${purgeResult.count} failed sync jobs older than 7 days containing PII.`);
    }
  } catch (purgeErr) {
    console.error("Failed to run GDPR PII cleanup for failed jobs:", purgeErr);
  }

  const shopParam = url.searchParams.get("shop");
  let shopsToProcess = [];

  try {
    if (shopParam) {
      // Run targeted reconciliation for a single shop
      shopsToProcess = [shopParam];
    } else {
      // Query active, paying subscriptions to optimize system resources
      const activeSubscriptions = await prisma.subscription.findMany({
        where: {
          status: "active",
          OR: [
            { planName: { not: "trial" } },
            { trialEndDate: { gte: new Date() } }
          ]
        },
        select: { shopDomain: true },
        take: 50 // Safe batch size limit to avoid Vercel execution timeouts
      });
      shopsToProcess = activeSubscriptions.map((s) => s.shopDomain);
    }

    if (shopsToProcess.length === 0) {
      return Response.json({ ok: true, message: "No active storefronts found for reconciliation." });
    }

    const summary = [];

    // 2. Loop through eligible shops sequentially
    for (const shopDomain of shopsToProcess) {
      try {
        const result = await reconcileShopStorefront(shopDomain);
        summary.push({ shop: shopDomain, ...result });
      } catch (shopErr) {
        console.error(`Reconciliation failed for ${shopDomain}:`, shopErr);
        summary.push({ shop: shopDomain, success: false, error: shopErr.message });
        
        // Mark integration health as degraded to notify the merchant via the UI
        await prisma.platformConnection.updateMany({
          where: { shopDomain, isActive: true },
          data: { healthStatus: "degraded", lastHealthCheck: new Date() }
        });
      }
    }

    // 3. Kick off the queue runner to execute any newly recovered sync jobs immediately
    const host = request.headers.get("host");
    const protocol = host.includes("localhost") || host.includes("127.0.0.1") ? "http" : "https";
    const triggerUrl = `${protocol}://${host}/api/jobs/process`;
    
    // Await background fetch to ensure it completes before Vercel terminates the execution context
    await fetch(triggerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.SHOPIFY_API_SECRET}`
      }
    }).catch(console.error);

    return Response.json({ ok: true, processed: summary.length, results: summary });
  } catch (globalErr) {
    console.error("Global reconciliation engine crash:", globalErr);
    return Response.json({ ok: false, error: globalErr.message }, { status: 500 });
  }
}

/**
 * Reconciles e-commerce transactions for a single store from the last 24 hours.
 */
async function reconcileShopStorefront(shopDomain) {
  // Fetch shop session credentials
  const session = await prisma.session.findFirst({
    where: { shop: shopDomain, isOnline: false },
    select: { accessToken: true }
  });

  if (!session?.accessToken) {
    throw new Error("No offline access credentials available.");
  }

  // Fetch active sync mapping parameters
  const subscription = await prisma.subscription.findUnique({
    where: { shopDomain }
  });

  const syncTrigger = subscription?.syncTrigger || "payment_confirmed";

  // Calculate the 24-hour timestamp window
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const createdAtMin = oneDayAgo.toISOString(); // ISO 8601 string format

  // 4. Request the last 24 hours of orders from Shopify using October25 API Version
  // Fields filter dramatically reduces payload size and execution overhead
  const queryFields = "id,order_number,number,financial_status,fulfillment_status,created_at,line_items,customer,email,shipping_lines,total_price,currency,note";
  const shopifyUrl = `https://${shopDomain}/admin/api/2025-10/orders.json?status=any&created_at_min=${createdAtMin}&fields=${queryFields}&limit=250`;

  const response = await fetch(shopifyUrl, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": session.accessToken,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Shopify API retrieval error: ${response.status} ${response.statusText}`);
  }

  const { orders } = await response.json();
  if (!orders || orders.length === 0) {
    return { success: true, message: "No recent orders to reconcile." };
  }

  const orderIds = orders.map((o) => String(o.id));

  // 5. Query DB to identify existing executions
  const [existingRecords, existingJobs] = await Promise.all([
    prisma.orderSyncRecord.findMany({
      where: { shopDomain, shopifyOrderId: { in: orderIds } },
      select: { shopifyOrderId: true }
    }),
    prisma.syncJob.findMany({
      where: { shopDomain, shopifyOrderId: { in: orderIds } },
      select: { shopifyOrderId: true }
    })
  ]);

  const existingRecordSet = new Set(existingRecords.map((r) => r.shopifyOrderId));
  const existingJobSet = new Set(existingJobs.map((j) => j.shopifyOrderId));

  let enqueuedCount = 0;

  // 6. Cross-reference fetched orders to find dropped webhooks
  for (const order of orders) {
    const orderIdStr = String(order.id);

    // Skip if the transaction has already been synced or is actively waiting in the queue
    if (existingRecordSet.has(orderIdStr) || existingJobSet.has(orderIdStr)) {
      continue;
    }

    // Verify if the order satisfies the merchant's active trigger constraints
    let triggerMatches = false;
    if (syncTrigger === "payment_confirmed" && order.financial_status === "paid") {
      triggerMatches = true;
    } else if (syncTrigger === "on_fulfillment_start" && order.fulfillment_status) {
      triggerMatches = true;
    } else if (syncTrigger === "on_create") {
      triggerMatches = true;
    }

    if (triggerMatches) {
      // 7. Inject recovered order into the processing queue
      await prisma.syncJob.create({
        data: {
          shopDomain,
          shopifyOrderId: orderIdStr,
          payload: JSON.stringify(order),
          status: "pending"
        }
      });

      // Log the event with dynamic, clear messaging for the merchant feed
      await prisma.activityLog.create({
        data: {
          shopDomain,
          eventType: "order_reconciled",
          description: `[Reconciliation Engine] Automatically recovered dropped webhook for Order #${order.order_number || orderIdStr}.`,
          shopifyOrderId: orderIdStr,
          syncStatus: "synced"
        }
      });

      enqueuedCount++;
    }
  }

  // Update integration connection status as healthy
  await prisma.platformConnection.updateMany({
    where: { shopDomain, isActive: true },
    data: { healthStatus: "healthy", lastHealthCheck: new Date() }
  });

  return { success: true, totalFound: orders.length, recovered: enqueuedCount };
}
```

---

## File: [app/routes/api.webhooks.clickup.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/api.webhooks.clickup.jsx)

```jsx
const json = Response.json;
import prisma from "../db.server";
import { logActivity } from "../clickup.server";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const payload = await request.json();
    console.log("Received ClickUp webhook payload:", JSON.stringify(payload));

    const taskId = payload.task_id;
    if (!taskId) {
      return json({ ok: true, message: "No task_id in payload" });
    }

    // Find history status change
    const statusChange = payload.history_items?.find(item => item.field === "status");
    if (!statusChange) {
      return json({ ok: true, message: "No status change in payload" });
    }

    const afterStatus = String(statusChange.after || "").toLowerCase();
    const completeKeywords = ["complete", "closed", "done", "shipped", "fulfilled", "ready to ship"];
    const isCompleted = completeKeywords.some(kw => afterStatus.includes(kw));

    if (!isCompleted) {
      return json({ ok: true, message: `Status '${afterStatus}' is not a fulfillment trigger` });
    }

    // Look up OrderSyncRecord
    const record = await prisma.orderSyncRecord.findFirst({
      where: { targetRecordId: taskId }
    });

    if (!record) {
      return json({ ok: true, message: `No Shopify order record mapped to ClickUp task ${taskId}` });
    }

    // Check subscription plan & two-way sync toggle
    const sub = await prisma.subscription.findUnique({
      where: { shopDomain: record.shopDomain }
    });

    const isGrowthOrPro = sub && (sub.planName.startsWith("growth") || sub.planName.startsWith("pro") || sub.planName === "trial");
    if (!sub || !isGrowthOrPro || !sub.twoWaySyncEnabled) {
      return json({ ok: true, message: "Two-way sync is not enabled or supported by your current plan" });
    }

    // Fulfill order in Shopify
    const sessionRec = await prisma.session.findFirst({
      where: { shop: record.shopDomain, isOnline: false }
    });

    if (!sessionRec?.accessToken) {
      return json({ error: "No Shopify access token found" }, { status: 400 });
    }

    const shopifyAdminUrl = `https://${record.shopDomain}/admin/api/2024-01/graphql.json`;

    // 1. Fetch fulfillment orders
    const getFulfillmentOrdersQuery = `
      query getFulfillmentOrders($orderId: ID!) {
        order(id: $orderId) {
          fulfillmentOrders(first: 5) {
            nodes {
              id
              status
            }
          }
        }
      }
    `;

    const getRes = await fetch(shopifyAdminUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": sessionRec.accessToken
      },
      body: JSON.stringify({
        query: getFulfillmentOrdersQuery,
        variables: { orderId: `gid://shopify/Order/${record.shopifyOrderId}` }
      })
    });

    const getResJson = await getRes.json();
    const nodes = getResJson.data?.order?.fulfillmentOrders?.nodes || [];
    const openFulfillmentOrders = nodes.filter(fo => ["OPEN", "IN_PROGRESS"].includes(fo.status));

    if (openFulfillmentOrders.length === 0) {
      return json({ ok: true, message: "Order is already fulfilled or has no open fulfillment orders" });
    }

    // 2. Fulfill each open fulfillment order
    const fulfillMutation = `
      mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
        fulfillmentCreateV2(fulfillment: $fulfillment) {
          fulfillment {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    for (const fo of openFulfillmentOrders) {
      await fetch(shopifyAdminUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": sessionRec.accessToken
        },
        body: JSON.stringify({
          query: fulfillMutation,
          variables: {
            fulfillment: {
              lineItemsByFulfillmentOrder: [
                {
                  fulfillmentOrderId: fo.id,
                  fulfillmentOrderLineItems: [] // empty fulfills all
                }
              ]
            }
          }
        })
      });
    }

    // Update status & log
    await prisma.orderSyncRecord.update({
      where: { id: record.id },
      data: { syncStatus: "fulfilled" }
    });

    await logActivity(
      record.shopDomain,
      "order_fulfilled",
      `Order #${record.orderNumber || record.shopifyOrderId} automatically fulfilled via ClickUp status change to '${statusChange.after}'.`
    );

    return json({ ok: true, fulfilled: true });
  } catch (err) {
    console.error("ClickUp webhook handler error:", err);
    return json({ error: err.message }, { status: 500 });
  }
};
```

---

## File: [app/routes/api.webhooks.monday.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/api.webhooks.monday.jsx)

```jsx
const json = Response.json;
import prisma from "../db.server";
import { logActivity } from "../clickup.server";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const payload = await request.json();
    console.log("Received Monday.com webhook payload:", JSON.stringify(payload));

    // 1. Monday.com Webhook URL verification handshake
    if (payload.challenge) {
      return json({ challenge: payload.challenge });
    }

    const event = payload.event;
    if (!event) {
      return json({ ok: true, message: "No event payload found" });
    }

    const pulseId = String(event.pulseId || "");
    if (!pulseId) {
      return json({ ok: true, message: "No pulseId in event" });
    }

    // Determine status text
    let newStatusLabel = "";
    if (event.value?.label?.text) {
      newStatusLabel = String(event.value.label.text).toLowerCase();
    } else if (event.value?.text) {
      newStatusLabel = String(event.value.text).toLowerCase();
    }

    if (!newStatusLabel) {
      return json({ ok: true, message: "No status text resolved" });
    }

    const completeKeywords = ["complete", "done", "shipped", "fulfilled", "ready to ship"];
    const isCompleted = completeKeywords.some(kw => newStatusLabel.includes(kw));

    if (!isCompleted) {
      return json({ ok: true, message: `Status '${newStatusLabel}' is not a fulfillment trigger` });
    }

    // Look up OrderSyncRecord
    const record = await prisma.orderSyncRecord.findFirst({
      where: { targetRecordId: pulseId }
    });

    if (!record) {
      return json({ ok: true, message: `No Shopify order record mapped to Monday item ${pulseId}` });
    }

    // Check subscription plan & two-way sync toggle
    const sub = await prisma.subscription.findUnique({
      where: { shopDomain: record.shopDomain }
    });

    const isGrowthOrPro = sub && (sub.planName.startsWith("growth") || sub.planName.startsWith("pro") || sub.planName === "trial");
    if (!sub || !isGrowthOrPro || !sub.twoWaySyncEnabled) {
      return json({ ok: true, message: "Two-way sync is not enabled or supported by your current plan" });
    }

    // Fulfill order in Shopify
    const sessionRec = await prisma.session.findFirst({
      where: { shop: record.shopDomain, isOnline: false }
    });

    if (!sessionRec?.accessToken) {
      return json({ error: "No Shopify access token found" }, { status: 400 });
    }

    const shopifyAdminUrl = `https://${record.shopDomain}/admin/api/2024-01/graphql.json`;

    // Fetch fulfillment orders
    const getFulfillmentOrdersQuery = `
      query getFulfillmentOrders($orderId: ID!) {
        order(id: $orderId) {
          fulfillmentOrders(first: 5) {
            nodes {
              id
              status
            }
          }
        }
      }
    `;

    const getRes = await fetch(shopifyAdminUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": sessionRec.accessToken
      },
      body: JSON.stringify({
        query: getFulfillmentOrdersQuery,
        variables: { orderId: `gid://shopify/Order/${record.shopifyOrderId}` }
      })
    });

    const getResJson = await getRes.json();
    const nodes = getResJson.data?.order?.fulfillmentOrders?.nodes || [];
    const openFulfillmentOrders = nodes.filter(fo => ["OPEN", "IN_PROGRESS"].includes(fo.status));

    if (openFulfillmentOrders.length === 0) {
      return json({ ok: true, message: "Order is already fulfilled or has no open fulfillment orders" });
    }

    // Fulfill open fulfillment orders
    const fulfillMutation = `
      mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
        fulfillmentCreateV2(fulfillment: $fulfillment) {
          fulfillment {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    for (const fo of openFulfillmentOrders) {
      await fetch(shopifyAdminUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": sessionRec.accessToken
        },
        body: JSON.stringify({
          query: fulfillMutation,
          variables: {
            fulfillment: {
              lineItemsByFulfillmentOrder: [
                {
                  fulfillmentOrderId: fo.id,
                  fulfillmentOrderLineItems: []
                }
              ]
            }
          }
        })
      });
    }

    // Update status & log
    await prisma.orderSyncRecord.update({
      where: { id: record.id },
      data: { syncStatus: "fulfilled" }
    });

    await logActivity(
      record.shopDomain,
      "order_fulfilled",
      `Order #${record.orderNumber || record.shopifyOrderId} automatically fulfilled via Monday.com status change to '${event.value?.label?.text || event.value?.text}'.`
    );

    return json({ ok: true, fulfilled: true });
  } catch (err) {
    console.error("Monday webhook handler error:", err);
    return json({ error: err.message }, { status: 500 });
  }
};
```

---

## File: [app/routes/app.billing.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/app.billing.jsx)

```jsx
import { useEffect, useState } from "react";
import { useLoaderData, useActionData, useNavigation, Form, redirect, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { PLANS, getTranslatedFeatures } from "../plans";
import prisma from "../db.server";
import {
  getOrCreateSubscription,
  createShopifySubscription,
  cancelExistingSubscription,
  activateSubscription,
  downgradeToFree,
} from "../billing.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const activated = url.searchParams.get("activated");

  const subscription = await getOrCreateSubscription(shop);

  // Callback after Shopify billing approval
  if (activated && PLANS[activated]) {
    const res = await admin.graphql(`#graphql
      {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
          }
        }
      }
    `);
    const { data } = await res.json();
    const activeSubs = data?.currentAppInstallation?.activeSubscriptions || [];
    const plan = PLANS[activated];
    const match = activeSubs.find(
      (s) => s.name === plan.shopifyPlanName && s.status === "ACTIVE"
    );

    if (match) {
      const getLimitForPlan = (planName) => {
        if (planName === "trial") return 5;
        const p = PLANS[planName];
        return p ? p.listLimit : 1;
      };
      const currentLimit = getLimitForPlan(subscription.planName);
      const newLimit = getLimitForPlan(activated);

      let removedListNames = null;
      if (newLimit < currentLimit) {
        const { handleDowngradeToListLimit } = await import("../clickup.server");
        removedListNames = await handleDowngradeToListLimit(shop, newLimit);
      }

      await activateSubscription(shop, activated, match.id);

      const query = removedListNames
        ? `&removed_lists=${encodeURIComponent(removedListNames)}`
        : "";
      return redirect(`/app?billing_success=1${query}`);
    }
  }

  const { getConnection } = await import("../clickup.server");
  const connection = await getConnection(shop);
  const selectedPlatform = url.searchParams.get("platform") || connection?.selectedPlatform || "clickup";

  const activePaidCount = await prisma.subscription.count({
    where: {
      planName: {
        notIn: ["trial", "free", "expired", "cancelled"],
      },
      shopDomain: {
        not: "syncup-test-store.myshopify.com",
      },
    },
  });

  const isTestModeActive = process.env.SHOPIFY_BILLING_TEST === "true";

  return { subscription, selectedPlatform, activePaidCount, isTestModeActive };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");
  const planKey = formData.get("plan");

  if (intent === "upgrade" && planKey) {
    if (planKey === "free") {
      const subscription = await getOrCreateSubscription(shop);
      if (subscription.shopifyChargeId) {
        await cancelExistingSubscription(admin, subscription.shopifyChargeId);
      }
      await downgradeToFree(shop);
      return redirect("/app?billing_success=1");
    } else if (PLANS[planKey]) {
      const subscription = await getOrCreateSubscription(shop);
      if (subscription.shopifyChargeId) {
        await cancelExistingSubscription(admin, subscription.shopifyChargeId);
      }
      try {
        const { confirmationUrl } = await createShopifySubscription(
          admin,
          shop,
          planKey
        );
        return { confirmationUrl };
      } catch (err) {
        return { error: err.message };
      }
    }
  }

  return { error: "Unknown action." };
};

const C = {
  bg: "#0f0f0f",
  surface: "#1a1a1a",
  border: "#2a2a2a",
  text: "#ffffff",
  muted: "#9a9a9a",
  accent: "#00c48c",
};

export default function BillingPage() {
  const { subscription, selectedPlatform, activePaidCount = 0, isTestModeActive } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [billingInterval, setBillingInterval] = useState(
    subscription.planName.endsWith("_annual") ? "annual" : "monthly"
  );

  useEffect(() => {
    if (actionData?.confirmationUrl) {
      window.top.location.href = actionData.confirmationUrl;
    }
  }, [actionData?.confirmationUrl]);

  const currentPlanKey = subscription?.planName || "trial";

  const planSpecs = {
    free: {
      key: "free",
      badge: null,
      priceDesc: "Free forever",
      annualPriceDesc: "Free forever",
      billedDesc: "Billed monthly",
      monthlyEquivalent: "0",
    },
    standard: {
      key: "standard",
      badge: "Best for Starters",
      priceDesc: "$19.99/mo",
      annualPriceDesc: "$17.91/mo",
      billedDesc: "Billed annually as $215",
      monthlyEquivalent: "17.91",
      regMonthly: "$29.99",
      regAnnual: "$323",
    },
    growth: {
      key: "growth",
      badge: "Most Popular",
      priceDesc: "$39.99/mo",
      annualPriceDesc: "$35.91/mo",
      billedDesc: "Billed annually as $431",
      monthlyEquivalent: "35.91",
      regMonthly: "$49.99",
      regAnnual: "$539",
    },
    pro: {
      key: "pro",
      badge: "Concierge Setup Included",
      priceDesc: "$79.99/mo",
      annualPriceDesc: "$71.91/mo",
      billedDesc: "Billed annually as $863",
      monthlyEquivalent: "71.91",
      regMonthly: "$99.99",
      regAnnual: "$1079",
    },
  };

  const getCardStyle = (isHighlighted, isCurrent) => {
    let border = `1px solid ${C.border}`;
    let ring = "none";
    let shadow = "none";
    let background = "rgba(26, 26, 26, 0.4)";
    
    if (isHighlighted) {
      border = "1px solid rgba(0, 196, 140, 0.4)";
      shadow = "0 10px 15px -3px rgba(0, 196, 140, 0.05), 0 4px 6px -2px rgba(0, 196, 140, 0.05)";
      background = "rgba(26, 26, 26, 0.6)";
    }
    if (isCurrent) {
      border = `1px solid ${C.accent}`;
      ring = `0 0 0 1px rgba(0, 196, 140, 0.3)`;
    }

    return {
      background,
      border,
      boxShadow: ring !== "none" ? ring : shadow,
      borderRadius: 16,
      padding: 24,
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      position: "relative",
      backdropFilter: "blur(8px)",
      boxSizing: "border-box",
      transition: "border-color 0.3s ease, transform 0.3s ease",
    };
  };

  const getButtonStyle = (isHighlighted) => {
    if (isHighlighted) {
      return {
        width: "100%",
        padding: "12px 0",
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 800,
        backgroundColor: C.accent,
        color: "#03251c",
        border: "none",
        cursor: "pointer",
        transition: "background-color 0.2s ease, transform 0.2s ease",
        boxSizing: "border-box",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      };
    } else {
      return {
        width: "100%",
        padding: "12px 0",
        borderRadius: 12,
        fontSize: 12,
        fontWeight: "bold",
        backgroundColor: C.surface,
        color: C.text,
        border: `1px solid ${C.border}`,
        cursor: "pointer",
        transition: "background-color 0.2s ease, border-color 0.2s ease, transform 0.2s ease",
        boxSizing: "border-box",
      };
    }
  };

  const isPromoActive = activePaidCount < 10;
  const spotsRemaining = Math.max(0, 10 - activePaidCount);

  return (
    <div style={{
      minHeight: "100vh",
      background: C.bg,
      color: C.text,
      padding: "48px 16px",
      fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      boxSizing: "border-box"
    }}>
      <div style={{
        maxWidth: 1200,
        margin: "0 auto",
      }}>
        
        {/* Navigation & Header */}
        <header style={{
          marginBottom: 40,
          maxWidth: 896,
          marginLeft: "auto",
          marginRight: "auto",
        }}>
          <Link
            to="/app"
            style={{
              fontSize: 12,
              color: C.muted,
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 24,
              transition: "color 0.2s ease",
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = C.text}
            onMouseLeave={(e) => e.currentTarget.style.color = C.muted}
          >
            &larr; Back to Settings
          </Link>
          <h1 style={{
            fontSize: "2rem",
            fontWeight: 800,
            color: C.text,
            letterSpacing: "-0.025em",
            margin: "0 0 12px 0",
          }}>
            Pricing Plans & Billing
          </h1>
          <p style={{
            fontSize: 14,
            color: C.muted,
            lineHeight: 1.6,
            margin: 0,
          }}>
            Select a plan to automate your order workflows. SyncUp uses Shopify secure billing, and all plan pricing is displayed in USD. {isTestModeActive && "Test mode is active. "}You can cancel or change your plan at any time.
          </p>
        </header>

        {/* Grandfathering / Urgency Banner */}
        {isPromoActive ? (
          <div style={{
            background: "rgba(0, 196, 140, 0.05)",
            border: `1px solid rgba(0, 196, 140, 0.2)`,
            color: C.accent,
            padding: 16,
            borderRadius: 12,
            fontSize: 13,
            display: "flex",
            alignItems: "start",
            gap: 12,
            marginBottom: 40,
            maxWidth: 896,
            marginLeft: "auto",
            marginRight: "auto",
            boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.1)",
            backdropFilter: "blur(8px)",
            boxSizing: "border-box"
          }}>
            <span style={{ fontSize: 20, lineHeight: 1 }}>🚀</span>
            <div>
              <strong style={{
                fontWeight: 600,
                display: "block",
                marginBottom: 2,
                color: C.text,
              }}>LAUNCH SPECIAL OFFER</strong>
              Install today to lock in these discounted B2B rates forever. <strong style={{ color: C.text }}>Only {spotsRemaining} slots remaining!</strong> Once our beta ends, pricing will increase for new installs. Existing merchants will remain grandfathered on these plans indefinitely!
            </div>
          </div>
        ) : (
          <div style={{
            background: "rgba(255, 255, 255, 0.03)",
            border: `1px solid ${C.border}`,
            color: C.muted,
            padding: 16,
            borderRadius: 12,
            fontSize: 13,
            display: "flex",
            alignItems: "start",
            gap: 12,
            marginBottom: 40,
            maxWidth: 896,
            marginLeft: "auto",
            marginRight: "auto",
            boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.05)",
            backdropFilter: "blur(8px)",
            boxSizing: "border-box"
          }}>
            <span style={{ fontSize: 20, lineHeight: 1 }}>💡</span>
            <div>
              <strong style={{
                fontWeight: 600,
                display: "block",
                marginBottom: 2,
                color: C.text,
              }}>PROMOTIONAL SLOTS CLAIMED</strong>
              All 10 beta launch promotional slots have been claimed! Standard rates are now active for new installs. Existing promotional subscribers remain grandfathered at their initial rates.
            </div>
          </div>
        )}

        {/* Action Notifications */}
        {actionData?.error && (
          <div style={{
            background: "rgba(255, 68, 68, 0.08)",
            border: "1px solid rgba(255, 68, 68, 0.2)",
            color: "#ff4444",
            padding: 16,
            borderRadius: 12,
            fontSize: 14,
            marginBottom: 32,
            maxWidth: 896,
            marginLeft: "auto",
            marginRight: "auto",
            boxSizing: "border-box"
          }}>
            ✕ {actionData.error}
          </div>
        )}

        {actionData?.confirmationUrl && (
          <div style={{
            background: "rgba(0, 196, 140, 0.08)",
            border: `1px solid rgba(0, 196, 140, 0.2)`,
            color: C.accent,
            padding: 16,
            borderRadius: 12,
            fontSize: 14,
            marginBottom: 32,
            maxWidth: 896,
            marginLeft: "auto",
            marginRight: "auto",
            boxSizing: "border-box"
          }}>
            ⚡ Redirecting to Shopify billing approval page…
          </div>
        )}

        {/* Monthly/Annual Toggle */}
        <div style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: 12,
          marginBottom: 48,
        }}>
          <span style={{
            fontSize: 12,
            fontWeight: 600,
            color: billingInterval === "monthly" ? C.text : C.muted,
            transition: "color 0.2s ease",
          }}>
            Monthly Billing
          </span>
          <button
            type="button"
            style={{
              position: "relative",
              display: "inline-flex",
              height: 24,
              width: 44,
              flexShrink: 0,
              cursor: "pointer",
              borderRadius: 9999,
              border: "2px solid transparent",
              backgroundColor: C.surface,
              transition: "background-color 0.2s ease",
              outline: "none",
              padding: 0,
            }}
            onClick={() => setBillingInterval(billingInterval === "monthly" ? "annual" : "monthly")}
            role="switch"
            aria-checked={billingInterval === "annual"}
          >
            <span
              aria-hidden="true"
              style={{
                pointerEvents: "none",
                display: "inline-block",
                height: 20,
                width: 20,
                borderRadius: 9999,
                backgroundColor: C.accent,
                boxShadow: "0 1px 3px rgba(0, 0, 0, 0.3)",
                transform: billingInterval === "annual" ? "translateX(20px)" : "translateX(0)",
                transition: "transform 0.2s ease-in-out",
              }}
            />
          </button>
          <span style={{
            fontSize: 12,
            fontWeight: 600,
            color: billingInterval === "annual" ? C.accent : C.muted,
            transition: "color 0.2s ease",
            display: "flex",
            alignItems: "center",
          }}>
            Annual Billing
            <span style={{
              backgroundColor: "rgba(0, 196, 140, 0.1)",
              color: C.accent,
              fontSize: 10,
              padding: "2px 8px",
              borderRadius: 9999,
              fontWeight: "bold",
              marginLeft: 6,
              border: `1px solid rgba(0, 196, 140, 0.2)`,
              display: "inline-block",
            }}>
              Save ~10%
            </span>
          </span>
        </div>

        {/* Pricing Grid */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 24,
          alignItems: "stretch",
        }}>
          {["free", "standard", "growth", "pro"].map((key) => {
            const planKey = key === "free" ? "free" : `${key}_${billingInterval}`;
            const plan = PLANS[planKey];
            if (!plan) return null;

            const isCurrent = currentPlanKey === planKey;
            const isHighlighted = key === "growth";
            const spec = planSpecs[key];

            let displayPrice = "";
            let regularPrice = null;
            let billedInfo = null;

            if (key === "free") {
              displayPrice = "Free/mo";
            } else {
              if (billingInterval === "annual") {
                if (isPromoActive) {
                  displayPrice = spec.annualPriceDesc;
                  regularPrice = `$${(parseFloat(spec.regAnnual.replace("$", "")) / 12).toFixed(2)}/mo`;
                  billedInfo = `${spec.billedDesc} (${spec.priceDesc} equivalent)`;
                } else {
                  displayPrice = `$${(parseFloat(spec.regAnnual.replace("$", "")) / 12).toFixed(2)}/mo`;
                  billedInfo = `Billed annually as ${spec.regAnnual} (${spec.regMonthly} equivalent)`;
                }
              } else {
                if (isPromoActive) {
                  displayPrice = spec.priceDesc;
                  regularPrice = spec.regMonthly;
                } else {
                  displayPrice = spec.regMonthly;
                }
              }
            }

            const isDowngradeOption = key === "free" && 
              (currentPlanKey.startsWith("standard") || currentPlanKey.startsWith("growth") || currentPlanKey.startsWith("pro"));

            return (
              <div
                key={key}
                style={getCardStyle(isHighlighted, isCurrent)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = "translateY(-4px)";
                  e.currentTarget.style.borderColor = isCurrent ? C.accent : isHighlighted ? "rgba(0, 196, 140, 0.6)" : "rgba(255, 255, 255, 0.15)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "translateY(0)";
                  e.currentTarget.style.borderColor = isCurrent ? C.accent : isHighlighted ? "rgba(0, 196, 140, 0.4)" : C.border;
                }}
              >
                {/* Visual Badges */}
                {isCurrent && (
                  <div style={{
                    position: "absolute",
                    top: 12,
                    right: 12,
                    backgroundColor: "rgba(0, 196, 140, 0.15)",
                    border: `1px solid rgba(0, 196, 140, 0.3)`,
                    color: C.accent,
                    fontSize: 9,
                    fontWeight: 900,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    padding: "2px 8px",
                    borderRadius: 9999,
                  }}>
                    Active
                  </div>
                )}
                {isHighlighted && (
                  <div style={{
                    position: "absolute",
                    top: -12,
                    left: "50%",
                    transform: "translateX(-50%)",
                    backgroundColor: C.accent,
                    color: "#03251c",
                    fontSize: 10,
                    fontWeight: 900,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    padding: "4px 14px",
                    borderRadius: 9999,
                    boxShadow: "0 10px 15px -3px rgba(0, 196, 140, 0.2)",
                    whiteSpace: "nowrap",
                  }}>
                    {spec.badge}
                  </div>
                )}

                {/* Card Top */}
                <div>
                  <div style={{ marginBottom: 16 }}>
                    <span style={{
                      color: C.muted,
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                      display: "block",
                      marginBottom: 4,
                    }}>
                      {key} tier
                    </span>
                    <h3 style={{
                      fontSize: 18,
                      fontWeight: 700,
                      color: C.text,
                      margin: 0,
                      letterSpacing: "-0.025em",
                    }}>{plan.name}</h3>
                  </div>

                  {/* Price */}
                  <div style={{ marginBottom: 24 }}>
                    <div style={{
                      display: "flex",
                      alignItems: "baseline",
                      flexWrap: "wrap",
                      gap: 6,
                    }}>
                      {key !== "free" && regularPrice && (
                        <span style={{
                          fontSize: 14,
                          color: C.muted,
                          textDecoration: "line-through",
                          marginRight: 4,
                          fontWeight: 500,
                        }}>
                          {regularPrice}
                        </span>
                      )}
                      <span style={{
                        fontSize: 30,
                        fontWeight: 800,
                        color: C.text,
                        letterSpacing: "-0.025em",
                      }}>
                        {key === "free" ? "$0" : displayPrice.split("/")[0]}
                      </span>
                      <span style={{
                        color: C.muted,
                        fontSize: 14,
                        fontWeight: 500,
                      }}>
                        /{key === "free" ? "mo" : displayPrice.split("/")[1]}
                      </span>
                    </div>

                    {/* Annual info */}
                    {billingInterval === "annual" && key !== "free" && billedInfo && (
                      <div style={{
                        fontSize: 11,
                        color: C.muted,
                        marginTop: 6,
                        fontWeight: 500,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}>
                        <span style={{
                          display: "inline-block",
                          width: 6,
                          height: 6,
                          borderRadius: 9999,
                          backgroundColor: C.accent,
                        }} />
                        {billedInfo}
                      </div>
                    )}
                  </div>

                  {/* Divider */}
                  <div style={{
                    height: 1,
                    backgroundColor: C.border,
                    marginBottom: 24,
                    border: "none",
                    marginTop: 16,
                  }} />

                  {/* Features */}
                  <ul style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                    marginBottom: 32,
                    padding: 0,
                    listStyle: "none",
                  }}>
                    {getTranslatedFeatures(plan.features, selectedPlatform).map((feat) => (
                      <li key={feat} style={{
                        display: "flex",
                        alignItems: "start",
                      }}>
                        <span style={{
                          color: C.accent,
                          marginRight: 8,
                          flexShrink: 0,
                          fontWeight: "bold",
                        }}>✓</span>
                        <span style={{
                          fontSize: 13,
                          color: "#d4d4d8",
                          lineHeight: 1.4,
                        }}>{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Card Action */}
                <div style={{ marginTop: "auto" }}>
                  {isCurrent ? (
                    <div style={{
                      width: "100%",
                      textAlign: "center",
                      padding: "12px 0",
                      borderRadius: 12,
                      fontSize: 12,
                      fontWeight: "bold",
                      border: `1px solid rgba(0, 196, 140, 0.2)`,
                      color: C.accent,
                      backgroundColor: "rgba(0, 196, 140, 0.05)",
                      cursor: "default",
                      boxSizing: "border-box",
                      display: "block",
                    }}>
                      Current Plan
                    </div>
                  ) : (
                    <Form method="post" style={{ margin: 0, padding: 0 }}>
                      <input type="hidden" name="intent" value="upgrade" />
                      <input type="hidden" name="plan" value={planKey} />
                      <button
                        type="submit"
                        style={getButtonStyle(isHighlighted)}
                        disabled={isSubmitting}
                        onMouseEnter={(e) => {
                          if (isHighlighted) {
                            e.currentTarget.style.backgroundColor = "#34d399";
                            e.currentTarget.style.transform = "scale(1.02)";
                          } else {
                            e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.05)";
                            e.currentTarget.style.borderColor = "rgba(255,255,255,0.2)";
                            e.currentTarget.style.transform = "scale(1.02)";
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (isHighlighted) {
                            e.currentTarget.style.backgroundColor = C.accent;
                            e.currentTarget.style.transform = "scale(1)";
                          } else {
                            e.currentTarget.style.backgroundColor = C.surface;
                            e.currentTarget.style.borderColor = C.border;
                            e.currentTarget.style.transform = "scale(1)";
                          }
                        }}
                      >
                        {isSubmitting
                          ? "Connecting..."
                          : isDowngradeOption
                          ? "Downgrade to Free"
                          : key === "free"
                          ? "Select Free"
                          : `Get ${plan.name.split(" ")[0]}`}
                      </button>
                    </Form>
                  )}
                </div>

              </div>
            );
          })}
        </div>

        {/* Sticky Billing Footnote */}
        <p style={{
          textAlign: "center",
          fontSize: 11,
          color: C.muted,
          marginTop: 48,
          maxWidth: 512,
          marginLeft: "auto",
          marginRight: "auto",
          lineHeight: 1.6,
        }}>
          Shopify manages all subscriptions securely. You can cancel or change your plan at any time. Moving between paid plans uses immediate replacement overrides.
        </p>

      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
```

---

## File: [app/routes/app.history.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/app.history.jsx)

```jsx
import { useState } from "react";
import { Form, useLoaderData, useNavigation, Link, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const statusFilter = url.searchParams.get("status") || "all";
  const orderSearch = url.searchParams.get("order") || "";
  const PAGE_SIZE = 50;

  const where = {
    shopDomain: shop,
    ...(statusFilter !== "all" ? { syncStatus: statusFilter } : {}),
    ...(orderSearch ? {
      OR: [
        { description: { contains: orderSearch, mode: "insensitive" } },
        { shopifyOrderId: { contains: orderSearch } }
      ]
    } : {}),
  };

  const [total, records] = await Promise.all([
    prisma.activityLog.count({ where }),
    prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    }),
  ]);

  return {
    shop,
    records: records.map((r) => ({
      id: r.id,
      shopifyOrderId: r.shopifyOrderId || "",
      eventType: r.eventType,
      description: r.description,
      syncStatus: r.syncStatus || "synced",
      externalTaskUrl: r.externalTaskUrl || "",
      createdAt: r.createdAt.toISOString(),
    })),
    page,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    total,
    statusFilter,
    orderSearch,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "retry_sync") {
    const recordId = parseInt(formData.get("recordId"), 10);
    try {
      const record = await prisma.activityLog.findFirst({ where: { id: recordId, shopDomain: shop } });
      if (!record) return { ok: false, error: "Record not found." };
      if (!record.shopifyOrderId) return { ok: false, error: "No Shopify Order ID found in this log." };
      
      const existingJob = await prisma.syncJob.findFirst({
        where: { shopDomain: shop, shopifyOrderId: record.shopifyOrderId },
        orderBy: { createdAt: "desc" },
      });
      if (existingJob?.payload) {
        await prisma.syncJob.update({
          where: { id: existingJob.id },
          data: { status: "pending", attempts: 0 },
        });
        await prisma.activityLog.update({ where: { id: recordId }, data: { syncStatus: "retrying" } });
        
        // Also update any matching OrderSyncRecords if they exist
        await prisma.orderSyncRecord.updateMany({
          where: { shopDomain: shop, shopifyOrderId: record.shopifyOrderId },
          data: { syncStatus: "retrying" }
        });
        
        return { ok: true, retried: true };
      }
      return { ok: false, error: "Original order payload not found." };
    } catch (err) {
      return { ok: false, error: "Retry failed: " + err.message };
    }
  }

  if (intent === "export_csv") {
    const sf = formData.get("statusFilter") || "all";
    const where = { shopDomain: shop, ...(sf !== "all" ? { syncStatus: sf } : {}) };
    const all = await prisma.activityLog.findMany({
      where, orderBy: { createdAt: "desc" }, take: 5000,
    });
    const header = "Log ID,Event Type,Description,Shopify Order ID,Status,Created At\n";
    const rows = all.map((r) =>
      [r.id, r.eventType, r.description, r.shopifyOrderId || "",
       r.syncStatus || "", new Date(r.createdAt).toISOString()]
        .map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(",")
    );
    return new Response(header + rows.join("\n"), {
      headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="syncup-history.csv"' },
    });
  }

  return { ok: false, error: "Unknown action." };
};

const C = { bg: "#0f0f0f", surface: "#1a1a1a", border: "#2a2a2a", text: "#ffffff", muted: "#9a9a9a", accent: "#00c48c" };

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

const SC = {
  synced:    { color: "#00c48c", bg: "rgba(0,196,140,0.12)", label: "Synced" },
  fulfilled: { color: "#00c48c", bg: "rgba(0,196,140,0.12)", label: "Fulfilled" },
  retrying:  { color: "#ff9900", bg: "rgba(255,153,0,0.12)", label: "Retrying" },
  failed:    { color: "#ff4444", bg: "rgba(255,68,68,0.12)", label: "Failed" },
};

export default function HistoryPage() {
  const { records, page, totalPages, total, statusFilter, orderSearch } = useLoaderData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [searchVal, setSearchVal] = useState(orderSearch || "");
  const [searchParams] = useSearchParams();

  // Helper to preserve shop and host during link filtering / pagination transitions
  const getFilterUrl = (status, order, newPage) => {
    const params = new URLSearchParams(searchParams);
    if (status !== undefined) params.set("status", status);
    if (order !== undefined) params.set("order", order);
    if (newPage !== undefined) params.set("page", String(newPage));
    return `/app/history?${params.toString()}`;
  };

  const shopVal = searchParams.get("shop") || "";
  const hostVal = searchParams.get("host") || "";

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "system-ui,-apple-system,sans-serif" }}>
      <style>{".sh-row:hover{background:rgba(255,255,255,0.025)!important}@media(max-width:640px){.sh-hide{display:none!important}}"}</style>
      <div style={{ maxWidth: 920, margin: "0 auto", padding: "28px 20px" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
          <div>
            <Link to={`/app?shop=${encodeURIComponent(shopVal)}&host=${encodeURIComponent(hostVal)}`} style={{ color: C.accent, textDecoration: "none", fontSize: 13, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 10 }}>
              {"<"} Back to dashboard
            </Link>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Activity & Sync History</h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: C.muted }}>{total.toLocaleString()} total records</p>
          </div>
          <Form method="post">
            <input type="hidden" name="intent" value="export_csv" />
            <input type="hidden" name="statusFilter" value={statusFilter} />
            <button type="submit" disabled={isSubmitting} style={{ background: C.surface, border: "1px solid " + C.border, color: C.muted, padding: "8px 16px", borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: "pointer", outline: "none" }}>
              Export CSV
            </button>
          </Form>
        </div>

        {/* Filters */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          {["all", "synced", "fulfilled", "failed", "retrying"].map((s) => (
            <Link key={s} to={getFilterUrl(s, searchVal, 1)} style={{ padding: "5px 14px", borderRadius: 20, fontSize: 12, fontWeight: 600, textDecoration: "none", border: statusFilter === s ? "1px solid " + C.accent : "1px solid " + C.border, color: statusFilter === s ? C.accent : C.muted, background: statusFilter === s ? "rgba(0,196,140,0.08)" : "transparent" }}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </Link>
          ))}
          <Form method="get" action="/app/history" style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
            <input type="hidden" name="shop" value={shopVal} />
            <input type="hidden" name="host" value={hostVal} />
            <input type="hidden" name="status" value={statusFilter} />
            <input name="order" type="text" placeholder="Search logs..." value={searchVal} onChange={(e) => setSearchVal(e.currentTarget.value)} style={{ background: C.surface, border: "1px solid " + C.border, color: C.text, padding: "7px 12px", borderRadius: 8, fontSize: 12, outline: "none", width: 170 }} />
            <button type="submit" style={{ background: C.accent, border: "none", color: "#03251c", padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Search</button>
          </Form>
        </div>

        {/* Table */}
        <div style={{ border: "1px solid " + C.border, borderRadius: 14, overflow: "hidden", background: "#111" }}>
          {/* Header row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 140px 100px 90px 70px", padding: "12px 16px", background: "#161616", borderBottom: "1px solid " + C.border, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: C.muted }}>
            <div>Event Description</div>
            <div>Type</div>
            <div>Time</div>
            <div>Status</div>
            <div>Action</div>
          </div>

          {records.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: C.muted, fontSize: 13 }}>No activity logs found.</div>
          ) : (
            records.map((r) => {
              const sc = SC[r.syncStatus] || SC.synced;
              return (
                <div key={r.id} className="sh-row" style={{ display: "grid", gridTemplateColumns: "1fr 140px 100px 90px 70px", padding: "12px 16px", borderBottom: "1px solid " + C.border, alignItems: "center", transition: "background 0.1s" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
                    {r.externalTaskUrl ? (
                      <a href={r.externalTaskUrl} target="_blank" rel="noopener noreferrer" style={{ color: C.accent, textDecoration: "underline" }}>
                        {r.description}
                      </a>
                    ) : (
                      r.description
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase" }}>{r.eventType.replace(/_/g, " ")}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>{timeAgo(r.createdAt)}</div>
                  <div>
                    {r.shopifyOrderId ? (
                      <span style={{ fontSize: 10, fontWeight: 700, color: sc.color, background: sc.bg, border: "1px solid " + sc.color + "44", padding: "2px 8px", borderRadius: 8, textTransform: "uppercase", whiteSpace: "nowrap" }}>
                        {sc.label}
                      </span>
                    ) : (
                      <span style={{ fontSize: 10, fontWeight: 700, color: C.muted, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", padding: "2px 8px", borderRadius: 8, textTransform: "uppercase", whiteSpace: "nowrap" }}>
                        System
                      </span>
                    )}
                  </div>
                  <div>
                    {r.syncStatus === "failed" && r.shopifyOrderId && (
                      <Form method="post">
                        <input type="hidden" name="intent" value="retry_sync" />
                        <input type="hidden" name="recordId" value={r.id} />
                        <button type="submit" disabled={isSubmitting} style={{ background: "rgba(255,153,0,0.12)", border: "1px solid rgba(255,153,0,0.3)", color: "#ff9900", padding: "3px 10px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer", outline: "none" }}>
                          Retry
                        </button>
                      </Form>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 20 }}>
            {page > 1 && (
              <Link to={getFilterUrl(statusFilter, orderSearch, page - 1)} style={{ padding: "6px 14px", borderRadius: 8, background: C.surface, border: "1px solid " + C.border, color: C.muted, fontSize: 13, textDecoration: "none", fontWeight: 600 }}>Prev</Link>
            )}
            <span style={{ padding: "6px 14px", fontSize: 13, color: C.muted }}>Page {page} of {totalPages}</span>
            {page < totalPages && (
              <Link to={getFilterUrl(statusFilter, orderSearch, page + 1)} style={{ padding: "6px 14px", borderRadius: 8, background: C.surface, border: "1px solid " + C.border, color: C.muted, fontSize: 13, textDecoration: "none", fontWeight: 600 }}>Next</Link>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

export function ErrorBoundary() {
  return (
    <div style={{ padding: 32, color: "#ff4444", fontFamily: "system-ui" }}>
      Something went wrong loading sync history.
    </div>
  );
}
```

---

## File: [app/routes/app.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/app.jsx)

```jsx
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
```

---

## File: [app/routes/app.session-token.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/app.session-token.jsx)

```jsx
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return Response.json({ ok: true });
};

```

---

## File: [app/routes/app._index.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/app._index.jsx)

```jsx
import { useState, useEffect, useMemo } from "react";
import { Form, useLoaderData, useActionData, useNavigation, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getOrCreateSubscription, getTrialBannerStatus, isSubscriptionActive } from "../billing.server";
import { signState } from "../oauth-state.server";
import { PLANS, getTranslatedFeatures } from "../plans";
import prisma from "../db.server";

// Global API Cache to speed up navigation on and off other routes (like Billing)
if (!globalThis.apiCache) {
  globalThis.apiCache = {
    targets: new Map(),
    fields: new Map(),
    orders: new Map(),
  };
}
const CACHE_TTL = 3 * 60 * 1000; // 3 minutes

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const { getConnection, getRecentActivity } = await import("../clickup.server");

  const [connection, subscription, recentActivity] = await Promise.all([
    getConnection(shop),
    getOrCreateSubscription(shop),
    getRecentActivity(shop, 5),
  ]);

  let lists = [];
  let listError = null;

  let healthStatus = connection?.healthStatus || "healthy";
  if (connection?.accessToken) {
    // Throttled connection health check (run at most once every 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    if (!connection.lastHealthCheck || new Date(connection.lastHealthCheck) < fiveMinutesAgo) {
      // Run health check in background to prevent blocking loader response and causing navigation latency
      (async () => {
        try {
          let healthy = false;
          if (connection.selectedPlatform === "clickup") {
            const res = await fetch("https://api.clickup.com/api/v2/user", {
              headers: { Authorization: connection.accessToken },
            });
            healthy = res.status === 200;
          } else if (connection.selectedPlatform === "monday") {
            const res = await fetch("https://api.monday.com/v2", {
              method: "POST",
              headers: {
                Authorization: connection.accessToken,
                "Content-Type": "application/json",
                "API-Version": "2023-10",
              },
              body: JSON.stringify({ query: "{ me { id } }" }),
            });
            healthy = res.status === 200;
          } else if (connection.selectedPlatform === "notion") {
            const res = await fetch("https://api.notion.com/v1/users/me", {
              headers: {
                Authorization: `Bearer ${connection.accessToken}`,
                "Notion-Version": "2022-06-28",
              },
            });
            healthy = res.status === 200;
          }

          const updatedHealth = healthy ? "healthy" : "error";
          await prisma.platformConnection.update({
            where: { id: connection.id },
            data: {
              healthStatus: updatedHealth,
              lastHealthCheck: new Date(),
            },
          });
        } catch (err) {
          console.error("Background health check failed:", err);
          try {
            await prisma.platformConnection.update({
              where: { id: connection.id },
              data: { healthStatus: "error", lastHealthCheck: new Date() },
            });
          } catch (dbErr) {
            console.error("Failed to update health check error in DB:", dbErr);
          }
        }
      })();
    }

    try {
      const cacheKey = `${shop}:${connection.selectedPlatform}:${connection.accessToken}`;
      const now = Date.now();
      const cachedTargets = globalThis.apiCache.targets.get(cacheKey);
      if (cachedTargets && (now - cachedTargets.timestamp < CACHE_TTL)) {
        lists = cachedTargets.data;
      } else {
        const { IntegrationFactory } = await import("../adapters/factory");
        const adapter = await IntegrationFactory.getAdapter(connection.selectedPlatform, connection.accessToken);
        lists = await adapter.fetchTargets();
        globalThis.apiCache.targets.set(cacheKey, { data: lists, timestamp: now });
      }
    } catch (error) {
      console.error(`Failed to load targets for ${shop}:`, error);
      listError = `We couldn't load your resources from ${connection.selectedPlatform === "clickup" ? "ClickUp" : connection.selectedPlatform === "monday" ? "Monday.com" : "Notion"}. Try disconnecting and reconnecting.`;
    }
  }

  const url = new URL(request.url);
  const billingSuccess = url.searchParams.get("billing_success") === "1";
  const clickupError = url.searchParams.get("clickup_error") || null;
  const removedLists = url.searchParams.get("removed_lists") || null;

  const trialBanner = getTrialBannerStatus(subscription);
  const isTrialOrSubscriptionActive = isSubscriptionActive(subscription);

  let syncStatus = "not_configured";
  if (connection?.accessToken && (connection?.listId || connection?.listConnections?.length > 0)) {
    syncStatus = isTrialOrSubscriptionActive ? "active" : "paused";
  }

  const totalSyncedMonth = subscription.ordersSyncedThisMonth || 0;
  const totalSyncedAllTime = subscription.ordersSyncedAllTime || 0;

  const totalTasks = await prisma.orderSyncRecord.count({ where: { shopDomain: shop } });
  const failedTasks = await prisma.orderSyncRecord.count({
    where: { shopDomain: shop, syncStatus: "failed" },
  });
  const successRate = totalTasks === 0 ? 100 : Math.round(((totalTasks - failedTasks) / totalTasks) * 100);

  // 1. Count failed jobs
  const failedJobsCount = await prisma.syncJob.count({
    where: { shopDomain: shop, status: "failed" },
  });

  // 2. Fetch last sync time
  const lastSyncRecord = await prisma.orderSyncRecord.findFirst({
    where: { shopDomain: shop, syncStatus: { in: ["synced", "fulfilled"] } },
    orderBy: { createdAt: "desc" },
  });
  const lastSyncTime = lastSyncRecord ? lastSyncRecord.createdAt.toISOString() : null;

  // 3. Count orders synced today
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const syncedToday = await prisma.orderSyncRecord.count({
    where: {
      shopDomain: shop,
      createdAt: { gte: startOfToday },
      syncStatus: { in: ["synced", "fulfilled"] },
    },
  });

  const recentTasks = await prisma.orderSyncRecord.findMany({
    where: { shopDomain: shop },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const plan = PLANS[subscription.planName] || (subscription.planName === "trial" ? { name: "Free Trial", listLimit: 5 } : { name: "Expired/Cancelled", listLimit: 1 });
  const listLimit = plan.listLimit || 1;

  let clickupFields = [];
  let fieldMappings = null;

  if (connection?.accessToken) {
    fieldMappings = connection.fieldMappings ? JSON.parse(connection.fieldMappings) : null;
    if (connection.listId) {
      const isGrowthOrPro =
        subscription.planName.startsWith("growth") ||
        subscription.planName.startsWith("pro") ||
        subscription.planName === "trial";
      if (isGrowthOrPro) {
        try {
          const cacheKey = `${shop}:${connection.selectedPlatform}:${connection.listId}:${connection.accessToken}`;
          const now = Date.now();
          const cachedFields = globalThis.apiCache.fields.get(cacheKey);
          if (cachedFields && (now - cachedFields.timestamp < CACHE_TTL)) {
            clickupFields = cachedFields.data;
          } else {
            const { IntegrationFactory } = await import("../adapters/factory");
            const adapter = await IntegrationFactory.getAdapter(connection.selectedPlatform, connection.accessToken);
            clickupFields = await adapter.fetchFields(connection.listId);
            globalThis.apiCache.fields.set(cacheKey, { data: clickupFields, timestamp: now });
          }
        } catch (e) {
          console.error("Failed to load destination fields in loader:", e);
        }
      }
    }
  }

  // Fetch latest Shopify order for real-time preview (with cache)
  let latestOrder = null;
  const orderCacheKey = `${shop}`;
  const cachedOrder = globalThis.apiCache.orders?.get(orderCacheKey);
  const now = Date.now();

  if (cachedOrder && (now - cachedOrder.timestamp < CACHE_TTL)) {
    latestOrder = cachedOrder.data;
  } else {
    try {
      const response = await admin.graphql(`#graphql
        query GetLatestOrderForPreview {
          orders(first: 1, reverse: true) {
            nodes {
              id
              name
              totalPriceSet {
                presentmentMoney {
                  amount
                  currencyCode
                }
              }
              financialStatus
              createdAt
              customer {
                firstName
                lastName
                email
                phone
              }
              lineItems(first: 10) {
                nodes {
                  id
                  title
                  quantity
                  sku
                }
              }
              shippingLines(first: 1) {
                nodes {
                  title
                }
              }
            }
          }
        }
      `);

      const responseJson = await response.json();
      const orderNode = responseJson.data?.orders?.nodes?.[0];
      if (orderNode) {
        latestOrder = {
          id: orderNode.id.split("/").pop(),
          order_number: orderNode.name.replace(/^#/, ""),
          number: orderNode.name,
          total_price: orderNode.totalPriceSet?.presentmentMoney?.amount || "0.00",
          currency: orderNode.totalPriceSet?.presentmentMoney?.currencyCode || "USD",
          created_at: orderNode.createdAt,
          financial_status: orderNode.financialStatus?.toLowerCase() || "",
          customer: orderNode.customer ? {
            first_name: orderNode.customer.firstName || "",
            last_name: orderNode.customer.lastName || "",
            email: orderNode.customer.email || "",
            phone: orderNode.customer.phone || "",
            name: [orderNode.customer.firstName, orderNode.customer.lastName].filter(Boolean).join(" ")
          } : null,
          line_items: orderNode.lineItems?.nodes?.map(li => ({
            id: li.id.split("/").pop(),
            title: li.title,
            quantity: li.quantity,
            sku: li.sku || ""
          })) || [],
          shipping_lines: orderNode.shippingLines?.nodes?.map(sl => ({
            title: sl.title
          })) || []
        };
        globalThis.apiCache.orders.set(orderCacheKey, { data: latestOrder, timestamp: now });
      }
    } catch (err) {
      console.error("Failed to query latest Shopify order via GraphQL:", err);
    }
  }

  if (!latestOrder) {
    latestOrder = {
      id: "999999999",
      order_number: "1001",
      number: "#1001",
      total_price: "159.50",
      currency: "USD",
      created_at: new Date().toISOString(),
      financial_status: "paid",
      customer: {
        first_name: "John",
        last_name: "Doe",
        email: "john.doe@example.com",
        phone: "+15559876543",
        name: "John Doe"
      },
      line_items: [
        { id: "101", title: "Premium Leather Boot", quantity: 1, sku: "BOOT-PREM-L" },
        { id: "102", title: "Organic Cotton Sock", quantity: 3, sku: "SOCK-ORG-C" }
      ],
      shipping_lines: [
        { title: "Standard Expedited Courier" }
      ]
    };
  }

  return {
    shop,
    email: session.email || null,
    clickupConnectState: await signState(shop),
    connected: Boolean(connection?.accessToken),
    healthStatus,
    selectedPlatform: connection?.selectedPlatform || "clickup",
    workspaceName: connection?.workspaceName || null,
    listConnections: connection?.listConnections || [],
    lists,
    listError,
    clickupFields,
    fieldMappings,
    latestOrder,
    // Merchant-configurable sync settings
    taskNameTemplate: subscription.taskNameTemplate || "",
    taskDescriptionTemplate: subscription.taskDescriptionTemplate || "",
    syncTrigger: subscription.syncTrigger || "payment_confirmed",
    subtasksEnabled: subscription.subtasksEnabled || false,
    twoWaySyncEnabled: subscription.twoWaySyncEnabled || false,
    subscription: {
      planName: subscription.planName,
      status: subscription.status,
      trialEndDate: subscription.trialEndDate ? subscription.trialEndDate.toISOString() : null,
      billingCycleStart: subscription.billingCycleStart ? subscription.billingCycleStart.toISOString() : null,
    },
    trialBanner,
    isTrialOrSubscriptionActive,
    syncStatus,
    billingSuccess,
    clickupError,
    removedLists,
    listLimit,
    isFreePlan: connection?.isFreePlan || false,
    failedJobsCount,
    lastSyncTime,
    syncedToday,
    analytics: {
      totalSyncedMonth,
      totalSyncedAllTime,
      successRate,
      recentTasks: recentTasks.map((t) => ({
        id: t.id,
        shopifyOrderId: t.shopifyOrderId,
        orderNumber: t.orderNumber || `#${t.shopifyOrderId.slice(-6)}`,
        status: t.syncStatus,
        createdAt: t.createdAt.toISOString(),
      })),
    },
    recentActivity: recentActivity.map((a) => ({
      id: a.id,
      eventType: a.eventType,
      description: a.description,
      createdAt: a.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  const { getConnection, disconnect, logActivity, saveListConnections } = await import("../clickup.server");

  if (intent === "join_waitlist") {
    const platform = formData.get("platform");
    const waitlistEmail = formData.get("email") || "";
    await prisma.activityLog.create({
      data: {
        shopDomain: shop,
        eventType: "waitlist_joined",
        description: `Joined ${platform === "monday" ? "Monday.com" : "Notion"} integration private beta waitlist (${waitlistEmail})`
      }
    });
    return { ok: true, joinedWaitlist: platform, waitlistEmail };
  }

  if (intent === "disconnect") {
    const connection = await getConnection(shop);
    const platformName = connection?.selectedPlatform === "clickup" ? "ClickUp" : connection?.selectedPlatform === "monday" ? "Monday.com" : "Notion";
    await disconnect(shop);
    logActivity(shop, "clickup_disconnected", `${platformName} account disconnected`);
    return { ok: true, disconnected: true };
  }

  if (intent === "retry_all_failed_syncs") {
    try {
      const failedJobs = await prisma.syncJob.findMany({
        where: { shopDomain: shop, status: "failed" },
      });
      if (failedJobs.length === 0) {
        return { ok: true, retriedAllFailed: true, retriedCount: 0 };
      }

      const jobIds = failedJobs.map((j) => j.id);
      const orderIds = failedJobs.map((j) => j.shopifyOrderId);

      await prisma.syncJob.updateMany({
        where: { id: { in: jobIds } },
        data: { status: "pending", attempts: 0 },
      });

      await prisma.orderSyncRecord.updateMany({
        where: { shopDomain: shop, shopifyOrderId: { in: orderIds } },
        data: { syncStatus: "retrying" },
      });

      await prisma.activityLog.updateMany({
        where: { shopDomain: shop, shopifyOrderId: { in: orderIds }, syncStatus: "failed" },
        data: { syncStatus: "retrying" },
      });

      logActivity(shop, "sync_retried", `Retried ${failedJobs.length} failed sync job(s)`);
      return { ok: true, retriedAllFailed: true, retriedCount: failedJobs.length };
    } catch (e) {
      return { ok: false, error: "We couldn't retry the failed syncs. Please refresh the page and try again." };
    }
  }

  if (intent === "save_connections") {
    const jsonStr = formData.get("listConnectionsJson");
    if (!jsonStr) {
      return { ok: false, error: "No connection data provided." };
    }

    try {
      const conns = JSON.parse(String(jsonStr));
      if (conns.length === 0) {
        return { ok: false, error: "Please configure at least one list connection." };
      }

      const sub = await getOrCreateSubscription(shop);
      const plan = PLANS[sub.planName] || (sub.planName === "trial" ? { listLimit: 5 } : { listLimit: 1 });
      const limit = plan.listLimit || 1;

      if (conns.length > limit) {
        return { ok: false, error: `Your current plan supports up to ${limit} list connection(s).` };
      }

      if (conns.some((c) => !c.id)) {
        return { ok: false, error: "Please choose a list for all connections." };
      }

      await saveListConnections(shop, conns);
      return { ok: true, saved: true };
    } catch (e) {
      return { ok: false, error: "We couldn't save your list connections. Verify your platform account has active permissions." };
    }
  }

  if (intent === "connect_platform") {
    const platform = formData.get("platform");
    const token = formData.get("token");
    if (!token) {
      return { ok: false, error: "API token is required." };
    }

    try {
      const { IntegrationFactory } = await import("../adapters/factory");
      const adapter = await IntegrationFactory.getAdapter(platform, token);
      const connected = await adapter.testConnection();
      if (!connected) {
        return { ok: false, error: "Failed to verify connection. Please verify your API token and try again." };
      }

      const { encryptToken } = await import("../crypto.server");
      const encryptedToken = await encryptToken(token);

      // Deactivate any other active provider connection
      const activeConnections = await prisma.platformConnection.findMany({
        where: { shopDomain: shop, isActive: true }
      });
      for (const oldConn of activeConnections) {
        if (oldConn.provider !== platform.toUpperCase()) {
          await prisma.syncTarget.updateMany({
            where: { connectionId: oldConn.id },
            data: { isActive: false }
          });
          await prisma.platformConnection.update({
            where: { id: oldConn.id },
            data: { isActive: false }
          });
        }
      }

      // Upsert new connection
      const conn = await prisma.platformConnection.upsert({
        where: {
          shopDomain_provider: {
            shopDomain: shop,
            provider: platform.toUpperCase()
          }
        },
        update: {
          encryptedAccessToken: encryptedToken,
          isActive: true
        },
        create: {
          shopDomain: shop,
          provider: platform.toUpperCase(),
          encryptedAccessToken: encryptedToken,
          isActive: true
        }
      });

      // Upsert metadata
      if (platform === "monday") {
        await prisma.mondayMetadata.upsert({
          where: { connectionId: conn.id },
          update: { workspaceId: "monday_default", fieldMappings: "[]" },
          create: { connectionId: conn.id, workspaceId: "monday_default", fieldMappings: "[]" }
        });
      } else if (platform === "notion") {
        await prisma.notionMetadata.upsert({
          where: { connectionId: conn.id },
          update: { workspaceId: "notion_default", fieldMappings: "[]" },
          create: { connectionId: conn.id, workspaceId: "notion_default", fieldMappings: "[]" }
        });
      }

      logActivity(shop, "clickup_connected", `${platform === "monday" ? "Monday.com" : "Notion"} connected successfully`);
      return { ok: true, connectedPlatform: platform };
    } catch (err) {
      console.error(`Failed to connect ${platform}:`, err);
      return { ok: false, error: "Failed to verify connection. Please verify your API token and try again." };
    }
  }

  if (intent === "save_field_mappings") {
    const jsonStr = formData.get("fieldMappingsJson");
    if (!jsonStr) {
      return { ok: false, error: "No mapping data provided." };
    }
    try {
      const parsed = JSON.parse(String(jsonStr));
      if (!Array.isArray(parsed)) {
        return { ok: false, error: "Invalid mapping data format." };
      }
      if (parsed.length > 100) {
        return { ok: false, error: "You cannot map more than 100 fields." };
      }
      for (const m of parsed) {
        if (!m.clickupFieldId || !m.shopifySourceField) {
          return { ok: false, error: "Invalid mapping configuration." };
        }
      }

      const activeConn = await prisma.platformConnection.findFirst({
        where: { shopDomain: shop, isActive: true }
      });
      if (!activeConn) {
        return { ok: false, error: "No active connection found." };
      }

      if (activeConn.provider === "CLICKUP") {
        await prisma.clickUpMetadata.update({
          where: { connectionId: activeConn.id },
          data: { fieldMappings: JSON.stringify(parsed) },
        });
      } else if (activeConn.provider === "MONDAY") {
        await prisma.mondayMetadata.update({
          where: { connectionId: activeConn.id },
          data: { fieldMappings: JSON.stringify(parsed) },
        });
      } else if (activeConn.provider === "NOTION") {
        await prisma.notionMetadata.update({
          where: { connectionId: activeConn.id },
          data: { fieldMappings: JSON.stringify(parsed) },
        });
      }

      return { ok: true, savedMappings: true };
    } catch (e) {
      return { ok: false, error: "We couldn't save your field mappings. Please ensure the column selections are correct." };
    }
  }

  if (intent === "send_test_task") {
    try {
      const connection = await getConnection(shop);
      if (!connection?.accessToken || !connection.listId) {
        return { ok: false, error: "Please configure and save a target connection first." };
      }

      const { IntegrationFactory } = await import("../adapters/factory");
      const adapter = await IntegrationFactory.getAdapter(connection.selectedPlatform, connection.accessToken);

      const mockOrderNumber = "9999-TEST";
      const mockCustomerName = "Jane Doe";
      const mockEmail = "jane.doe@example.com";
      const mockPhone = "+1 555-0199";
      const mockAddress = "123 Main St, Seattle, WA 98101, United States";
      const mockNote = "Engrave initials 'J.D.' on cuff";
      const mockCreatedAt = new Date().toISOString();

      const mockTaskName = `Order #${mockOrderNumber} — ${mockCustomerName}`;
      const mockDescription = `👤 Customer:
   Name:  ${mockCustomerName}
   Email: ${mockEmail}
   Phone: ${mockPhone}

 📦 Items:
   • 1x Custom Embroidered Hoodie [Hoodie-01]

 💰 Subtotal: USD 45.00
 🚚 Shipping: USD 5.00
    Total:    USD 50.00
 ✅ Payment: paid

 📍 Ship to: ${mockAddress}

 📝 Notes: ${mockNote}

 🔗 View order: https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/, "")}/orders/test`;

      const orderCreatedAt = Date.now();
      const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

      await adapter.createRecord(connection.listId, {
        name: mockTaskName,
        description: mockDescription,
        priority: 3,
        startDate: orderCreatedAt,
        dueDate: orderCreatedAt + twoDaysMs,
        tags: ["shopify-order", "test-sync"],
        rawOrder: {
          id: "9999-TEST",
          order_number: mockOrderNumber,
          customer: { first_name: "Jane", last_name: "Doe", email: mockEmail, phone: mockPhone },
          total_price: "50.00",
          subtotal_price: "45.00",
          shipping_lines: [{ price: "5.00" }],
          shipping_address: { address1: "123 Main St", city: "Seattle", province: "WA", zip: "98101", country: "United States" },
          note: mockNote,
          created_at: mockCreatedAt
        },
        customerName: mockCustomerName,
        shippingCost: "5.00",
        fieldMappings: connection.fieldMappings,
        isFreePlan: connection.isFreePlan,
        subtasks: ["1x Custom Embroidered Hoodie"],
        attachments: []
      });

      logActivity(shop, "order_synced", `Sent test record (Order #${mockOrderNumber}) to ${connection.selectedPlatform === "clickup" ? "ClickUp" : connection.selectedPlatform === "monday" ? "Monday.com" : "Notion"}`);
      return { ok: true, sentTestTask: true };
    } catch (e) {
      return { ok: false, error: "We couldn't create the test task. Your selected list/board may have been moved or deleted." };
    }
  }

  if (intent === "save_settings") {
    try {
      const rawTemplate = formData.get("taskNameTemplate") || "";
      const rawDescTemplate = formData.get("taskDescriptionTemplate") || "";
      const syncTrigger = formData.get("syncTrigger") || "payment_confirmed";
      const subtasksEnabled = formData.get("subtasksEnabled") === "true";
      const twoWaySyncEnabled = formData.get("twoWaySyncEnabled") === "true";

      const validTriggers = ["payment_confirmed", "on_create", "on_fulfillment_start"];
      if (!validTriggers.includes(syncTrigger)) {
        return { ok: false, error: "Invalid sync trigger value." };
      }

      const sub = await getOrCreateSubscription(shop);
      const isGrowthOrPro =
        sub.planName.startsWith("growth") ||
        sub.planName.startsWith("pro") ||
        sub.planName === "trial";

      await prisma.subscription.update({
        where: { shopDomain: shop },
        data: {
          taskNameTemplate: rawTemplate.trim() || null,
          taskDescriptionTemplate: isGrowthOrPro ? (rawDescTemplate.trim() || null) : null,
          syncTrigger,
          subtasksEnabled: isGrowthOrPro ? subtasksEnabled : false,
          twoWaySyncEnabled: isGrowthOrPro ? twoWaySyncEnabled : false,
        },
      });

      return { ok: true, savedSettings: true };
    } catch (e) {
      return { ok: false, error: "We couldn't save your settings. Please verify the templates and triggers." };
    }
  }

  return { ok: false, error: "Unknown action." };
};

const C = {
  bg: "#0f0f0f",
  surface: "#1a1a1a",
  border: "#2a2a2a",
  text: "#ffffff",
  muted: "#9a9a9a",
  accent: "#00c48c",
};

const SHOPIFY_SOURCE_FIELDS = [
  { id: "order_number", label: "Order Number (e.g. #1001)", type: "string" },
  { id: "customer_name", label: "Customer Name (e.g. John Doe)", type: "string" },
  { id: "customer_email", label: "Customer Email", type: "email" },
  { id: "customer_phone", label: "Customer Phone", type: "phone" },
  { id: "total_price", label: "Order Total Price", type: "currency" },
  { id: "subtotal_price", label: "Subtotal Price", type: "currency" },
  { id: "shipping_price", label: "Shipping Cost", type: "currency" },
  { id: "shipping_address", label: "Shipping Address", type: "string" },
  { id: "order_notes", label: "Order Notes / Comments", type: "string" },
  { id: "created_at", label: "Order Creation Date", type: "date" },
];

function timeAgo(isoString) {
  const seconds = Math.floor((Date.now() - new Date(isoString)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function checkFieldCompatibility(shopifyType, destType, platform) {
  if (!shopifyType || !destType) return { valid: true };

  const sType = shopifyType.toLowerCase();
  const dType = destType.toLowerCase();

  // Text/string destinations can receive anything
  const isTextDest =
    dType.includes("text") ||
    dType.includes("string") ||
    dType === "title" ||
    dType === "rich_text" ||
    dType === "long_text" ||
    dType === "short_text" ||
    dType === "name" ||
    dType === "url";

  if (isTextDest) {
    return { valid: true };
  }

  // Number/currency destinations
  if (dType === "number" || dType === "numeric" || dType === "currency") {
    if (sType === "currency") {
      return { valid: true };
    }
    return {
      valid: false,
      message: `Mapping a ${sType} to a numeric field might cause format or sync errors.`,
      tone: "warning"
    };
  }

  // Date destinations
  if (dType === "date" || dType === "created_time") {
    if (sType === "date") {
      return { valid: true };
    }
    return {
      valid: false,
      message: `Mapping a ${sType} to a date field will fail to parse correctly.`,
      tone: "critical"
    };
  }

  // Email destinations
  if (dType === "email") {
    if (sType === "email") {
      return { valid: true };
    }
    return {
      valid: false,
      message: `A non-email field mapped to an email property might be rejected.`,
      tone: "warning"
    };
  }

  // Phone destinations
  if (dType === "phone" || dType === "phone_number") {
    if (sType === "phone") {
      return { valid: true };
    }
    return {
      valid: false,
      message: `A non-phone field mapped to a phone property might be rejected.`,
      tone: "warning"
    };
  }

  // Dropdowns/checkboxes/selects/etc.
  if (dType === "checkbox" || dType === "boolean") {
    return {
      valid: false,
      message: `Target is a checkbox. We recommend mapping boolean/toggle values.`,
      tone: "warning"
    };
  }

  return { valid: true };
}

const EVENT_ICONS = {
  order_synced: "✓",
  order_fulfilled: "✓",
  sync_failed: "✗",
  sync_retried: "⚡",
  trial_started: "⚡",
  trial_expired: "✗",
  plan_activated: "✓",
  plan_cancelled: "✗",
  clickup_connected: "⚡",
  clickup_disconnected: "✗",
};

const EVENT_COLORS = {
  order_synced: C.accent,
  order_fulfilled: C.accent,
  sync_failed: "#ff4444",
  sync_retried: "#ff9900",
  trial_started: C.accent,
  trial_expired: "#ff4444",
  plan_activated: C.accent,
  plan_cancelled: "#ff4444",
  clickup_connected: C.accent,
  clickup_disconnected: "#ff4444",
};

const SYNC_STATUS_CONFIG = {
  active: { label: "Syncing Active", color: C.accent, bg: "rgba(0,196,140,0.12)", dot: C.accent },
  paused: { label: "Syncing Paused", color: "#ff9900", bg: "rgba(255,153,0,0.12)", dot: "#ff9900" },
  not_configured: { label: "Finish Setup", color: C.muted, bg: "rgba(154,154,154,0.1)", dot: C.muted },
};

const BANNER_COLORS = {
  green: { bg: "rgba(0,196,140,0.12)", border: "1px solid #00c48c", color: "#00c48c" },
  yellow: { bg: "rgba(255,153,0,0.12)", border: "1px solid #ff9900", color: "#ff9900" },
  orange: { bg: "rgba(255,102,0,0.12)", border: "1px solid #ff6600", color: "#ff6600" },
  red: { bg: "rgba(255,68,68,0.12)", border: "1px solid #ff4444", color: "#ff4444" },
};

function InfoTooltip({ text }) {
  const [visible, setVisible] = useState(false);

  return (
    <span
      style={{
        position: "relative",
        display: "inline-block",
        cursor: "pointer",
        marginLeft: 4,
        userSelect: "none",
      }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onClick={(e) => {
        e.stopPropagation();
        setVisible(!visible);
      }}
    >
      <span style={{ color: "#9a9a9a", fontSize: 13 }}>ⓘ</span>
      {visible && (
        <span
          style={{
            position: "absolute",
            bottom: "135%",
            left: "50%",
            transform: "translateX(-50%)",
            backgroundColor: "#1c1c1c",
            color: "#ffffff",
            padding: "8px 12px",
            borderRadius: "6px",
            border: "1px solid #333333",
            boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
            fontSize: "12px",
            lineHeight: "1.4",
            width: "220px",
            whiteSpace: "normal",
            zIndex: 99999,
            pointerEvents: "none",
            display: "block",
            textAlign: "left",
            fontWeight: "normal",
            fontStyle: "normal",
          }}
        >
          {text}
          <span
            style={{
              position: "absolute",
              top: "100%",
              left: "50%",
              transform: "translateX(-50%)",
              borderWidth: "5px",
              borderStyle: "solid",
              borderColor: "#333333 transparent transparent transparent",
            }}
          />
          <span
            style={{
              position: "absolute",
              top: "100%",
              left: "50%",
              transform: "translateX(-50%)",
              borderWidth: "4px",
              borderStyle: "solid",
              borderColor: "#1c1c1c transparent transparent transparent",
              marginTop: "-1px",
            }}
          />
        </span>
      )}
    </span>
  );
}

export default function Index() {
  const {
    shop,
    clickupConnectState,
    connected,
    healthStatus,
    selectedPlatform,
    workspaceName,
    listConnections,
    lists,
    clickupFields,
    fieldMappings,
    latestOrder,
    taskNameTemplate,
    taskDescriptionTemplate,
    syncTrigger,
    subtasksEnabled,
    twoWaySyncEnabled,
    subscription,
    trialBanner,
    isTrialOrSubscriptionActive,
    syncStatus,
    billingSuccess,
    clickupError,
    removedLists,
    listLimit,
    isFreePlan,
    failedJobsCount,
    lastSyncTime,
    syncedToday,
    analytics,
    recentActivity,
  } = useLoaderData();

  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [conns, setConns] = useState(
    listConnections.length > 0
      ? listConnections
      : [{ id: "", name: "", keyword: "", routingLocationId: "", routingTag: "" }]
  );

  const [billingInterval, setBillingInterval] = useState("monthly"); // monthly or annual
  const [fieldMappingsList, setFieldMappingsList] = useState(fieldMappings || []);
  const [activeTab, setActiveTab] = useState("connections"); // connections, mappings, settings
  const [selectedTool, setSelectedTool] = useState(null);
  const [localTaskTemplate, setLocalTaskTemplate] = useState(taskNameTemplate || "");
  const [localTaskDescriptionTemplate, setLocalTaskDescriptionTemplate] = useState(taskDescriptionTemplate || "");
  const [localSyncTrigger, setLocalSyncTrigger] = useState(syncTrigger || "payment_confirmed");
  const [localSubtasks, setLocalSubtasks] = useState(subtasksEnabled || false);
  const [localTwoWaySync, setLocalTwoWaySync] = useState(twoWaySyncEnabled || false);

  const compiledTemplatePreview = useMemo(() => {
    const template = localTaskTemplate.trim() || "Order {order_number} — {customer_name}";
    if (!latestOrder) return template;

    const customerName = latestOrder.customer
      ? [latestOrder.customer.first_name, latestOrder.customer.last_name].filter(Boolean).join(" ").trim() ||
        latestOrder.customer.name ||
        latestOrder.customer.email
      : "Guest";

    const shippingMethod = latestOrder.shipping_lines?.[0]?.title || "Standard Shipping";
    const itemCount = latestOrder.line_items?.length || 0;
    const orderTotal = `${latestOrder.currency || "USD"} ${latestOrder.total_price || "0.00"}`;
    const paymentStatus = latestOrder.financial_status || "paid";
    const orderNumber = String(latestOrder.order_number || latestOrder.number || latestOrder.id);

    return template
      .replace(/{order_number}/g, orderNumber)
      .replace(/{customer_name}/g, customerName)
      .replace(/{order_total}/g, orderTotal)
      .replace(/{shipping_method}/g, shippingMethod)
      .replace(/{item_count}/g, String(itemCount))
      .replace(/{payment_status}/g, paymentStatus);
  }, [localTaskTemplate, latestOrder]);

  const compiledDescriptionPreview = useMemo(() => {
    const template = localTaskDescriptionTemplate.trim();
    if (!template) return "No custom description template configured. Default order details will be synced.";
    if (!latestOrder) return template;

    const customerName = latestOrder.customer
      ? [latestOrder.customer.first_name, latestOrder.customer.last_name].filter(Boolean).join(" ").trim() ||
        latestOrder.customer.name ||
        latestOrder.customer.email
      : "Guest";

    const shippingMethod = latestOrder.shipping_lines?.[0]?.title || "Standard Shipping";
    const itemCount = latestOrder.line_items?.length || 0;
    const orderTotal = `${latestOrder.currency || "USD"} ${latestOrder.total_price || "0.00"}`;
    const paymentStatus = latestOrder.financial_status || "paid";
    const orderNumber = String(latestOrder.order_number || latestOrder.number || latestOrder.id);
    const adminOrderUrl = `https://${shop}/admin/orders/${latestOrder.id}`;

    let compiled = template;

    // 1. Pre-process line item loops: {% for item in line_items %} ... {% endfor %}
    const loopRegex = /\{%\s*for\s+(\w+)\s+in\s+line_items\s*%\}([\s\S]*?)\{%\s*endfor\s*%\}/g;
    compiled = compiled.replace(loopRegex, (_, varName, loopContent) => {
      const items = latestOrder.line_items || [];
      return items.map((item) => {
        const variant = item.variant_title ? ` (${item.variant_title})` : "";
        
        return loopContent
          .replace(new RegExp(`{{\\s*${varName}\\.title\\s*}}`, "g"), item.title || "")
          .replace(new RegExp(`{{\\s*${varName}\\.quantity\\s*}}`, "g"), String(item.quantity || 1))
          .replace(new RegExp(`{{\\s*${varName}\\.sku\\s*}}`, "g"), item.sku || "")
          .replace(new RegExp(`{{\\s*${varName}\\.variant\\s*}}`, "g"), variant)
          .replace(new RegExp(`{{\\s*${varName}\\.price\\s*}}`, "g"), item.price || "0.00");
      }).join("");
    });

    // 2. Resolve global order variables
    const variables = {
      "order.order_number": orderNumber,
      "order.customer_name": customerName,
      "order.email": latestOrder.customer?.email || latestOrder.email || "",
      "order.phone": latestOrder.customer?.phone || latestOrder.billing_address?.phone || latestOrder.shipping_address?.phone || "",
      "order.total": orderTotal,
      "order.shipping_method": shippingMethod,
      "order.item_count": String(itemCount),
      "order.payment_status": paymentStatus,
      "order.notes": latestOrder.note || "",
      "order.admin_url": adminOrderUrl,
      "order.shipping_address": latestOrder.shipping_address 
        ? [latestOrder.shipping_address.address1, latestOrder.shipping_address.city, latestOrder.shipping_address.province, latestOrder.shipping_address.zip, latestOrder.shipping_address.country].filter(Boolean).join(", ")
        : ""
    };

    for (const [key, val] of Object.entries(variables)) {
      const reg = new RegExp(`{{\\s*${key}\\s*}}`, "g");
      compiled = compiled.replace(reg, val);
    }

    return compiled;
  }, [localTaskDescriptionTemplate, latestOrder, shop]);

  const isFullySetup = connected && listConnections.length > 0;
  const [wizardStep, setWizardStep] = useState(() => {
    if (isFullySetup) return "dashboard";
    if (connected) return "select";
    if (selectedTool) return "connect";
    return "choose";
  });

  useEffect(() => {
    if (connected && listConnections.length > 0) {
      setWizardStep("dashboard");
    } else if (connected && listConnections.length === 0) {
      setWizardStep("select");
    } else if (!connected) {
      if (selectedTool) {
        setWizardStep("connect");
      } else {
        setWizardStep("choose");
      }
    }
  }, [connected, listConnections, selectedTool]);

  useEffect(() => {
    if (actionData?.saved) {
      setWizardStep("done");
    }
  }, [actionData]);

  const applyPreset = (presetName) => {
    let matchedMappings = [];
    clickupFields.forEach((field) => {
      const fieldNameLower = field.name.toLowerCase();
      let sourceField = "";

      if (presetName === "basic") {
        if (fieldNameLower.includes("number") || fieldNameLower === "order") {
          sourceField = "order_number";
        } else if (fieldNameLower.includes("name") || fieldNameLower.includes("customer")) {
          sourceField = "customer_name";
        } else if (fieldNameLower.includes("total") || fieldNameLower.includes("price")) {
          sourceField = "total_price";
        }
      } else if (presetName === "customer") {
        if (fieldNameLower.includes("number") || fieldNameLower === "order") {
          sourceField = "order_number";
        } else if (fieldNameLower.includes("name") || fieldNameLower.includes("customer")) {
          sourceField = "customer_name";
        } else if (fieldNameLower.includes("email")) {
          sourceField = "customer_email";
        } else if (fieldNameLower.includes("phone") || fieldNameLower.includes("tel")) {
          sourceField = "customer_phone";
        } else if (fieldNameLower.includes("address") || fieldNameLower.includes("ship to")) {
          sourceField = "shipping_address";
        } else if (fieldNameLower.includes("total") || fieldNameLower.includes("price")) {
          sourceField = "total_price";
        }
      } else if (presetName === "financial") {
        if (fieldNameLower.includes("number") || fieldNameLower === "order") {
          sourceField = "order_number";
        } else if (fieldNameLower.includes("subtotal")) {
          sourceField = "subtotal_price";
        } else if (fieldNameLower.includes("shipping")) {
          sourceField = "shipping_price";
        } else if (fieldNameLower.includes("total") || fieldNameLower.includes("price")) {
          sourceField = "total_price";
        } else if (fieldNameLower.includes("note") || fieldNameLower.includes("comment")) {
          sourceField = "order_notes";
        }
      }

      if (sourceField) {
        matchedMappings.push({
          shopifySourceField: sourceField,
          clickupFieldId: field.id,
          clickupFieldName: field.name,
          clickupFieldType: field.type,
        });
      }
    });

    setFieldMappingsList(matchedMappings);
  };

  const renderProgressBar = () => {
    const activeTool = selectedTool || selectedPlatform;
    const destLabel = activeTool === "clickup"
      ? "Pick ClickUp List"
      : activeTool === "monday"
      ? "Pick Monday Board"
      : activeTool === "notion"
      ? "Pick Notion Db"
      : "Select Destination";

    const steps = [
      { key: "choose", label: "Choose Tool" },
      { key: "connect", label: "Connect Account" },
      { key: "select", label: destLabel },
      { key: "done", label: "Get Started" }
    ];
    const currentStepIndex = steps.findIndex(s => s.key === wizardStep);
    if (wizardStep === "dashboard") return null;
    return (
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, position: "relative" }}>
          {steps.map((s, idx) => {
            const isActive = s.key === wizardStep;
            const isCompleted = currentStepIndex > idx;
            return (
              <div key={s.key} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, position: "relative" }}>
                {idx > 0 && (
                  <div style={{
                    position: "absolute",
                    left: "-50%",
                    right: "50%",
                    top: 12,
                    height: 2,
                    background: currentStepIndex >= idx ? C.accent : "#2a2a2a",
                    zIndex: 1,
                  }} />
                )}
                <div style={{
                  width: 24,
                  height: 24,
                  borderRadius: "50%",
                  background: isCompleted ? C.accent : isActive ? "#151515" : "#1a1a1a",
                  border: `2px solid ${isCompleted || isActive ? C.accent : C.border}`,
                  color: isCompleted ? "#03251c" : isActive ? C.accent : C.muted,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  fontWeight: 800,
                  zIndex: 2,
                  transition: "all 0.3s ease",
                  boxShadow: isActive ? `0 0 10px ${C.accent}66` : "none",
                }}>
                  {isCompleted ? "✓" : idx + 1}
                </div>
                <span style={{
                  fontSize: 11,
                  fontWeight: isActive ? 700 : 500,
                  color: isActive ? C.text : C.muted,
                  marginTop: 6,
                  textAlign: "center",
                }}>
                  {s.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const statusCfg = SYNC_STATUS_CONFIG[syncStatus];

  const handleDisconnect = (e) => {
    const platformName = selectedPlatform === "clickup" ? "ClickUp" : selectedPlatform === "monday" ? "Monday.com" : "Notion";
    if (
      !window.confirm(
        `Are you sure you want to disconnect ${platformName}? Order syncing will stop immediately.`
      )
    ) {
      e.preventDefault();
    }
  };

  const getPlanDisplayName = (planName) => {
    if (planName === "trial") return "Free Trial";
    if (planName === "free") return "Free Plan";
    if (planName === "standard_monthly") return "Standard Monthly";
    if (planName === "standard_annual") return "Standard Annual";
    if (planName === "growth_monthly") return "Growth Monthly";
    if (planName === "growth_annual") return "Growth Annual";
    if (planName === "expired") return "Trial Expired";
    if (planName === "cancelled") return "Subscription Cancelled";
    return planName;
  };

  // If the trial has expired or subscription is cancelled/expired, show a full-page upgrade prompt
  const showFullPageUpgrade = connected && !isTrialOrSubscriptionActive;

  return (
    <>
      <style>{`
        @media (max-width: 600px) {
          .su-plan-row { flex-direction: column !important; align-items: flex-start !important; }
          .su-plan-btn { align-self: flex-start; }
          .su-container { padding: 24px 12px !important; }
          .su-pricing-grid { grid-template-columns: 1fr !important; }
        }
        .su-pricing-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 24px;
          margin-top: 16px;
        }
        .su-toggle-container {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 12px;
          margin-bottom: 24px;
        }
        .su-toggle-btn {
          background: transparent;
          border: 1px solid ${C.border};
          color: ${C.muted};
          padding: 8px 16px;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 600;
          font-size: 13px;
          transition: all 0.2s ease;
        }
        .su-toggle-btn.active {
          background: ${C.accent};
          color: #03251c;
          border-color: ${C.accent};
        }
        .su-platform-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
          margin-top: 16px;
          margin-bottom: 24px;
        }
        @media (max-width: 600px) {
          .su-platform-grid {
            grid-template-columns: 1fr !important;
          }
        }
        .su-platform-card {
          background: #1a1a1a;
          border: 1px solid ${C.border};
          border-radius: 14px;
          padding: 24px 16px;
          text-align: center;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          position: relative;
        }
        .su-platform-card:hover {
          transform: translateY(-2px);
        }
        .su-platform-card.clickup:hover, .su-platform-card.clickup.selected {
          border-color: #7b61ff;
          box-shadow: 0 4px 20px rgba(123, 97, 255, 0.15);
          background: rgba(123, 97, 255, 0.03);
        }
        .su-platform-card.monday:hover, .su-platform-card.monday.selected {
          border-color: #ff3d57;
          box-shadow: 0 4px 20px rgba(255, 61, 87, 0.15);
          background: rgba(255, 61, 87, 0.03);
        }
        .su-platform-card.notion:hover, .su-platform-card.notion.selected {
          border-color: #ffffff;
          box-shadow: 0 4px 20px rgba(255, 255, 255, 0.15);
          background: rgba(255, 255, 255, 0.03);
        }
        .su-platform-badge {
          font-size: 9px;
          font-weight: 700;
          text-transform: uppercase;
          padding: 2px 8px;
          border-radius: 12px;
          letter-spacing: 0.05em;
        }
        .su-platform-badge.live {
          color: ${C.accent};
          background: rgba(0, 196, 140, 0.12);
          border: 1px solid rgba(0, 196, 140, 0.3);
        }
        .su-platform-badge.coming-soon {
          color: #ff9900;
          background: rgba(255, 153, 0, 0.12);
          border: 1px solid rgba(255, 153, 0, 0.3);
        }
        .su-dashboard-grid {
          display: grid;
          grid-template-columns: 1.25fr 0.75fr;
          gap: 20px;
          align-items: start;
        }
        @media (max-width: 900px) {
          .su-dashboard-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>

      <div style={styles.page}>
        <div style={{ ...styles.container, maxWidth: wizardStep === "dashboard" ? 1200 : 640 }} className="su-container">
          {/* Header */}
          <header style={styles.header}>
            <div style={styles.logoMark}>
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke={C.accent}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" />
                <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
              </svg>
            </div>
            <div style={{ flex: 1 }}>
              <h1 style={styles.title}>SyncUp</h1>
              <p style={styles.subtitle}>
                {wizardStep === "dashboard"
                  ? "Automatically sync your Shopify orders to ClickUp, Monday, or Notion."
                  : "Automatically sync your Shopify orders. Setup takes about 2 minutes."}
              </p>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
              <div
                style={{
                  ...styles.statusBadge,
                  color: statusCfg.color,
                  background: statusCfg.bg,
                  border: `1px solid ${statusCfg.color}44`,
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: statusCfg.color,
                    display: "inline-block",
                    marginRight: 6,
                    flexShrink: 0,
                  }}
                />
                {statusCfg.label}
              </div>
              {wizardStep === "dashboard" && lastSyncTime && (
                <span style={{ fontSize: 11, color: C.muted }}>
                  Last sync: {timeAgo(lastSyncTime)}
                </span>
              )}
            </div>
          </header>

          {/* Trial Banners */}
          {trialBanner && (
            <div
              style={{
                ...styles.banner,
                ...BANNER_COLORS[trialBanner.color],
                marginBottom: 16,
              }}
            >
              {trialBanner.message}
            </div>
          )}

          {/* Action/Success Banners */}
          {billingSuccess && (
            <div style={{ ...styles.successBanner, marginBottom: 16 }}>
              ✓ Your plan has been updated successfully.
            </div>
          )}
          {actionData?.sentTestTask && (
            <div style={{ ...styles.successBanner, marginBottom: 16 }}>
              {`✓ Test task successfully sent! Check your connected ${selectedPlatform === "clickup" ? "ClickUp list" : selectedPlatform === "monday" ? "Monday board" : "Notion database"}.`}
            </div>
          )}
          {actionData?.retriedAllFailed && (
            <div style={{ ...styles.successBanner, marginBottom: 16 }}>
              {`✓ Successfully re-enqueued ${actionData.retriedCount} failed sync job(s) for processing.`}
            </div>
          )}
          {actionData?.savedSettings && (
            <div style={{ ...styles.successBanner, marginBottom: 16 }}>
              ✓ Sync settings saved successfully.
            </div>
          )}
          {removedLists && (
            <div style={{ ...styles.warningBanner, marginBottom: 16 }}>
              ⚠️ Downgraded to Standard plan. The following extra list connections were removed: <strong>{removedLists}</strong>
            </div>
          )}
          {(clickupError || actionData?.error) && (
            <div style={{ ...styles.errorBanner, marginBottom: 16 }}>
              {clickupError || actionData?.error}
            </div>
          )}

          {showFullPageUpgrade ? (
            /* SECTION 2 (Pricing cards) shown as full-page settings overlay */
            <section className="bg-zinc-900/40 border border-zinc-800 rounded-3xl p-8 max-w-6xl mx-auto shadow-2xl backdrop-blur-md">
              <div className="text-center mb-8 max-w-2xl mx-auto">
                <h2 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight mb-2">
                  Activate a subscription to resume syncing
                </h2>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  SyncUp has paused order task creation because you do not have an active subscription. Choose a plan below to unlock syncing immediately.
                </p>
              </div>

              {/* Launch Special / Urgency Banner */}
              <div className="bg-emerald-950/20 border border-emerald-500/30 text-emerald-400 p-4 rounded-xl text-xs sm:text-sm flex items-start gap-3 mb-10 max-w-3xl mx-auto shadow-md">
                <span className="text-lg leading-none">🚀</span>
                <div>
                  <strong className="font-semibold block mb-0.5 text-emerald-300">LAUNCH SPECIAL OFFER</strong>
                  Install today to lock in these discounted B2B rates forever. Once our beta ends, pricing will increase for new installs. Existing merchants will remain grandfathered on these plans indefinitely!
                </div>
              </div>

              {/* Toggle */}
              <div className="flex justify-center items-center gap-3 mb-10">
                <span className={`text-xs font-semibold transition-colors duration-200 ${billingInterval === "monthly" ? "text-zinc-100" : "text-zinc-500"}`}>
                  Monthly Billing
                </span>
                <button
                  type="button"
                  className="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none bg-zinc-800"
                  onClick={() => setBillingInterval(billingInterval === "monthly" ? "annual" : "monthly")}
                  role="switch"
                  aria-checked={billingInterval === "annual"}
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-emerald-400 shadow ring-0 transition duration-200 ease-in-out ${
                      billingInterval === "annual" ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
                <span className={`text-xs font-semibold transition-colors duration-200 ${billingInterval === "annual" ? "text-emerald-400" : "text-zinc-500"}`}>
                  Annual Billing <span className="bg-emerald-500/10 text-emerald-400 text-[10px] px-2 py-0.5 rounded-full font-bold ml-1 border border-emerald-400/20">Save ~30%</span>
                </span>
              </div>

              {/* Pricing Cards Grid */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
                {["standard", "growth", "pro"].map((key) => {
                  const planKey = `${key}_${billingInterval}`;
                  const plan = PLANS[planKey];
                  if (!plan) return null;
                  const isHighlighted = key === "growth";

                  // Single source of truth: all display values derive from plans.js (PLANS).
                  // The merchant is charged plan.price; the headline here always matches it.
                  // regMonthly/regAnnual are the strike-through "regular" price (plan.regularPrice).
                  const overlayBadges = {
                    standard: "Best for Starters",
                    growth: "Most Popular",
                    pro: "Concierge Setup Included",
                  };

                  const monthlyPlan = PLANS[`${key}_monthly`];
                  const annualPlan = PLANS[`${key}_annual`];

                  const displayPrice = billingInterval === "annual"
                    ? `$${(annualPlan.price / 12).toFixed(2)}/mo`
                    : `$${monthlyPlan.price.toFixed(2)}/mo`;

                  const regularPrice = billingInterval === "annual"
                    ? (annualPlan.regularPrice ? `$${annualPlan.regularPrice.toFixed(2)}` : null)
                    : (monthlyPlan.regularPrice ? `$${monthlyPlan.regularPrice.toFixed(2)}` : null);

                  const billedDesc = billingInterval === "annual"
                    ? `Billed annually as $${annualPlan.price}`
                    : null;

                  return (
                    <div
                      key={key}
                      className={`bg-zinc-950/45 border rounded-2xl p-6 flex flex-col justify-between transition-all duration-300 relative ${
                        isHighlighted 
                          ? "border-emerald-500/40 shadow-xl shadow-emerald-950/15 hover:border-emerald-500/60" 
                          : "border-zinc-800 hover:border-zinc-700"
                      }`}
                    >
                      {isHighlighted && (
                        <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-emerald-500 text-zinc-950 text-[10px] font-black uppercase tracking-wider px-3.5 py-1 rounded-full shadow-lg shadow-emerald-500/20">
                          {overlayBadges[key]}
                        </div>
                      )}

                      <div>
                        <div className="mb-4">
                          <span className="text-zinc-500 text-[10px] font-semibold tracking-wider uppercase block mb-1">
                            {key} tier
                          </span>
                          <h3 className="text-base font-bold text-white tracking-tight">{plan.name}</h3>
                        </div>

                        {/* Price */}
                        <div className="mb-6">
                          <div className="flex items-baseline flex-wrap gap-1">
                            {regularPrice && (
                              <span className="text-xs text-zinc-500 line-through mr-1 font-medium">
                                {regularPrice}
                              </span>
                            )}
                            <span className="text-2xl font-extrabold text-white tracking-tight">
                              {displayPrice.split("/")[0]}
                            </span>
                            <span className="text-zinc-400 text-xs font-medium">
                              /{displayPrice.split("/")[1]}
                            </span>
                          </div>

                          {/* Annual details */}
                          {billingInterval === "annual" && billedDesc && (
                            <div className="text-[10px] text-zinc-400 mt-1.5 font-medium flex items-center gap-1">
                              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                              {billedDesc} (${(monthlyPlan.price).toFixed(2)}/mo equivalent)
                            </div>
                          )}
                        </div>

                        {/* Divider */}
                        <div className="h-px bg-zinc-800/80 mb-5"></div>

                        {/* Features */}
                        <ul className="space-y-3 mb-6 text-xs text-zinc-300">
                          {getTranslatedFeatures(plan.features, selectedPlatform).map((feat) => (
                            <li key={feat} className="flex items-start">
                              <span className="text-emerald-400 mr-2 flex-shrink-0 font-bold">✓</span>
                              <span className="leading-snug">{feat}</span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      {/* Submit action */}
                      <Link
                        to={`/app/billing?platform=${selectedPlatform}`}
                        className={`w-full py-2.5 rounded-xl text-xs font-bold text-center block transition-all duration-200 hover:scale-[1.02] cursor-pointer ${
                          isHighlighted
                            ? "bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-extrabold shadow-lg shadow-emerald-500/10"
                            : "bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700 hover:border-zinc-600"
                        }`}
                        style={{ textDecoration: "none" }}
                      >
                        Select {plan.name.split(" ")[0]}
                      </Link>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : (
            <>{wizardStep !== "dashboard" ? (
                <div>
                  {renderProgressBar()}

                  {/* Step 1: Choose Tool */}
                  {wizardStep === "choose" && (
                    <section style={{ ...styles.card, marginBottom: 24 }}>
                      <h2 style={{ ...styles.cardTitle, marginTop: 0, textAlign: "center" }}>Choose your Workspace Tool</h2>
                      <p style={{ ...styles.cardText, textAlign: "center", marginBottom: 24 }}>
                        Select the project management platform you want to sync your Shopify orders to.
                      </p>

                      <div className="su-platform-grid">
                        {/* ClickUp */}
                        <button
                          type="button"
                          className="su-platform-card clickup"
                          onClick={() => {
                            setSelectedTool("clickup");
                            setWizardStep("connect");
                          }}
                          style={{ background: "none", width: "100%", outline: "none", color: "inherit", font: "inherit", border: `1px solid ${C.border}` }}
                        >
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                            <div style={{ width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                                <path d="M5 9L12 3L19 9" stroke="#7b61ff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M12 14C9.5 14 7.5 16 7.5 18.5C7.5 20.5 9 21 12 21C15 21 16.5 20.5 16.5 18.5C16.5 16 14.5 14 12 14Z" fill="#7b61ff" />
                              </svg>
                            </div>
                            <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>ClickUp</span>
                          </div>
                          <span className="su-platform-badge live">Live</span>
                        </button>

                        {/* Monday.com */}
                        <button
                          type="button"
                          className="su-platform-card monday"
                          onClick={() => {
                            setSelectedTool("monday");
                            setWizardStep("connect");
                          }}
                          style={{ background: "none", width: "100%", outline: "none", color: "inherit", font: "inherit", border: `1px solid ${C.border}` }}
                        >
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                            <div style={{ width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                                <rect x="5" y="10" width="30" height="6" rx="3" fill="#ff3d57" />
                                <rect x="5" y="20" width="30" height="6" rx="3" fill="#ffcb00" />
                                <rect x="5" y="30" width="30" height="6" rx="3" fill="#00cff4" />
                              </svg>
                            </div>
                            <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Monday.com</span>
                          </div>
                          <span className="su-platform-badge coming-soon">Beta</span>
                        </button>

                        {/* Notion */}
                        <button
                          type="button"
                          className="su-platform-card notion"
                          onClick={() => {
                            setSelectedTool("notion");
                            setWizardStep("connect");
                          }}
                          style={{ background: "none", width: "100%", outline: "none", color: "inherit", font: "inherit", border: `1px solid ${C.border}` }}
                        >
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                            <div style={{ width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="3" y="3" width="18" height="18" rx="4" />
                                <path d="M9 17V7l6 10V7" />
                              </svg>
                            </div>
                            <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Notion</span>
                          </div>
                          <span className="su-platform-badge coming-soon">Beta</span>
                        </button>
                      </div>
                    </section>
                  )}

                  {/* Step 2: Connect platform */}
                  {wizardStep === "connect" && (
                    <div>
                      <div style={{ marginBottom: 16 }}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedTool(null);
                            setWizardStep("choose");
                          }}
                          style={{
                            background: "none",
                            color: C.accent,
                            cursor: "pointer",
                            fontSize: 14,
                            fontWeight: 600,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "6px 12px",
                            borderRadius: "8px",
                            backgroundColor: "rgba(0, 196, 140, 0.06)",
                            border: "1px solid rgba(0, 196, 140, 0.15)",
                            outline: "none",
                          }}
                        >
                          &larr; Back to tool selector
                        </button>
                      </div>

                      {/* ClickUp configuration and billing */}
                      {selectedTool === "clickup" && (
                        <section style={styles.card}>
                          <h2 style={{ ...styles.cardTitle, marginTop: 0 }}>Connect ClickUp Workspace</h2>
                          
                          {!isTrialOrSubscriptionActive ? (
                            <div>
                              <p style={{ ...styles.cardText, marginBottom: 24 }}>
                                SyncUp has paused task creation because you do not have an active subscription. Choose a plan below to unlock ClickUp connection and start syncing.
                              </p>

                              {/* Toggle */}
                              <div className="flex justify-center items-center gap-3 mb-8">
                                <span className={`text-xs font-semibold transition-colors duration-200 ${billingInterval === "monthly" ? "text-zinc-100" : "text-zinc-500"}`}>
                                  Monthly Billing
                                </span>
                                <button
                                  type="button"
                                  className="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none bg-zinc-800"
                                  onClick={() => setBillingInterval(billingInterval === "monthly" ? "annual" : "monthly")}
                                  role="switch"
                                  aria-checked={billingInterval === "annual"}
                                >
                                  <span
                                    aria-hidden="true"
                                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-emerald-400 shadow ring-0 transition duration-200 ease-in-out ${
                                      billingInterval === "annual" ? "translate-x-5" : "translate-x-0"
                                    }`}
                                  />
                                </button>
                                <span className={`text-xs font-semibold transition-colors duration-200 ${billingInterval === "annual" ? "text-emerald-400" : "text-zinc-500"}`}>
                                  Annual Billing <span className="bg-emerald-500/10 text-emerald-400 text-[10px] px-2 py-0.5 rounded-full font-bold ml-1 border border-emerald-400/20">Save ~30%</span>
                                </span>
                              </div>

                              {/* Pricing Cards Grid */}
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
                                {["standard", "growth", "pro"].map((key) => {
                                  const planKey = `${key}_${billingInterval}`;
                                  const plan = PLANS[planKey];
                                  if (!plan) return null;
                                  const isHighlighted = key === "growth";
                                  
                                  const overlayBadges = {
                                    standard: "Best for Starters",
                                    growth: "Most Popular",
                                    pro: "Concierge Setup Included",
                                  };

                                  const monthlyPlan = PLANS[`${key}_monthly`];
                                  const annualPlan = PLANS[`${key}_annual`];

                                  const displayPrice = billingInterval === "annual"
                                    ? `$${(annualPlan.price / 12).toFixed(2)}/mo`
                                    : `$${monthlyPlan.price.toFixed(2)}/mo`;

                                  const regularPrice = billingInterval === "annual"
                                    ? (annualPlan.regularPrice ? `$${annualPlan.regularPrice.toFixed(2)}` : null)
                                    : (monthlyPlan.regularPrice ? `$${monthlyPlan.regularPrice.toFixed(2)}` : null);

                                  const billedDesc = billingInterval === "annual"
                                    ? `Billed annually as $${annualPlan.price}`
                                    : null;

                                  return (
                                    <div
                                      key={key}
                                      className={`bg-zinc-950/45 border rounded-2xl p-6 flex flex-col justify-between transition-all duration-300 relative ${
                                        isHighlighted 
                                          ? "border-emerald-500/40 shadow-xl shadow-emerald-950/15 hover:border-emerald-500/60" 
                                          : "border-zinc-800 hover:border-zinc-700"
                                      }`}
                                      style={{ border: isHighlighted ? "1px solid rgba(16, 185, 129, 0.4)" : `1px solid ${C.border}`, background: "#0f0f0f" }}
                                    >
                                      {isHighlighted && (
                                        <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-emerald-500 text-zinc-950 text-[10px] font-black uppercase tracking-wider px-3.5 py-1 rounded-full shadow-lg shadow-emerald-500/20">
                                          {overlayBadges[key]}
                                        </div>
                                      )}

                                      <div>
                                        <div className="mb-4">
                                          <span className="text-zinc-500 text-[10px] font-semibold tracking-wider uppercase block mb-1">
                                            {key} tier
                                          </span>
                                          <h3 className="text-base font-bold text-white tracking-tight">{plan.name}</h3>
                                        </div>

                                        {/* Price */}
                                        <div className="mb-6">
                                          <div className="flex items-baseline flex-wrap gap-1">
                                            {regularPrice && (
                                              <span className="text-xs text-zinc-500 line-through mr-1 font-medium">
                                                {regularPrice}
                                              </span>
                                            )}
                                            <span className="text-2xl font-extrabold text-white tracking-tight">
                                              {displayPrice.split("/")[0]}
                                            </span>
                                            <span className="text-zinc-400 text-xs font-medium">
                                              /{displayPrice.split("/")[1]}
                                            </span>
                                          </div>

                                          {/* Annual details */}
                                          {billingInterval === "annual" && billedDesc && (
                                            <div className="text-[10px] text-zinc-400 mt-1.5 font-medium flex items-center gap-1">
                                              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                                              {billedDesc} (${(monthlyPlan.price).toFixed(2)}/mo equivalent)
                                            </div>
                                          )}
                                        </div>

                                        {/* Divider */}
                                        <div className="h-px bg-zinc-800/80 mb-5" style={{ background: C.border }}></div>

                                        {/* Features translated dynamically */}
                                        <ul className="space-y-3 mb-6 text-xs text-zinc-300" style={{ listStyle: "none", padding: 0 }}>
                                          {getTranslatedFeatures(plan.features, selectedTool).map((feat) => (
                                            <li key={feat} className="flex items-start">
                                              <span className="text-emerald-400 mr-2 flex-shrink-0 font-bold">✓</span>
                                              <span className="leading-snug">{feat}</span>
                                            </li>
                                          ))}
                                        </ul>
                                      </div>

                                      {/* Submit action */}
                                      <Link
                                        to={`/app/billing?platform=clickup`}
                                        className={`w-full py-2.5 rounded-xl text-xs font-bold text-center block transition-all duration-200 hover:scale-[1.02] cursor-pointer ${
                                          isHighlighted
                                            ? "bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-extrabold shadow-lg shadow-emerald-500/10"
                                            : "bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700 hover:border-zinc-600"
                                        }`}
                                        style={{
                                          border: isHighlighted ? "none" : `1px solid ${C.border}`,
                                          background: isHighlighted ? C.accent : "#1a1a1a",
                                          color: isHighlighted ? "#03251c" : C.text,
                                          width: "100%",
                                          textDecoration: "none"
                                        }}
                                      >
                                        Select {plan.name.split(" ")[0]}
                                      </Link>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ) : (
                            <>
                              <p style={styles.cardText}>
                                Connect ClickUp to start syncing new orders into a list of your
                                choice. New orders become tasks, fulfilled orders get marked
                                complete — automatically.
                              </p>
                              <a
                                href={`/auth/clickup?state=${encodeURIComponent(clickupConnectState)}`}
                                target="_top"
                                style={{ ...styles.primaryButton, display: "inline-flex", alignItems: "center", gap: 8 }}
                              >
                                <span>Connect ClickUp</span>
                                <span style={{ fontSize: 11 }}>&rarr;</span>
                              </a>
                            </>
                          )}
                        </section>
                      )}

                      {/* Monday.com / Notion active connection forms */}
                      {(selectedTool === "monday" || selectedTool === "notion") && (
                        <section style={styles.card}>
                          <h2 style={{ ...styles.cardTitle, marginTop: 0 }}>
                            Connect {selectedTool === "monday" ? "Monday.com" : "Notion"}
                          </h2>
                          
                          <p style={styles.cardText}>
                            {selectedTool === "monday" 
                              ? "Enter your Monday.com Personal Access Token to connect your account. You can find this token in your Monday.com account under Administration > API." 
                              : "Enter your Notion Integration Token to connect your account. You can create an integration token at developers.notion.com/my-integrations."}
                          </p>

                          {actionData?.error && (
                            <div style={{ ...styles.errorBanner, marginTop: 12, marginBottom: 12 }}>
                              {actionData.error}
                            </div>
                          )}

                          <Form method="post" style={{ ...styles.form, marginTop: 16 }}>
                            <input type="hidden" name="intent" value="connect_platform" />
                            <input type="hidden" name="platform" value={selectedTool} />
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              <label style={styles.formLabel} htmlFor="platform_token">
                                {selectedTool === "monday" ? "Monday.com Personal Access Token" : "Notion Integration Token"}{" "}
                                <InfoTooltip text={selectedTool === "monday" ? "A secure personal access token generated from your Monday.com developer settings." : "A secure integration token generated from your Notion developer settings."} />
                              </label>
                              <input
                                id="platform_token"
                                name="token"
                                type="password"
                                required
                                placeholder={selectedTool === "monday" ? "e.g. eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." : "e.g. secret_abc123xyz..."}
                                style={styles.input}
                              />
                            </div>
                            <button
                              type="submit"
                              style={{ ...styles.primaryButton, width: "100%", marginTop: 12 }}
                              disabled={isSubmitting}
                            >
                              {isSubmitting ? "Connecting..." : `Connect ${selectedTool === "monday" ? "Monday.com" : "Notion"}`}
                            </button>
                          </Form>
                        </section>
                      )}
                    </div>
                  )}

                  {/* Step 3: Select destination */}
                  {wizardStep === "select" && (
                    <section style={styles.card}>
                      <div style={styles.cardHeaderRow}>
                        <div style={styles.statusRow}>
                          <span style={styles.statusDot} />
                          <span style={styles.statusText}>
                            {workspaceName
                              ? `Connected to ${workspaceName}`
                              : `${selectedPlatform === "clickup" ? "ClickUp" : selectedPlatform === "monday" ? "Monday.com" : "Notion"} connected`}
                          </span>
                        </div>
                        <Form method="post" onSubmit={handleDisconnect}>
                          <input type="hidden" name="intent" value="disconnect" />
                          <button
                            type="submit"
                            style={styles.dangerButton}
                            disabled={isSubmitting}
                          >
                            Disconnect
                          </button>
                        </Form>
                      </div>

                      <h2 style={styles.cardTitle}>Configure order {selectedPlatform === "clickup" ? "list" : selectedPlatform === "monday" ? "board" : "database"} connections</h2>
                      <p style={styles.cardText}>
                        Select where new orders should sync. Growth plan merchants can configure up to 5 {selectedPlatform === "clickup" ? "lists" : selectedPlatform === "monday" ? "boards" : "databases"} with keyword filters to route orders automatically.
                      </p>

                      {lists.length === 0 ? (
                        <p style={styles.cardText}>
                          No {selectedPlatform === "clickup" ? "lists" : selectedPlatform === "monday" ? "boards" : "databases"} found in workspaces. Create one first then reload this page.
                        </p>
                      ) : (
                        <Form method="post" style={styles.form}>
                          <input type="hidden" name="intent" value="save_connections" />
                          <input type="hidden" name="listConnectionsJson" value={JSON.stringify(conns)} />

                          <div style={styles.connectionsContainer}>
                            {conns.map((conn, index) => (
                              <div key={index} style={styles.connectionRow}>
                                <div style={{ flex: 2, minWidth: "150px" }}>
                                  <label style={styles.formLabel} htmlFor={`list_${index}`}>
                                    {selectedPlatform === "clickup" ? "ClickUp List" : selectedPlatform === "monday" ? "Monday Board" : "Notion Database"}{" "}
                                    <InfoTooltip text={`The specific destination ${selectedPlatform === "clickup" ? "list" : selectedPlatform === "monday" ? "board" : "database"} where synced order tasks will be created.`} />
                                  </label>
                                  <select
                                    id={`list_${index}`}
                                    value={conn.id}
                                    onChange={(e) => {
                                      const selectedId = e.currentTarget.value;
                                      const match = lists.find((l) => l.id === selectedId);
                                      const updated = [...conns];
                                      updated[index] = {
                                        ...conn,
                                        id: selectedId,
                                        name: match ? match.name : "",
                                      };
                                      setConns(updated);
                                    }}
                                    style={styles.select}
                                  >
                                    <option value="">Select...</option>
                                    {lists.map((list) => (
                                      <option key={list.id} value={list.id}>
                                        {list.name}
                                      </option>
                                    ))}
                                  </select>
                                </div>

                                {listLimit > 1 && (
                                  <>
                                    <div style={{ flex: 1, minWidth: "120px" }}>
                                      <label style={styles.formLabel} htmlFor={`kw_${index}`}>
                                        Product Keyword <InfoTooltip text="Only route orders containing products whose title, vendor, or SKU matches this word (e.g. 'boot')." />
                                      </label>
                                      <input
                                        id={`kw_${index}`}
                                        type="text"
                                        placeholder="e.g. Shoes or Vendor"
                                        value={conn.keyword || ""}
                                        onChange={(e) => {
                                          const updated = [...conns];
                                          updated[index] = { ...conn, keyword: e.currentTarget.value };
                                          setConns(updated);
                                        }}
                                        style={styles.input}
                                        className="border border-zinc-800"
                                      />
                                    </div>
                                    <div style={{ flex: 1, minWidth: "120px" }}>
                                      <label style={styles.formLabel} htmlFor={`loc_${index}`}>
                                        Location ID <InfoTooltip text="Only route orders if they are fulfilled from this physical Shopify warehouse/location ID." />
                                      </label>
                                      <input
                                        id={`loc_${index}`}
                                        type="text"
                                        placeholder="Shopify Location ID"
                                        value={conn.routingLocationId || ""}
                                        onChange={(e) => {
                                          const updated = [...conns];
                                          updated[index] = { ...conn, routingLocationId: e.currentTarget.value };
                                          setConns(updated);
                                        }}
                                        style={styles.input}
                                        className="border border-zinc-800"
                                      />
                                    </div>
                                    <div style={{ flex: 1, minWidth: "120px" }}>
                                      <label style={styles.formLabel} htmlFor={`tag_${index}`}>
                                        Order Tag <InfoTooltip text="Only route orders that carry this specific Shopify order tag or product tag (e.g. 'B2B')." />
                                      </label>
                                      <input
                                        id={`tag_${index}`}
                                        type="text"
                                        placeholder="Order/product tag name"
                                        value={conn.routingTag || ""}
                                        onChange={(e) => {
                                          const updated = [...conns];
                                          updated[index] = { ...conn, routingTag: e.currentTarget.value };
                                          setConns(updated);
                                        }}
                                        style={styles.input}
                                        className="border border-zinc-800"
                                      />
                                    </div>
                                  </>
                                )}

                                {listLimit > 1 && conns.length > 1 && (
                                  <button
                                    type="button"
                                    onClick={() => setConns(conns.filter((_, i) => i !== index))}
                                    style={styles.removeConnButton}
                                  >
                                    Remove
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>

                          {conns.length < listLimit && (
                            <button
                              type="button"
                              onClick={() => setConns([...conns, { id: lists[0]?.id || "", name: lists[0]?.name || "", keyword: "", routingLocationId: "", routingTag: "" }])}
                              style={styles.addConnButton}
                            >
                              + Add connection
                            </button>
                          )}

                          <button
                            type="submit"
                            style={styles.primaryButton}
                            disabled={isSubmitting}
                          >
                            {isSubmitting ? "Saving…" : "Save connections"}
                          </button>
                        </Form>
                      )}
                    </section>
                  )}

                  {/* Step 4: Done */}
                  {wizardStep === "done" && (
                    <section style={{ ...styles.card, textAlign: "center", padding: "48px 32px" }}>
                      <div style={{
                        width: 64,
                        height: 64,
                        borderRadius: "50%",
                        background: "rgba(0, 196, 140, 0.12)",
                        border: `2px solid ${C.accent}`,
                        color: C.accent,
                        fontSize: 32,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        marginBottom: 20,
                      }}>
                        🎉
                      </div>
                      <h2 style={{ ...styles.cardTitle, marginTop: 0 }}>Setup complete!</h2>
                      <p style={{ ...styles.cardText, maxWidth: 480, margin: "0 auto 24px", fontSize: 14, lineHeight: "1.6" }}>
                        SyncUp is now watching for new orders. Want to see it in action right now?
                      </p>

                      {actionData?.sentTestTask && (
                        <div style={{ ...styles.successBanner, marginBottom: 24, textAlign: "left" }}>
                          {`✓ Test task successfully sent! Check your connected ${selectedPlatform === "clickup" ? "ClickUp list" : selectedPlatform === "monday" ? "Monday board" : "Notion database"}.`}
                        </div>
                      )}

                      <div style={{ display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
                        <Form method="post" style={{ display: "inline" }}>
                          <input type="hidden" name="intent" value="send_test_task" />
                          <button
                            type="submit"
                            style={styles.primaryButton}
                            disabled={isSubmitting}
                          >
                            {isSubmitting ? "Sending..." : `Send a test task → see it in ${selectedPlatform === "clickup" ? "ClickUp" : selectedPlatform === "monday" ? "Monday" : "Notion"} now`}
                          </button>
                        </Form>
                        <button
                          type="button"
                          onClick={() => setWizardStep("dashboard")}
                          style={{ ...styles.dangerButton, height: "fit-content", padding: "12px 22px" }}
                        >
                          Skip, go to Dashboard
                        </button>
                      </div>
                    </section>
                  )}
                </div>
              ) : (
                /* OPERATIONAL DASHBOARD: Two-Column Layout */
                <div>
                  {/* SECTION 1 — PLAN STATUS (active paid/trial merchants only) */}
                  <section style={{ ...styles.card, marginBottom: 20 }}>
                    <div style={styles.planRow} className="su-plan-row">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={styles.planLabel}>Current plan</div>
                        <div style={styles.planName}>
                          {getPlanDisplayName(subscription.planName)}
                          {subscription.planName !== "trial" && (
                            <span style={styles.paidBadge}>Active</span>
                          )}
                        </div>
                        {subscription.planName === "trial" ? (
                          <div style={styles.usageText}>
                            Your 14-day trial ends on {subscription.trialEndDate ? new Date(subscription.trialEndDate).toLocaleDateString() : ""}
                          </div>
                        ) : (
                          <div style={styles.usageText}>
                            Billing cycle started on {subscription.billingCycleStart ? new Date(subscription.billingCycleStart).toLocaleDateString() : ""}
                          </div>
                        )}
                      </div>
                      <Link
                        to={`/app/billing?platform=${selectedPlatform}`}
                        style={styles.managePlanButton}
                        className="su-plan-btn"
                      >
                        Manage billing
                      </Link>
                    </div>
                  </section>

                  {/* Failed sync jobs banner/card */}
                  {failedJobsCount > 0 && (
                    <div style={{
                      background: "rgba(255, 68, 68, 0.12)",
                      border: "1px solid #ff4444",
                      borderRadius: 16,
                      padding: "16px 24px",
                      marginBottom: 20,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 16,
                      flexWrap: "wrap",
                    }}>
                      <div style={{ flex: 1, minWidth: "250px" }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: "#ff4444", display: "flex", alignItems: "center", gap: 6 }}>
                          <span>⚠️</span>
                          <span>{failedJobsCount} order sync{failedJobsCount > 1 ? "s" : ""} failed</span>
                        </div>
                        <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
                          Some orders could not be synced to your connected workspace due to connection issues or mapping errors.
                        </div>
                      </div>
                      <Form method="post" style={{ display: "inline" }}>
                        <input type="hidden" name="intent" value="retry_all_failed_syncs" />
                        <button
                          type="submit"
                          disabled={isSubmitting}
                          style={{
                            background: "#ff4444",
                            color: "#ffffff",
                            border: "none",
                            borderRadius: 8,
                            padding: "10px 16px",
                            fontSize: 12,
                            fontWeight: 700,
                            cursor: "pointer",
                            transition: "all 0.2s",
                          }}
                        >
                          {isSubmitting ? "Retrying..." : "Retry Now →"}
                        </button>
                      </Form>
                    </div>
                  )}

                  {/* TWO-COLUMN GRID */}
                  <div className="su-dashboard-grid">
                    {/* LEFT COLUMN: Settings & Custom Field Mapping */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                      
                      {/* Tab Navigation */}
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", borderBottom: `1px solid ${C.border}`, paddingBottom: 16, marginBottom: 4 }}>
                        <button
                          type="button"
                          onClick={() => setActiveTab("connections")}
                          style={{
                            background: activeTab === "connections" ? C.accent : "rgba(255, 255, 255, 0.03)",
                            color: activeTab === "connections" ? "#03251c" : C.muted,
                            border: `1px solid ${activeTab === "connections" ? C.accent : C.border}`,
                            padding: "10px 18px",
                            borderRadius: 10,
                            cursor: "pointer",
                            fontWeight: 700,
                            fontSize: 13,
                            transition: "all 0.2s ease",
                            outline: "none"
                          }}
                        >
                          🔌 Connections & Routing
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveTab("mappings")}
                          style={{
                            background: activeTab === "mappings" ? C.accent : "rgba(255, 255, 255, 0.03)",
                            color: activeTab === "mappings" ? "#03251c" : C.muted,
                            border: `1px solid ${activeTab === "mappings" ? C.accent : C.border}`,
                            padding: "10px 18px",
                            borderRadius: 10,
                            cursor: "pointer",
                            fontWeight: 700,
                            fontSize: 13,
                            transition: "all 0.2s ease",
                            outline: "none"
                          }}
                        >
                          📋 Map Shopify Fields
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveTab("settings")}
                          style={{
                            background: activeTab === "settings" ? C.accent : "rgba(255, 255, 255, 0.03)",
                            color: activeTab === "settings" ? "#03251c" : C.muted,
                            border: `1px solid ${activeTab === "settings" ? C.accent : C.border}`,
                            padding: "10px 18px",
                            borderRadius: 10,
                            cursor: "pointer",
                            fontWeight: 700,
                            fontSize: 13,
                            transition: "all 0.2s ease",
                            outline: "none"
                          }}
                        >
                          ⚙️ Sync Settings
                        </button>
                      </div>

                      {activeTab === "connections" && (
                        <>
                          {/* Connection status card */}
                          <section style={styles.card}>
                        <div style={styles.cardHeaderRow}>
                          <div style={styles.statusRow}>
                            <span style={styles.statusDot} />
                            <span style={styles.statusText}>
                              {workspaceName
                                ? `Connected to ${workspaceName}`
                                : `${selectedPlatform === "clickup" ? "ClickUp" : selectedPlatform === "monday" ? "Monday.com" : "Notion"} connected`}
                            </span>
                          </div>
                          <div style={{ display: "flex", gap: 8 }}>
                            <Form method="post">
                              <input type="hidden" name="intent" value="send_test_task" />
                              <button
                                type="submit"
                                className="bg-emerald-500 hover:bg-emerald-400 text-zinc-950 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 cursor-pointer shadow shadow-emerald-500/10"
                                disabled={isSubmitting}
                                style={{ border: "none", color: "#03251c" }}
                              >
                                Send Test Task
                              </button>
                            </Form>

                            <Form method="post" onSubmit={handleDisconnect}>
                              <input type="hidden" name="intent" value="disconnect" />
                              <button
                                type="submit"
                                style={styles.dangerButton}
                                disabled={isSubmitting}
                              >
                                Disconnect
                              </button>
                            </Form>
                          </div>
                        </div>
                        {selectedPlatform === "clickup" && isFreePlan && (
                          <div style={{ ...styles.warningBanner, marginTop: 12, fontSize: "13px", lineHeight: "1.4" }}>
                            <strong>⚠️ ClickUp Free Tier Notice:</strong> Your ClickUp workspace is on the Free Forever plan. Custom field syncing is limited to 60 lifetime uses by ClickUp. We recommend leaving field mapping empty; SyncUp will automatically format order details in the task description to save your limits.
                          </div>
                        )}
                      </section>

                      {/* Configure order list connections */}
                      <section style={styles.card}>
                        <h2 style={{ ...styles.cardTitle, marginTop: 0 }}>Configure order {selectedPlatform === "clickup" ? "list" : selectedPlatform === "monday" ? "board" : "database"} connections</h2>
                        <p style={styles.cardText}>
                          Select where new orders should sync. Growth plan merchants can configure up to 5 {selectedPlatform === "clickup" ? "lists" : selectedPlatform === "monday" ? "boards" : "databases"} with keyword filters to route orders automatically.
                        </p>

                        {lists.length === 0 ? (
                          <p style={styles.cardText}>
                            No {selectedPlatform === "clickup" ? "lists" : selectedPlatform === "monday" ? "boards" : "databases"} found in workspaces. Create one first then reload this page.
                          </p>
                        ) : (
                          <Form method="post" style={styles.form}>
                            <input type="hidden" name="intent" value="save_connections" />
                            <input type="hidden" name="listConnectionsJson" value={JSON.stringify(conns)} />

                            <div style={styles.connectionsContainer}>
                              {conns.map((conn, index) => (
                                <div key={index} style={styles.connectionRow}>
                                  <div style={{ flex: 2, minWidth: "150px" }}>
                                    <label style={styles.formLabel} htmlFor={`list_${index}`}>
                                      {selectedPlatform === "clickup" ? "ClickUp List" : selectedPlatform === "monday" ? "Monday Board" : "Notion Database"}{" "}
                                      <InfoTooltip text={`The specific destination ${selectedPlatform === "clickup" ? "list" : selectedPlatform === "monday" ? "board" : "database"} where synced order tasks will be created.`} />
                                    </label>
                                    <select
                                      id={`list_${index}`}
                                      value={conn.id}
                                      onChange={(e) => {
                                        const selectedId = e.currentTarget.value;
                                        const match = lists.find((l) => l.id === selectedId);
                                        const updated = [...conns];
                                        updated[index] = {
                                          ...conn,
                                          id: selectedId,
                                          name: match ? match.name : "",
                                        };
                                        setConns(updated);
                                      }}
                                      style={styles.select}
                                    >
                                      <option value="">Select...</option>
                                      {lists.map((list) => (
                                        <option key={list.id} value={list.id}>
                                          {list.name}
                                        </option>
                                      ))}
                                    </select>
                                  </div>

                                  {listLimit > 1 && (
                                    <>
                                      <div style={{ flex: 1, minWidth: "120px" }}>
                                        <label style={styles.formLabel} htmlFor={`kw_${index}`}>
                                          Product Keyword <InfoTooltip text="Only route orders containing products whose title, vendor, or SKU matches this word (e.g. 'boot')." />
                                        </label>
                                        <input
                                          id={`kw_${index}`}
                                          type="text"
                                          placeholder="e.g. Shoes or Vendor"
                                          value={conn.keyword || ""}
                                          onChange={(e) => {
                                            const updated = [...conns];
                                            updated[index] = { ...conn, keyword: e.currentTarget.value };
                                            setConns(updated);
                                          }}
                                          style={styles.input}
                                          className="border border-zinc-800"
                                        />
                                      </div>
                                      <div style={{ flex: 1, minWidth: "120px" }}>
                                        <label style={styles.formLabel} htmlFor={`loc_${index}`}>
                                          Location ID <InfoTooltip text="Only route orders if they are fulfilled from this physical Shopify warehouse/location ID." />
                                        </label>
                                        <input
                                          id={`loc_${index}`}
                                          type="text"
                                          placeholder="Shopify Location ID"
                                          value={conn.routingLocationId || ""}
                                          onChange={(e) => {
                                            const updated = [...conns];
                                            updated[index] = { ...conn, routingLocationId: e.currentTarget.value };
                                            setConns(updated);
                                          }}
                                          style={styles.input}
                                          className="border border-zinc-800"
                                        />
                                      </div>
                                      <div style={{ flex: 1, minWidth: "120px" }}>
                                        <label style={styles.formLabel} htmlFor={`tag_${index}`}>
                                          Order Tag <InfoTooltip text="Only route orders that carry this specific Shopify order tag or product tag (e.g. 'B2B')." />
                                        </label>
                                        <input
                                          id={`tag_${index}`}
                                          type="text"
                                          placeholder="Order/product tag name"
                                          value={conn.routingTag || ""}
                                          onChange={(e) => {
                                            const updated = [...conns];
                                            updated[index] = { ...conn, routingTag: e.currentTarget.value };
                                            setConns(updated);
                                          }}
                                          style={styles.input}
                                          className="border border-zinc-800"
                                        />
                                      </div>
                                    </>
                                  )}

                                  {listLimit > 1 && conns.length > 1 && (
                                    <button
                                      type="button"
                                      onClick={() => setConns(conns.filter((_, i) => i !== index))}
                                      style={styles.removeConnButton}
                                    >
                                      Remove
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>

                            {conns.length < listLimit && (
                              <button
                                type="button"
                                onClick={() => setConns([...conns, { id: lists[0]?.id || "", name: lists[0]?.name || "", keyword: "", routingLocationId: "", routingTag: "" }])}
                                style={styles.addConnButton}
                              >
                                + Add connection
                              </button>
                            )}

                            <button
                              type="submit"
                              style={styles.primaryButton}
                              disabled={isSubmitting}
                            >
                              {isSubmitting ? "Saving…" : "Save connections"}
                            </button>
                          </Form>
                        )}
                      </section>
                        </>
                      )}

                      {activeTab === "mappings" && (
                        <>
                          {/* Custom Field Mapping */}
                          <section style={styles.card}>
                        {(() => {
                          const isTrial = subscription.planName === "trial";
                          const isGrowthOrPro = subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro");
                          const isMappingUnlocked = isGrowthOrPro || isTrial;
                          const platformName = selectedPlatform === "clickup" ? "ClickUp" : selectedPlatform === "monday" ? "Monday.com" : "Notion";
                          const termFieldName = selectedPlatform === "clickup" ? "Custom Field" : selectedPlatform === "monday" ? "Column" : "Property";

                          if (!isMappingUnlocked) {
                            return (
                              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                                <h2 style={{ ...styles.cardTitle, marginTop: 0, display: "flex", alignItems: "center", gap: 8 }}>
                                  {platformName} {termFieldName} Mapping
                                  <span style={{
                                    fontSize: 10,
                                    color: "#ff9900",
                                    background: "rgba(255,153,0,0.12)",
                                    border: "1px solid #ff990044",
                                    padding: "2px 8px",
                                    borderRadius: 12,
                                    fontWeight: 700,
                                    textTransform: "uppercase"
                                  }}>
                                    Locked
                                  </span>
                                </h2>
                                <p style={styles.cardText}>
                                  Map Shopify order attributes directly to your custom {termFieldName.toLowerCase()}s in {platformName}. This feature is available on the Growth & Pro plans.
                                </p>
                                <div style={{ alignSelf: "flex-start", marginTop: 8 }}>
                                  <Link
                                    to={`/app/billing?platform=${selectedPlatform}`}
                                    style={{
                                      ...styles.primaryButton,
                                      display: "inline-block",
                                      textDecoration: "none",
                                      textAlign: "center",
                                    }}
                                  >
                                    Upgrade to Unlock Custom Mapping
                                  </Link>
                                </div>
                              </div>
                            );
                          }

                          const hasSelectedList = listConnections && listConnections.length > 0;
                          if (!hasSelectedList) {
                            return (
                              <div>
                                <h2 style={{ ...styles.cardTitle, marginTop: 0 }}>{platformName} {termFieldName} Mapping</h2>
                                <p style={styles.cardText}>
                                  Please configure and save at least one connection above to begin mapping custom {termFieldName.toLowerCase()}s.
                                </p>
                              </div>
                            );
                          }

                          return (
                            <div>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
                                <div style={{ flex: 1, minWidth: "250px" }}>
                                  <h2 style={{ ...styles.cardTitle, marginTop: 0, display: "flex", alignItems: "center", gap: 8 }}>
                                    {platformName} {termFieldName} Mapping
                                    <span style={{
                                      fontSize: 10,
                                      color: C.accent,
                                      background: "rgba(0,196,140,0.12)",
                                      border: `1px solid ${C.accent}44`,
                                      padding: "2px 8px",
                                      borderRadius: 12,
                                      fontWeight: 700,
                                      textTransform: "uppercase"
                                    }}>
                                      Active
                                    </span>
                                  </h2>
                                  <p style={styles.cardText}>
                                    Map Shopify order attributes directly to custom {termFieldName.toLowerCase()}s inside your primary connected {selectedPlatform === "clickup" ? "list" : selectedPlatform === "monday" ? "board" : "database"}.
                                  </p>
                                </div>
                                
                                <Form method="post">
                                  <input type="hidden" name="intent" value="save_field_mappings" />
                                  <input type="hidden" name="fieldMappingsJson" value={JSON.stringify(fieldMappingsList)} />
                                  <button
                                    type="submit"
                                    className="bg-emerald-500 hover:bg-emerald-400 text-zinc-950 px-4 py-2 rounded-xl text-xs font-black tracking-wide transition-all duration-200 cursor-pointer shadow-lg shadow-emerald-500/10"
                                    disabled={isSubmitting}
                                    style={{ border: "none", color: "#03251c", outline: "none" }}
                                  >
                                    {isSubmitting ? "Saving..." : "Save mappings"}
                                  </button>
                                </Form>
                              </div>

                              {actionData?.savedMappings && (
                                <div style={{ ...styles.successBanner, marginBottom: 16 }}>
                                  ✓ Mappings saved successfully.
                                </div>
                              )}

                              {/* TEMPLATE PRESETS BAR */}
                              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
                                <span style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>Start from a preset:</span>
                                {["basic", "customer", "financial"].map((preset) => (
                                  <button
                                    key={preset}
                                    type="button"
                                    onClick={() => applyPreset(preset)}
                                    style={{
                                      background: "rgba(255,255,255,0.05)",
                                      border: `1px solid ${C.border}`,
                                      color: C.text,
                                      padding: "4px 10px",
                                      borderRadius: 8,
                                      fontSize: 11,
                                      fontWeight: 600,
                                      cursor: "pointer",
                                      transition: "all 0.2s"
                                    }}
                                    onMouseEnter={(e) => e.currentTarget.style.borderColor = C.accent}
                                    onMouseLeave={(e) => e.currentTarget.style.borderColor = C.border}
                                  >
                                    {preset === "basic" ? "📦 Basic" : preset === "customer" ? "📋 Full Customer" : "💰 Financial"}
                                  </button>
                                ))}
                              </div>

                              {selectedPlatform === "clickup" && (isFreePlan || fieldMappingsList.length > 0) && (
                                <div style={{ ...styles.warningBanner, marginBottom: 16, fontSize: "13px", lineHeight: "1.4" }}>
                                  <strong>⚠️ ClickUp Free Tier Notice:</strong> ClickUp Free Forever plans have a lifetime limit of 60 custom field uses. {isFreePlan ? "Your connected workspace is detected as Free tier, so custom field syncing will stop once this limit is reached. We recommend keeping field mappings empty; SyncUp will format all order details in the task description to save your limits." : "If your workspace is on the Free tier, updates to mapped fields will stop syncing once this limit is reached."}
                                </div>
                              )}

                              {clickupFields.length === 0 ? (
                                <p style={styles.cardText}>
                                  No custom {termFieldName.toLowerCase()}s found in your connected {selectedPlatform === "clickup" ? "list" : selectedPlatform === "monday" ? "board" : "database"}. Create some first, then reload this page.
                                </p>
                              ) : (
                                <div style={{ border: `1px solid ${C.border}`, borderRadius: "12px", overflow: "hidden", background: "#151515" }}>
                                  {/* Table Header */}
                                  <div className="grid grid-cols-12 bg-zinc-900/50 p-4 border-b border-zinc-800 font-semibold text-xs tracking-wider uppercase text-zinc-400">
                                    <div className="col-span-5">
                                      Shopify Source Field <InfoTooltip text="The data point from the Shopify order (e.g. Customer Email or Shipping Cost)." />
                                    </div>
                                    <div className="col-span-2 text-center">Flow</div>
                                    <div className="col-span-5">
                                      Destination {termFieldName} <InfoTooltip text={`The custom field or column in your connected ${selectedPlatform === "clickup" ? "list" : selectedPlatform === "monday" ? "board" : "database"} to map the data to.`} />
                                    </div>
                                  </div>

                                  {/* Mappings */}
                                  <div className="divide-y divide-zinc-900/50">
                                    {clickupFields.map((field) => {
                                      const currentMapping = fieldMappingsList.find((m) => m.clickupFieldId === field.id);
                                      const shopifyField = SHOPIFY_SOURCE_FIELDS.find((sf) => sf.id === currentMapping?.shopifySourceField);
                                      const validation = currentMapping ? checkFieldCompatibility(shopifyField?.type, field.type, selectedPlatform) : { valid: true };
                                      return (
                                        <div key={field.id} className="grid grid-cols-12 items-center p-4 hover:bg-zinc-900/10 transition-colors">
                                          {/* Shopify field selector */}
                                          <div className="col-span-5">
                                            <select
                                              value={currentMapping?.shopifySourceField || ""}
                                              onChange={(e) => {
                                                const val = e.currentTarget.value;
                                                setFieldMappingsList((prev) => {
                                                  const filtered = prev.filter((m) => m.clickupFieldId !== field.id);
                                                  if (!val) return filtered;
                                                  return [
                                                    ...filtered,
                                                    {
                                                      shopifySourceField: val,
                                                      clickupFieldId: field.id,
                                                      clickupFieldName: field.name,
                                                      clickupFieldType: field.type,
                                                    },
                                                  ];
                                                });
                                              }}
                                              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer"
                                            >
                                              <option value="">-- Leave Unmapped --</option>
                                              {SHOPIFY_SOURCE_FIELDS.map((src) => (
                                                <option key={src.id} value={src.id}>
                                                  {src.label} ({src.type.toUpperCase()})
                                                </option>
                                              ))}
                                            </select>
                                            {!validation.valid && (
                                              <div style={{
                                                marginTop: 6,
                                                fontSize: 10,
                                                color: validation.tone === "critical" ? "#ff4444" : "#ff9900",
                                                display: "flex",
                                                gap: 4,
                                                alignItems: "flex-start",
                                                lineHeight: "1.3"
                                              }}>
                                                <span>⚠️</span>
                                                <span>{validation.message}</span>
                                              </div>
                                            )}
                                          </div>

                                          {/* Arrow icon */}
                                          <div className="col-span-2 flex justify-center text-emerald-400">
                                            <span style={{ fontSize: "14px", fontWeight: "bold" }}>&rarr;</span>
                                          </div>

                                          {/* ClickUp Custom Field read-only info */}
                                          <div className="col-span-5 flex justify-between items-center pl-2">
                                            <div>
                                              <span className="font-semibold text-xs text-white">{field.name}</span>
                                              <div className="flex gap-1.5 mt-1">
                                                <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-zinc-900 text-zinc-400 border border-zinc-800">
                                                  {field.type}
                                                </span>
                                              </div>
                                            </div>
                                            <div className="text-zinc-500 font-mono text-[10px] hidden sm:block">
                                              {field.id.slice(0, 8)}...
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </section>
                        </>
                      )}

                      {activeTab === "settings" && (
                        <>
                          {/* Sync Settings */}
                          <section style={styles.card}>
                        <h2 style={{ ...styles.cardTitle, marginTop: 0 }}>Sync Settings</h2>
                        <p style={styles.cardText}>
                          Configure how and when orders are synced to your connected workspace tool.
                        </p>

                        <Form method="post" style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 24 }}>
                          <input type="hidden" name="intent" value="save_settings" />

                          {/* Task Name Template */}
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <label style={{ ...styles.formLabel, marginBottom: 0 }} htmlFor="taskNameTemplate">
                              Task Name Template <InfoTooltip text="Customize the name of the created task. Use bracket variables like {order_number} or {customer_name} to dynamically inject order data." />
                            </label>
                            <p style={{ ...styles.cardText, margin: 0, fontSize: 12 }}>
                              Customise the task title using tokens. Leave blank to use the default.
                            </p>
                            <input
                              id="taskNameTemplate"
                              name="taskNameTemplate"
                              type="text"
                              value={localTaskTemplate}
                              onChange={(e) => setLocalTaskTemplate(e.currentTarget.value)}
                              placeholder="Order {order_number} — {customer_name}"
                              style={styles.input}
                            />
                            {/* Token chips */}
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                              {[
                                "{order_number}",
                                "{customer_name}",
                                "{order_total}",
                                "{shipping_method}",
                                "{item_count}",
                                "{payment_status}",
                              ].map((token) => (
                                <button
                                  key={token}
                                  type="button"
                                  onClick={() => setLocalTaskTemplate((prev) => (prev ? `${prev} ${token}` : token))}
                                  style={{
                                    fontSize: 11,
                                    background: "rgba(0,196,140,0.08)",
                                    border: "1px solid rgba(0,196,140,0.2)",
                                    color: C.accent,
                                    padding: "3px 8px",
                                    borderRadius: 6,
                                    cursor: "pointer",
                                    fontWeight: 500,
                                    outline: "none",
                                  }}
                                >
                                  {token}
                                </button>
                              ))}
                            </div>
                            
                            {/* Live Preview Box */}
                            <div style={{
                              marginTop: 10,
                              padding: "12px 14px",
                              background: "rgba(255,255,255,0.03)",
                              border: `1px dashed ${C.border}`,
                              borderRadius: "10px",
                            }}>
                              <div style={{ fontSize: 10, color: C.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                                Live Preview (using latest store order)
                              </div>
                              <div style={{ fontSize: 13, color: C.accent, fontWeight: "bold", marginTop: 4, fontFamily: "monospace" }}>
                                {compiledTemplatePreview}
                              </div>
                            </div>
                          </div>

                          {/* Task Description Template */}
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <label style={{ ...styles.formLabel, marginBottom: 0 }} htmlFor="taskDescriptionTemplate">
                                Task Description Template <InfoTooltip text="Customize the description body of the task. Supports rich text, custom tokens, and line item tables." />
                              </label>
                              {!(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial") && (
                                <span style={{ fontSize: 9, background: "rgba(255,153,0,0.12)", color: "#ff9900", border: "1px solid rgba(255,153,0,0.3)", borderRadius: 6, padding: "1px 6px", fontWeight: 700, textTransform: "uppercase" }}>Growth+</span>
                              )}
                            </div>
                            <p style={{ ...styles.cardText, margin: 0, fontSize: 12 }}>
                              Customize the task body using Liquid-like syntax. Loops are supported for line items.
                            </p>
                            <textarea
                              id="taskDescriptionTemplate"
                              name="taskDescriptionTemplate"
                              rows={5}
                              value={localTaskDescriptionTemplate}
                              onChange={(e) => setLocalTaskDescriptionTemplate(e.currentTarget.value)}
                              placeholder={`Order Total: {{ order.total }}\nShipping: {{ order.shipping_method }}\n\nItems:\n{% for item in line_items %}\n- {{ item.quantity }}x {{ item.title }}{{ item.variant }} [SKU: {{ item.sku }}]\n{% endfor %}`}
                              style={{
                                ...styles.input,
                                fontFamily: "monospace",
                                fontSize: 12,
                                resize: "vertical",
                              }}
                              disabled={!(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial")}
                            />
                            {/* Token chips */}
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                              {[
                                "{{ order.order_number }}",
                                "{{ order.customer_name }}",
                                "{{ order.email }}",
                                "{{ order.phone }}",
                                "{{ order.total }}",
                                "{{ order.shipping_method }}",
                                "{{ order.item_count }}",
                                "{{ order.payment_status }}",
                                "{{ order.notes }}",
                                "{{ order.admin_url }}",
                                "{{ order.shipping_address }}",
                                "line_items loop block"
                              ].map((token) => (
                                <button
                                  key={token}
                                  type="button"
                                  disabled={!(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial")}
                                  onClick={() => {
                                    setLocalTaskDescriptionTemplate((prev) => {
                                      const insertText = token === "line_items loop block"
                                        ? "{% for item in line_items %}\n- {{ item.quantity }}x {{ item.title }}{{ item.variant }} [SKU: {{ item.sku }}]\n{% endfor %}"
                                        : token;
                                      return prev ? `${prev} ${insertText}` : insertText;
                                    });
                                  }}
                                  style={{
                                    fontSize: 11,
                                    background: "rgba(0,196,140,0.08)",
                                    border: "1px solid rgba(0,196,140,0.2)",
                                    color: C.accent,
                                    padding: "3px 8px",
                                    borderRadius: 6,
                                    cursor: !(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial") ? "not-allowed" : "pointer",
                                    fontWeight: 500,
                                    outline: "none",
                                    opacity: !(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial") ? 0.5 : 1
                                  }}
                                >
                                  {token}
                                </button>
                              ))}
                            </div>

                            {/* Description Live Preview Box */}
                            <div style={{
                              marginTop: 10,
                              padding: "12px 14px",
                              background: "rgba(255,255,255,0.03)",
                              border: `1px dashed ${C.border}`,
                              borderRadius: "10px",
                            }}>
                              <div style={{ fontSize: 10, color: C.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                                Description Live Preview (using latest store order)
                              </div>
                              <pre style={{
                                fontSize: 12,
                                color: C.accent,
                                marginTop: 6,
                                fontFamily: "monospace",
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-all",
                                margin: 0
                              }}>
                                {compiledDescriptionPreview}
                              </pre>
                            </div>
                          </div>

                           {/* When to create tasks Selector */}
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <label style={{ ...styles.formLabel, marginBottom: 0 }}>
                              When to create tasks <InfoTooltip text="Choose the exact event in Shopify that triggers task creation: when payment is Captured/Paid, immediately when order is placed, or when fulfillment begins." />
                            </label>
                            <p style={{ ...styles.cardText, margin: 0, fontSize: 12 }}>
                              Choose when a task is created for new orders.
                            </p>
                            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
                              {[
                                { id: "payment_confirmed", title: "When order is paid (Recommended)", desc: "Creates the task when the order is marked paid." },
                                { id: "on_create", title: "Immediately when order is placed", desc: "Creates the task as soon as the customer checks out (including unpaid draft orders)." },
                                { id: "on_fulfillment_start", title: "When order starts shipping", desc: "Creates the task when you start processing or shipping." }
                              ].map(({ id, title, desc }) => (
                                <label key={id} style={{ display: "flex", gap: 12, alignItems: "flex-start", cursor: "pointer" }}>
                                  <input
                                    type="radio"
                                    name="syncTrigger"
                                    value={id}
                                    checked={localSyncTrigger === id}
                                    onChange={() => setLocalSyncTrigger(id)}
                                    style={{ marginTop: 4, accentColor: C.accent }}
                                  />
                                  <div>
                                    <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
                                      {title}
                                    </div>
                                    <div style={{ fontSize: 12, color: "#9a9a9a", marginTop: 3 }}>{desc}</div>
                                  </div>
                                </label>
                              ))}
                            </div>
                          </div>

                          {/* Subtasks Toggle */}
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderRadius: 10, border: "1px solid #2a2a2a", background: "#151515" }}>
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 600, color: "#ffffff", display: "flex", alignItems: "center", gap: 6 }}>
                                Create a subtask per product <InfoTooltip text="When enabled, each product variant in the Shopify order is created as a separate subtask under the main task." />
                                {!(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial") && (
                                  <span style={{ fontSize: 9, background: "rgba(255,153,0,0.12)", color: "#ff9900", border: "1px solid rgba(255,153,0,0.3)", borderRadius: 6, padding: "1px 6px", fontWeight: 700, textTransform: "uppercase" }}>Growth+</span>
                                )}
                              </div>
                              <div style={{ fontSize: 12, color: "#9a9a9a", marginTop: 3 }}>
                                Each product variant in the Shopify order becomes a separate subtask.
                              </div>
                            </div>
                            <input type="hidden" name="subtasksEnabled" value={String(localSubtasks)} />
                            <button
                              type="button"
                              role="switch"
                              aria-checked={localSubtasks}
                              disabled={!(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial")}
                              onClick={() => setLocalSubtasks((v) => !v)}
                              style={{
                                width: 44,
                                height: 24,
                                borderRadius: 12,
                                background: localSubtasks ? "#00c48c" : "#2a2a2a",
                                border: "none",
                                cursor: "pointer",
                                position: "relative",
                                flexShrink: 0,
                                transition: "background 0.2s ease",
                                outline: "none",
                              }}
                            >
                              <span style={{
                                position: "absolute",
                                top: 2,
                                left: localSubtasks ? 22 : 2,
                                width: 20,
                                height: 20,
                                borderRadius: "50%",
                                background: "#ffffff",
                                transition: "left 0.2s ease",
                                boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                              }} />
                            </button>
                          </div>

                          {/* Two-Way Status Sync Toggle */}
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderRadius: 10, border: "1px solid #2a2a2a", background: "#151515" }}>
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 600, color: "#ffffff", display: "flex", alignItems: "center", gap: 6 }}>
                                Mark task complete when order ships <InfoTooltip text="Automatically fulfill the Shopify order when the mapped task is marked complete or done in ClickUp or Monday." />
                                {!(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial") && (
                                  <span style={{ fontSize: 9, background: "rgba(255,153,0,0.12)", color: "#ff9900", border: "1px solid rgba(255,153,0,0.3)", borderRadius: 6, padding: "1px 6px", fontWeight: 700, textTransform: "uppercase" }}>Growth+</span>
                                )}
                              </div>
                              <div style={{ fontSize: 12, color: "#9a9a9a", marginTop: 3 }}>
                                Automatically fulfill and close the Shopify order when its task is marked complete in ClickUp/Monday.
                              </div>
                            </div>
                            <input type="hidden" name="twoWaySyncEnabled" value={String(localTwoWaySync)} />
                            <button
                              type="button"
                              role="switch"
                              aria-checked={localTwoWaySync}
                              disabled={!(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial")}
                              onClick={() => {
                                if (!localTwoWaySync) {
                                  const confirm = window.confirm(
                                    "⚠️ Warning: Enabling this option will automatically fulfill and close Shopify orders when their corresponding tasks are marked complete in your project management tool. Do you want to continue?"
                                  );
                                  if (!confirm) return;
                                }
                                setLocalTwoWaySync((v) => !v);
                              }}
                              style={{
                                width: 44,
                                height: 24,
                                borderRadius: 12,
                                background: localTwoWaySync ? "#00c48c" : "#2a2a2a",
                                border: "none",
                                cursor: !(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial") ? "not-allowed" : "pointer",
                                position: "relative",
                                flexShrink: 0,
                                transition: "background 0.2s ease",
                                outline: "none",
                                opacity: !(subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro") || subscription.planName === "trial") ? 0.5 : 1
                              }}
                            >
                              <span style={{
                                position: "absolute",
                                top: 2,
                                left: localTwoWaySync ? 22 : 2,
                                width: 20,
                                height: 20,
                                borderRadius: "50%",
                                background: "#ffffff",
                                transition: "left 0.2s ease",
                                boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                              }} />
                            </button>
                          </div>

                          <button
                            type="submit"
                            style={{ ...styles.primaryButton, alignSelf: "flex-start" }}
                            disabled={isSubmitting}
                          >
                            {isSubmitting ? "Saving…" : "Save settings"}
                          </button>
                        </Form>
                      </section>
                        </>
                      )}

                    </div>

                    {/* RIGHT COLUMN: Health, Stats & Live Event feed */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                      
                      {/* Webhook Health Badge Card */}
                      <section style={styles.card}>
                        <h2 style={{ ...styles.cardTitle, marginTop: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          Connection Health
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              textTransform: "uppercase",
                              padding: "2px 8px",
                              borderRadius: 12,
                              letterSpacing: "0.05em",
                              color: healthStatus === "healthy" ? C.accent : "#ff4444",
                              background: healthStatus === "healthy" ? "rgba(0, 196, 140, 0.12)" : "rgba(255, 68, 68, 0.12)",
                              border: `1px solid ${healthStatus === "healthy" ? C.accent : "#ff4444"}44`,
                            }}
                          >
                            {healthStatus === "healthy" ? "Live" : "Error"}
                          </span>
                        </h2>
                        <p style={{ ...styles.cardText, margin: 0 }}>
                          {healthStatus === "healthy"
                            ? `✓ Your integration with ${selectedPlatform === "clickup" ? "ClickUp" : selectedPlatform === "monday" ? "Monday.com" : "Notion"} is functioning normally.`
                            : `⚠️ Your connection has dropped. Please disconnect and reconnect to resume order syncing.`}
                        </p>
                      </section>

                      {/* Sync Analytics Card */}
                      {(() => {
                        const isTrial = subscription.planName === "trial";
                        const isGrowthOrPro = subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro");
                        const isAnalyticsUnlocked = isGrowthOrPro || isTrial;

                        return (
                          <section style={{ ...styles.card }}>
                            <h2 style={{ ...styles.cardTitle, marginTop: 0, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              Sync Analytics
                              {isTrial && (
                                <span style={{
                                  fontSize: 10,
                                  color: C.accent,
                                  background: "rgba(0,196,140,0.12)",
                                  border: `1px solid ${C.accent}44`,
                                  padding: "2px 8px",
                                  borderRadius: 12,
                                  fontWeight: 600,
                                  textTransform: "uppercase",
                                  letterSpacing: "0.05em"
                                }}>
                                  Trial mode
                                </span>
                              )}
                            </h2>

                            {/* Stats Grid - Unlocked and always visible */}
                            <div style={styles.analyticsGrid}>
                              <div style={styles.analyticsStatCard}>
                                <div style={styles.analyticsStatLabel}>Synced this month</div>
                                <div style={styles.analyticsStatValue}>{analytics.totalSyncedMonth}</div>
                              </div>
                              <div style={styles.analyticsStatCard}>
                                <div style={styles.analyticsStatLabel}>Synced all time</div>
                                <div style={styles.analyticsStatValue}>{analytics.totalSyncedAllTime}</div>
                              </div>
                              <div style={styles.analyticsStatCard}>
                                <div style={styles.analyticsStatLabel}>Synced today</div>
                                <div style={styles.analyticsStatValue}>{syncedToday}</div>
                              </div>
                            </div>

                            {/* Recent Sync Events - Blurred & Locked section for free/standard tier */}
                            <div style={{ position: "relative", marginTop: 24, minHeight: 180 }}>
                              <div style={isAnalyticsUnlocked ? {} : { filter: "blur(4px)", pointerEvents: "none", opacity: 0.6 }}>
                                <h3 style={styles.sectionSubheading}>Recent Sync Events</h3>
                                {analytics.recentTasks.length === 0 ? (
                                  <p style={styles.cardText}>No sync events recorded yet.</p>
                                ) : (
                                  <table style={styles.table}>
                                    <thead>
                                      <tr>
                                        <th style={styles.th}>Time</th>
                                        <th style={styles.th}>Order</th>
                                        <th style={styles.th}>Status</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {analytics.recentTasks.map((t) => (
                                        <tr key={t.id} style={styles.tr}>
                                          <td style={styles.td}>{timeAgo(t.createdAt)}</td>
                                          <td style={styles.td}>{t.orderNumber}</td>
                                          <td style={styles.td}>
                                            <span
                                              style={{
                                                ...styles.statusBadgeInline,
                                                color: t.status === "failed" ? "#ff4444" : t.status === "retrying" ? "#ff9900" : "#00c48c",
                                                background: t.status === "failed" ? "rgba(255,68,68,0.12)" : t.status === "retrying" ? "rgba(255,153,0,0.12)" : "rgba(0,196,140,0.12)",
                                              }}
                                            >
                                              {t.status}
                                            </span>
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                              </div>

                              {!isAnalyticsUnlocked && (
                                <div style={{
                                  ...styles.analyticsLockOverlay,
                                  borderRadius: 12,
                                  background: "rgba(26, 26, 26, 0.9)",
                                  backdropFilter: "blur(2px)",
                                  padding: 16
                                }}>
                                  <div style={styles.lockIcon}>🔒</div>
                                  <div style={styles.lockTitle}>Growth Plan Feature</div>
                                  <div style={styles.lockText}>
                                    Upgrade to the Growth plan to unlock sync history, up to 5 connection routes, and automatic fulfillment updates.
                                  </div>
                                  <Link to={`/app/billing?platform=${selectedPlatform}`} style={styles.upgradeInlineButton}>
                                    Upgrade to Growth
                                  </Link>
                                </div>
                              )}
                            </div>
                          </section>
                        );
                      })()}

                      {/* Recent Activity Log */}
                      <section style={styles.card}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                          <h2 style={{ ...styles.cardTitle, marginTop: 0, marginBottom: 0 }}>
                            Recent log
                          </h2>
                          <Link
                            to="/app/history"
                            style={{ fontSize: 12, color: "#00c48c", textDecoration: "none", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4 }}
                          >
                            View full history →
                          </Link>
                        </div>
                        {recentActivity.length === 0 ? (
                          <p style={{ ...styles.cardText, color: C.muted, margin: "12px 0 0 0" }}>
                            No sync activity recorded yet. Place a test order to see logs here.
                          </p>
                        ) : (
                          <ul style={styles.activityList}>
                            {recentActivity.map((event) => (
                              <li key={event.id} style={styles.activityItem}>
                                <span
                                  style={{
                                    ...styles.activityIcon,
                                    color: EVENT_COLORS[event.eventType] || C.muted,
                                  }}
                                >
                                  {EVENT_ICONS[event.eventType] || "·"}
                                </span>
                                <span style={styles.activityDescription}>
                                  {event.description}
                                </span>
                                <span style={styles.activityTime}>
                                  {timeAgo(event.createdAt)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </section>

                    </div>
                  </div>
                </div>
              )}</>
          )}

          <footer style={styles.footer}>
            Connected store: <span style={styles.footerShop}>{shop}</span>
            {" · "}
            <a href="/privacy" target="_top" style={styles.footerLink}>
              Privacy Policy
            </a>
          </footer>
        </div>
      </div>
    </>
  );
}

const styles = {
  page: {
    background: C.bg,
    color: C.text,
    minHeight: "100vh",
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding: "40px 20px",
    boxSizing: "border-box",
  },
  container: {
    maxWidth: 640,
    margin: "0 auto",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    marginBottom: 24,
    flexWrap: "wrap",
  },
  logoMark: {
    width: 44,
    height: 44,
    borderRadius: 12,
    background: C.surface,
    border: `1px solid ${C.border}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  title: { margin: 0, fontSize: 24, fontWeight: 600, color: C.text },
  subtitle: { margin: "4px 0 0", fontSize: 14, color: C.muted },
  statusBadge: {
    display: "flex",
    alignItems: "center",
    fontSize: 12,
    fontWeight: 600,
    padding: "5px 10px",
    borderRadius: 20,
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  card: {
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 16,
    padding: 24,
  },
  cardHeaderRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
    gap: 12,
    flexWrap: "wrap",
  },
  cardTitle: { margin: "16px 0 8px", fontSize: 16, fontWeight: 600, color: C.text },
  cardText: { margin: "0 0 20px", fontSize: 14, lineHeight: 1.6, color: C.muted },
  statusRow: { display: "flex", alignItems: "center", gap: 8 },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: C.accent,
    boxShadow: `0 0 8px ${C.accent}`,
    flexShrink: 0,
  },
  statusText: { fontSize: 14, fontWeight: 500, color: C.text },
  form: { display: "flex", flexDirection: "column", gap: 16 },
  formLabel: { fontSize: 12, fontWeight: 600, color: C.muted, display: "block", marginBottom: 6 },
  label: { fontSize: 13, fontWeight: 500, color: C.muted },
  select: {
    width: "100%",
    background: C.bg,
    color: C.text,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: "12px 14px",
    fontSize: 14,
    outline: "none",
    boxSizing: "border-box",
  },
  input: {
    width: "100%",
    background: C.bg,
    color: C.text,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: "12px 14px",
    fontSize: 14,
    outline: "none",
    boxSizing: "border-box",
  },
  primaryButton: {
    display: "inline-block",
    background: C.accent,
    color: "#03251c",
    border: "none",
    borderRadius: 10,
    padding: "12px 22px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    textDecoration: "none",
    marginTop: 4,
    width: "fit-content",
    textAlign: "center",
  },
  dangerButton: {
    background: "transparent",
    color: C.muted,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
  },
  banner: {
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 14,
    fontWeight: 500,
    lineHeight: 1.5,
  },
  successBanner: {
    background: "rgba(0, 196, 140, 0.12)",
    border: `1px solid ${C.accent}`,
    color: C.accent,
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 14,
  },
  warningBanner: {
    background: "rgba(255, 153, 0, 0.12)",
    border: "1px solid #ff9900",
    color: "#ff9900",
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 14,
  },
  errorBanner: {
    background: "rgba(255, 68, 68, 0.12)",
    border: "1px solid #ff4444",
    color: "#ff4444",
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 14,
  },
  planRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
  },
  planLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: C.muted,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 4,
  },
  planName: {
    fontSize: 20,
    fontWeight: 700,
    color: C.text,
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },
  paidBadge: {
    fontSize: 11,
    fontWeight: 600,
    background: "rgba(0, 196, 140, 0.15)",
    color: C.accent,
    border: `1px solid ${C.accent}`,
    borderRadius: 6,
    padding: "2px 8px",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  usageText: { fontSize: 12, color: C.muted },
  managePlanButton: {
    display: "inline-block",
    background: "transparent",
    color: C.text,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: "10px 18px",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    textDecoration: "none",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  activityList: { listStyle: "none", padding: 0, margin: 0 },
  activityItem: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 0",
    borderBottom: `1px solid ${C.border}`,
    fontSize: 13,
  },
  activityIcon: { fontWeight: 700, flexShrink: 0, marginTop: 1 },
  activityDescription: { flex: 1, color: C.muted, lineHeight: 1.4 },
  activityTime: { color: C.border, fontSize: 11, flexShrink: 0, marginTop: 2 },
  footer: { marginTop: 24, fontSize: 13, color: C.muted, textAlign: "center" },
  footerShop: { color: C.text },
  footerLink: { color: C.muted, textDecoration: "underline" },

  // Pricing Card Layout Styles
  pricingCard: {
    background: C.bg,
    border: `1px solid ${C.border}`,
    borderRadius: 14,
    padding: 24,
    display: "flex",
    flexDirection: "column",
    gap: 16,
    position: "relative",
  },
  pricingCardHighlighted: {
    borderColor: "#3a3a5a",
    background: "#1e1e2e",
  },
  popularBadge: {
    position: "absolute",
    top: -12,
    left: "50%",
    transform: "translateX(-50%)",
    background: C.accent,
    color: "#03251c",
    fontSize: 11,
    fontWeight: 700,
    padding: "3px 12px",
    borderRadius: 12,
    whiteSpace: "nowrap",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  pricingHeader: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  pricingTitle: { margin: 0, fontSize: 18, fontWeight: 700, color: C.text },
  pricingPrice: { display: "flex", alignItems: "baseline", flexWrap: "wrap" },
  priceAmount: { fontSize: 28, fontWeight: 800, color: C.text },
  priceInterval: { fontSize: 14, color: C.muted, marginLeft: 2 },
  priceSubtext: { fontSize: 11, color: C.muted, width: "100%", marginTop: 2 },
  pricingFeatures: {
    listStyle: "none",
    padding: 0,
    margin: 0,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    fontSize: 13,
    color: C.muted,
  },
  pricingButton: {
    width: "100%",
    background: "transparent",
    color: C.text,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: "10px 14px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    textAlign: "center",
    boxSizing: "border-box",
  },
  pricingButtonHighlighted: {
    background: C.accent,
    color: "#03251c",
    borderColor: C.accent,
  },

  // Multiple List Connections UI Styles
  connectionsContainer: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    marginBottom: 8,
  },
  connectionRow: {
    display: "flex",
    alignItems: "flex-end",
    gap: 12,
    flexWrap: "wrap",
    background: C.bg,
    border: `1px solid ${C.border}`,
    borderRadius: 12,
    padding: 16,
  },
  removeConnButton: {
    background: "transparent",
    color: "#ff4444",
    border: "1px solid rgba(255,68,68,0.3)",
    borderRadius: 8,
    padding: "10px 14px",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    height: "fit-content",
    alignSelf: "flex-end",
  },
  addConnButton: {
    background: "transparent",
    color: C.accent,
    border: `1px dashed ${C.accent}`,
    borderRadius: 10,
    padding: "10px 16px",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    alignSelf: "flex-start",
    marginBottom: 8,
  },

  // Analytics Grid Styles
  analyticsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 16,
    margin: "12px 0 24px",
  },
  analyticsStatCard: {
    background: C.bg,
    border: `1px solid ${C.border}`,
    borderRadius: 12,
    padding: 16,
    textAlign: "center",
  },
  analyticsStatLabel: {
    fontSize: 11,
    color: C.muted,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    marginBottom: 6,
  },
  analyticsStatValue: {
    fontSize: 24,
    fontWeight: 700,
    color: C.text,
  },
  sectionSubheading: {
    fontSize: 14,
    fontWeight: 600,
    color: C.text,
    margin: "0 0 12px",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
    color: C.muted,
  },
  th: {
    textAlign: "left",
    padding: "10px 12px",
    borderBottom: `2px solid ${C.border}`,
    fontWeight: 600,
    color: C.text,
  },
  tr: {
    borderBottom: `1px solid ${C.border}`,
  },
  td: {
    padding: "12px",
  },
  statusBadgeInline: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 12,
    fontSize: 11,
    fontWeight: 600,
    textTransform: "capitalize",
  },
  analyticsLockOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(26, 26, 26, 0.8)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    textAlign: "center",
    zIndex: 10,
  },
  lockIcon: { fontSize: 32, marginBottom: 12 },
  lockTitle: { fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 },
  lockText: { fontSize: 13, color: C.muted, maxWidth: 360, lineHeight: 1.5, marginBottom: 16 },
  upgradeInlineButton: {
    display: "inline-block",
    background: C.accent,
    color: "#03251c",
    textDecoration: "none",
    borderRadius: 8,
    padding: "10px 20px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
};

export const headers = (headersArgs) => boundary.headers(headersArgs);
```

---

## File: [app/routes/auth.$.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/auth.$.jsx)

```jsx
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return null;
};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
```

---

## File: [app/routes/auth.clickup.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/auth.clickup.jsx)

```jsx
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
```

---

## File: [app/routes/auth.clickup_.callback.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/auth.clickup_.callback.jsx)

```jsx
/* global process */
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

  // Fetch workspace details and plan type — non-fatal if it errors
  let workspaceName = null;
  let isFreePlan = false;
  try {
    const teams = await getTeams(accessToken);
    const primaryTeam = teams[0] || null;
    if (primaryTeam) {
      workspaceName = primaryTeam.name || null;
      const planVal = primaryTeam.plan;
      const planStr = typeof planVal === "object" && planVal !== null ? planVal.name : planVal;
      if (planStr && String(planStr).toLowerCase().includes("free")) {
        isFreePlan = true;
      }
    }
  } catch (e) {
    console.error("Could not fetch ClickUp workspace metadata:", e);
  }

  await saveToken(shop, accessToken, workspaceName, isFreePlan);
  logActivity(shop, "clickup_connected", `Connected to ClickUp${workspaceName ? ` (${workspaceName})` : ""}`);

  return redirect(appUrl);
};
```

---

## File: [app/routes/auth.login/error.server.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/auth.login/error.server.jsx)

```jsx
import { LoginErrorType } from "@shopify/shopify-app-react-router/server";

export function loginErrorMessage(loginErrors) {
  if (loginErrors?.shop === LoginErrorType.MissingShop) {
    return { shop: "Please enter your shop domain to log in" };
  } else if (loginErrors?.shop === LoginErrorType.InvalidShop) {
    return { shop: "Please enter a valid shop domain to log in" };
  }

  return {};
}
```

---

## File: [app/routes/auth.login/route.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/auth.login/route.jsx)

```jsx
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useState } from "react";
import { Form, useActionData, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));

  return { errors };
};

export const action = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));

  return {
    errors,
  };
};

export default function Auth() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const [shop, setShop] = useState("");
  const { errors } = actionData || loaderData;

  return (
    <AppProvider embedded={false}>
      <s-page>
        <Form method="post">
          <s-section heading="Log in">
            <s-text-field
              name="shop"
              label="Shop domain"
              details="example.myshopify.com"
              value={shop}
              onChange={(e) => setShop(e.currentTarget.value)}
              autocomplete="on"
              error={errors.shop}
            ></s-text-field>
            <s-button type="submit">Log in</s-button>
          </s-section>
        </Form>
      </s-page>
    </AppProvider>
  );
}
```

---

## File: [app/routes/privacy.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/privacy.jsx)

```jsx
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
            automatically creates tasks in your connected project management tools
            (such as ClickUp) when orders are placed in your Shopify store, and
            marks those tasks complete when orders are fulfilled. This Privacy
            Policy explains what data we collect, how we use it, and how you can
            request its deletion.
          </p>

          <h3 style={styles.h3}>Data We Collect</h3>
          <p style={styles.p}>
            <strong>Shop data:</strong> We store your Shopify shop domain and
            authentication tokens required to integrate with Shopify and your
            connected project management tools.
          </p>
          <p style={styles.p}>
            <strong>Order data:</strong> When an order is placed, we store the
            Shopify order ID and the corresponding task ID in your project tool
            so we can mark the task complete on fulfillment. We do not store
            customer names, email addresses, payment details, or any other
            personally identifiable information on our servers.
          </p>
          <p style={styles.p}>
            <strong>Project tool credentials:</strong> We store your connected
            project management tool&apos;s credentials (such as OAuth access tokens)
            and the target folder/list/board ID you choose to sync orders into.
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
            creating tasks in your connected project tools, marking tasks
            complete on fulfillment, and enforcing plan limits. We do not sell,
            rent, or share your data with third parties for marketing purposes.
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
              <strong>Project Management Tools (e.g. ClickUp)</strong> — to
              create and manage tasks. Their privacy policies govern their data
              handling.
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
```

---

## File: [app/routes/webhooks.app.scopes_update.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/webhooks.app.scopes_update.jsx)

```jsx
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);
  const current = payload.current;

  if (session) {
    await db.session.update({
      where: {
        id: session.id,
      },
      data: {
        scope: current.toString(),
      },
    });
  }

  return new Response();
};
```

---

## File: [app/routes/webhooks.app.subscriptions_update.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/webhooks.app.subscriptions_update.jsx)

```jsx
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { PLANS } from "../plans";
import { logActivity, handleDowngradeToListLimit } from "../clickup.server";

const PLAN_NAME_MAP = {
  "SyncUp Standard Monthly": "standard_monthly",
  "SyncUp Standard Annual": "standard_annual",
  "SyncUp Growth Monthly": "growth_monthly",
  "SyncUp Growth Annual": "growth_annual",
  "SyncUp Pro Monthly": "pro_monthly",
  "SyncUp Pro Annual": "pro_annual",
};

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}:`, JSON.stringify(payload));

  const appSub = payload.app_subscription;
  if (!appSub) {
    return new Response("Missing app_subscription", { status: 400 });
  }

  const shopifyStatus = appSub.status; // e.g. ACTIVE, CANCELLED, EXPIRED, DECLINED
  const shopifyName = appSub.name;
  const chargeId = appSub.admin_graphql_api_id;

  const sub = await prisma.subscription.findUnique({
    where: { shopDomain: shop },
  });

  if (shopifyStatus === "ACTIVE") {
    const planKey = PLAN_NAME_MAP[shopifyName];
    if (!planKey) {
      console.error(`Unknown plan name received: ${shopifyName}`);
      return new Response("Unknown plan name", { status: 400 });
    }

    const plan = PLANS[planKey];

    await prisma.subscription.upsert({
      where: { shopDomain: shop },
      update: {
        planName: planKey,
        shopifyChargeId: chargeId,
        shopifyChargeStatus: "active",
        isTrialActive: false,
        status: "active",
        billingCycleStart: new Date(),
        annualBilling: plan.annual,
      },
      create: {
        shopDomain: shop,
        planName: planKey,
        shopifyChargeId: chargeId,
        shopifyChargeStatus: "active",
        isTrialActive: false,
        status: "active",
        billingCycleStart: new Date(),
        annualBilling: plan.annual,
        trialStartDate: new Date(),
        trialEndDate: new Date(),
      },
    });

    logActivity(shop, "plan_activated", `Plan "${plan.name}" activated successfully`);

    // Clean up lists if currently connected count exceeds new plan limit
    const newListLimit = plan.listLimit || 1;
    const removedListNames = await handleDowngradeToListLimit(shop, newListLimit);
    if (removedListNames) {
      console.log(`Plan change list limit enforcement: Removed lists: ${removedListNames}`);
    }
  } else if (shopifyStatus === "CANCELLED" || shopifyStatus === "EXPIRED" || shopifyStatus === "DECLINED") {
    // Only pause/cancel if the charge matches the active subscription charge ID to prevent racing webhooks
    if (sub && sub.shopifyChargeId === chargeId) {
      const { downgradeToFree } = await import("../billing.server");
      await downgradeToFree(shop);
      logActivity(shop, "plan_cancelled", `Subscription cancelled (Status: ${shopifyStatus}); transitioned to Free Plan`);
    }
  }

  return new Response();
};
```

---

## File: [app/routes/webhooks.app.uninstalled.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/webhooks.app.uninstalled.jsx)

```jsx
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // Delete all data associated with this shop to satisfy GDPR shop/redact requirements
  // and ensure a clean slate on re-install.
  await Promise.all([
    // Shopify session tokens
    db.session.deleteMany({ where: { shop } }),
    // Third-party integration tokens + sync targets (cascade deletes SyncTarget, OrderSyncRecord)
    db.platformConnection.deleteMany({ where: { shopDomain: shop } }),
    // Background sync queue (contains full order JSON — PII must not be retained)
    db.syncJob.deleteMany({ where: { shopDomain: shop } }),
    // Activity feed log entries
    db.activityLog.deleteMany({ where: { shopDomain: shop } }),
    // Billing/subscription record
    db.subscription.deleteMany({ where: { shopDomain: shop } }),
  ]);

  console.log(`app/uninstalled for ${shop}: all data purged`);

  return new Response();
};
```

---

## File: [app/routes/webhooks.customers.data_request.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/webhooks.customers.data_request.jsx)

```jsx
import { authenticate } from "../shopify.server";

// GDPR mandatory: respond to customer data access requests.
// We store Shopify order IDs linked to ClickUp task IDs — no PII is stored server-side.
export const action = async ({ request }) => {
  const { shop, payload } = await authenticate.webhook(request);

  const customerId = payload?.customer?.id;
  const orderIds = (payload?.orders_requested || []).map(String);

  console.log(
    `customers/data_request for shop=${shop} customer=${customerId} orders=${orderIds.join(",")}`
  );

  return new Response(null, { status: 200 });
};
```

---

## File: [app/routes/webhooks.customers.redact.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/webhooks.customers.redact.jsx)

```jsx
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// GDPR mandatory: delete all data we hold for a specific customer.
// We store order IDs mapped to ClickUp task IDs — remove those rows.
export const action = async ({ request }) => {
  const { shop, payload } = await authenticate.webhook(request);

  const orderIds = (payload?.orders_to_redact || []).map(String);

  if (orderIds.length > 0) {
    await prisma.orderSyncRecord.deleteMany({
      where: {
        shopDomain: shop,
        shopifyOrderId: { in: orderIds },
      },
    });
  }

  console.log(
    `customers/redact for shop=${shop}: deleted order_tasks for orders=[${orderIds.join(",")}]`
  );

  return new Response(null, { status: 200 });
};
```

---

## File: [app/routes/webhooks.orders.create.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/webhooks.orders.create.jsx)

```jsx
/* global process */
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // Create a new background SyncJob row
  try {
    await prisma.syncJob.create({
      data: {
        shopDomain: shop,
        shopifyOrderId: String(payload.id),
        payload: JSON.stringify(payload),
        status: "pending",
      }
    });

    // Fire-and-forget: Trigger the background processing endpoint asynchronously
    const host = request.headers.get("host");
    const protocol = host.includes("localhost") || host.includes("127.0.0.1") ? "http" : "https";
    const triggerUrl = `${protocol}://${host}/api/jobs/process`;

    fetch(triggerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.SHOPIFY_API_SECRET}`
      }
    }).catch((err) => {
      console.error("Failed to trigger background jobs process:", err);
    });

  } catch (dbErr) {
    console.error("Failed to write webhook payload to sync queue:", dbErr);
  }

  return Response.json({ ok: true });
};
```

---

## File: [app/routes/webhooks.orders.updated.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/webhooks.orders.updated.jsx)

```jsx
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // Dynamic imports for server-only modules
  const [
    { default: prisma },
    {
      getConnection,
      withRetry,
      logActivity,
      scheduleFulfillmentRetry,
    },
    { getOrCreateSubscription, isSubscriptionActive },
    { ClickUpAdapter, MondayAdapter, NotionAdapter }
  ] = await Promise.all([
    import("../db.server"),
    import("../clickup.server"),
    import("../billing.server"),
    import("../adapters/core.js")
  ]);

  const subscription = await getOrCreateSubscription(shop);
  if (!isSubscriptionActive(subscription)) {
    console.log(`Subscription is inactive for ${shop}; skipping fulfillment sync`);
    return new Response();
  }

  const order = payload;

  const connection = await getConnection(shop);
  if (!connection?.accessToken) {
    console.log(`No integration connection for ${shop}; skipping`);
    return new Response();
  }

  const record = await prisma.orderSyncRecord.findFirst({
    where: { shopDomain: shop, shopifyOrderId: String(order.id) },
    orderBy: { createdAt: "desc" }
  });

  const syncTrigger = subscription.syncTrigger || "payment_confirmed";

  if (!record) {
    // Check if we should trigger sync now based on updated order details
    let shouldSync = false;
    if (syncTrigger === "payment_confirmed" && order.financial_status === "paid") {
      shouldSync = true;
    } else if (syncTrigger === "on_fulfillment_start" && order.fulfillment_status) {
      shouldSync = true;
    } else if (syncTrigger === "on_create") {
      shouldSync = true;
    }

    if (shouldSync) {
      console.log(`Order ${order.id} matches sync trigger "${syncTrigger}" on update; creating sync job.`);
      try {
        const existingJob = await prisma.syncJob.findFirst({
          where: {
            shopDomain: shop,
            shopifyOrderId: String(order.id),
            status: { in: ["pending", "processing"] }
          }
        });
        if (!existingJob) {
          await prisma.syncJob.create({
            data: {
              shopDomain: shop,
              shopifyOrderId: String(order.id),
              payload: JSON.stringify(order),
              status: "pending",
            }
          });

          const host = request.headers.get("host");
          const protocol = host.includes("localhost") || host.includes("127.0.0.1") ? "http" : "https";
          const triggerUrl = `${protocol}://${host}/api/jobs/process`;

          fetch(triggerUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${process.env.SHOPIFY_API_SECRET}`
            }
          }).catch((err) => {
            console.error("Failed to trigger background jobs process:", err);
          });
        }
      } catch (dbErr) {
        console.error("Failed to create sync job on order update:", dbErr);
      }
    }
    return new Response();
  }

  if (order.fulfillment_status !== "fulfilled") {
    console.log(
      `Order ${order.id} not fully fulfilled (status: ${order.fulfillment_status}); skipping completion sync`
    );
    return new Response();
  }

  if (
    record.syncStatus === "fulfilled" ||
    record.targetRecordId === "failed" ||
    record.targetRecordId === "pending"
  ) {
    console.log(
      `Order ${order.id} is already marked fulfilled or has no active integration record; skipping`
    );
    return new Response();
  }

  const orderNumber = String(order.order_number ?? order.number ?? order.id);

  let adapter;
  const platform = connection.selectedPlatform || "clickup";
  if (platform === "clickup") {
    adapter = new ClickUpAdapter(connection.accessToken);
  } else if (platform === "monday") {
    adapter = new MondayAdapter(connection.accessToken);
  } else if (platform === "notion") {
    adapter = new NotionAdapter(connection.accessToken);
  }

  try {
    if (!adapter) {
      throw new Error(`Unsupported selectedPlatform: ${platform}`);
    }

    await withRetry(
      () => adapter.completeRecord(record.targetRecordId),
      1,
      1000
    );

    // Update refactored status
    try {
      await prisma.orderSyncRecord.updateMany({
        where: { shopDomain: shop, shopifyOrderId: String(order.id) },
        data: { syncStatus: "fulfilled" }
      });
    } catch (dbErr) {
      console.error("Failed to update OrderSyncRecord status:", dbErr);
    }

    logActivity(
      shop,
      "order_fulfilled",
      `Order #${orderNumber} marked complete in ${connection.selectedPlatform === "clickup" ? "ClickUp" : connection.selectedPlatform === "monday" ? "Monday.com" : "Notion"}`,
      String(order.id),
      record.targetRecordId
    );
    console.log(
      `Marked ${connection.selectedPlatform} record ${record.targetRecordId} complete for order ${order.id}`
    );
  } catch (error) {
    console.error(
      `Failed to complete record ${record.targetRecordId} for order ${order.id}:`,
      error
    );

    const hasRetryFeature = subscription.planName === "trial" || subscription.planName.startsWith("growth") || subscription.planName.startsWith("pro");
    if (hasRetryFeature) {
      logActivity(
        shop,
        "sync_retried",
        `Order #${orderNumber} fulfillment sync failed; retrying in 60 seconds...`,
        String(order.id),
        record.targetRecordId
      );
      scheduleFulfillmentRetry(shop, String(order.id), record.targetRecordId, orderNumber);
    } else {
      logActivity(
        shop,
        "sync_failed",
        `Order #${orderNumber} fulfillment sync failed: ${error.message}`,
        String(order.id),
        record.targetRecordId
      );
    }
  }

  return new Response();
};
```

---

## File: [app/routes/webhooks.shop.redact.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/webhooks.shop.redact.jsx)

```jsx
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// GDPR mandatory: delete all data for a shop 48 hours after uninstall.
export const action = async ({ request }) => {
  const { shop } = await authenticate.webhook(request);

  await Promise.all([
    prisma.orderSyncRecord.deleteMany({ where: { shopDomain: shop } }),
    prisma.platformConnection.deleteMany({ where: { shopDomain: shop } }),
    // SyncJob stores full Shopify order JSON (customer name, email, address) — must be purged
    prisma.syncJob.deleteMany({ where: { shopDomain: shop } }),
    prisma.subscription.deleteMany({ where: { shopDomain: shop } }),
    prisma.activityLog.deleteMany({ where: { shopDomain: shop } }),
    prisma.session.deleteMany({ where: { shop: shop } }),
  ]);


  console.log(`shop/redact for shop=${shop}: all data deleted`);

  return new Response(null, { status: 200 });
};
```

---

## File: [app/routes/_index/route.jsx](file:///c:/Users/zainm/syncup-for-clickup/app/routes/_index/route.jsx)

```jsx
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
        
        <h2 className={styles.title}>Automate your Shopify workflows in your project tools</h2>
        <p className={styles.text}>
          Connect your store in seconds. Automatically create tasks for new orders in ClickUp, Notion, and Monday.com, and mark them complete when fulfilled.
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
            <strong>Instant Task Creation</strong>. A detailed task is created automatically in the list of your choice as soon as a customer places a new order.
          </li>
          <li>
            <strong>Fulfillment Sync</strong>. When you fulfill an order in Shopify, the matching task is automatically marked complete in your connected project tool.
          </li>
          <li>
            <strong>Real-time Logs</strong>. Monitor sync status, connection health, and view an activity log directly inside your Shopify admin dashboard.
          </li>
        </ul>
      </div>
    </div>
  );
}

```

---

## File: [app/routes/_index/styles.module.css](file:///c:/Users/zainm/syncup-for-clickup/app/routes/_index/styles.module.css)

```css
.index {
  align-items: center;
  display: flex;
  justify-content: center;
  min-height: 100vh;
  width: 100%;
  box-sizing: border-box;
  background: radial-gradient(circle at center, #1c1c1c 0%, #0f0f0f 100%);
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #ffffff;
  padding: 3rem 1.5rem;
}

.content {
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: 44rem;
  width: 100%;
  background: rgba(26, 26, 26, 0.65);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 24px;
  padding: 3.5rem 2.5rem;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.35);
}

.header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}

.logoMark {
  width: 3rem;
  height: 3rem;
  background: #1e2925;
  border: 1px solid rgba(0, 196, 140, 0.25);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(0, 196, 140, 0.15);
}

.heading {
  font-size: 2.25rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  background: linear-gradient(135deg, #ffffff 0%, #a5a5a5 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  margin: 0;
}

.title {
  font-size: 1.75rem;
  font-weight: 700;
  line-height: 1.25;
  text-align: center;
  margin: 0 0 1rem 0;
  letter-spacing: -0.02em;
}

.text {
  font-size: 1.1rem;
  line-height: 1.6;
  color: #9a9a9a;
  text-align: center;
  margin: 0 0 2.5rem 0;
  max-width: 32rem;
}

.form {
  display: flex;
  align-items: flex-end;
  width: 100%;
  max-width: 32rem;
  gap: 1rem;
  margin-bottom: 3.5rem;
}

.label {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  flex: 1;
  text-align: left;
  font-size: 0.85rem;
  font-weight: 600;
  color: #9a9a9a;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.input {
  background: #141414;
  border: 1px solid #2a2a2a;
  border-radius: 10px;
  color: #ffffff;
  padding: 0.75rem 1rem;
  font-size: 0.95rem;
  font-family: inherit;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
  box-sizing: border-box;
}

.input:focus {
  border-color: #00c48c;
  box-shadow: 0 0 0 3px rgba(0, 196, 140, 0.15);
}

.hint {
  font-size: 0.75rem;
  font-weight: 400;
  color: #6a6a6a;
  text-transform: none;
  letter-spacing: normal;
  margin-top: 0.1rem;
}

.button {
  background: #00c48c;
  color: #03251c;
  border: none;
  border-radius: 10px;
  padding: 0.75rem 1.5rem;
  font-size: 0.95rem;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  height: 2.75rem;
  align-self: flex-start;
  margin-bottom: 1rem;
  transition: background-color 0.2s, transform 0.1s, box-shadow 0.2s;
}

.button:hover {
  background: #00e0a0;
  box-shadow: 0 0 16px rgba(0, 196, 140, 0.35);
}

.button:active {
  transform: scale(0.98);
}

.list {
  list-style: none;
  padding: 2.5rem 0 0 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1.5rem;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  width: 100%;
}

.list > li {
  font-size: 0.9rem;
  line-height: 1.5;
  color: #9a9a9a;
  text-align: left;
}

.list > li strong {
  display: block;
  color: #ffffff;
  font-size: 0.95rem;
  margin-bottom: 0.4rem;
}

@media only screen and (max-width: 45rem) {
  .content {
    padding: 2.5rem 1.5rem;
  }
  
  .form {
    flex-direction: column;
    align-items: stretch;
    gap: 1.25rem;
  }
  
  .button {
    align-self: stretch;
    height: 3rem;
  }

  .list {
    grid-template-columns: 1fr;
    gap: 2rem;
  }
}

```

---

## File: [app/routes.js](file:///c:/Users/zainm/syncup-for-clickup/app/routes.js)

```javascript
import { flatRoutes } from "@react-router/fs-routes";

export default flatRoutes();
```

---

## File: [app/services/billing-limits.js](file:///c:/Users/zainm/syncup-for-clickup/app/services/billing-limits.js)

```javascript
import prisma from "../db.server.js";
import { PLANS } from "../plans.js";

/**
 * Validates whether a store is permitted to connect an additional resource target.
 * @throws Error if subscription validation constraint fails
 */
export async function assertBillingLimitEnforcement(shopDomain) {
  const sub = await prisma.subscription.findUnique({
    where: { shopDomain },
  });
  if (!sub) {
    throw new Error("Associated shop subscription not found");
  }

  const planName = sub.planName || "trial";
  const plan = PLANS[planName] || (planName === "trial" ? { listLimit: 5 } : { listLimit: 1 });
  const limit = plan.listLimit || 1;

  // Sum active connection targets across all active platform connections
  const activeTargetsCount = await prisma.syncTarget.count({
    where: {
      connection: { shopDomain, isActive: true },
      isActive: true,
    },
  });

  if (activeTargetsCount >= limit) {
    throw new Error(
      `SaaS Billing limit breached. Active connection node count (${activeTargetsCount}) matches or exceeds limit for the ${planName} tier (${limit}).`
    );
  }
}

/**
 * Safely deactivates previous targets and provisions a new platform connection in one atomic transaction.
 */
export async function executeWorkspacePlatformTransition(
  shopDomain,
  deactivateProvider,
  activateProvider,
  newConnectionData
) {
  await prisma.$transaction(async (tx) => {
    // 1. Locate existing connection targets for the platform being deactivated
    const activeOldConnection = await tx.platformConnection.findFirst({
      where: { shopDomain, provider: deactivateProvider },
    });

    if (activeOldConnection) {
      // Soft-deactivate all targets to clear billing limit slots
      await tx.syncTarget.updateMany({
        where: { connectionId: activeOldConnection.id },
        data: { isActive: false },
      });

      // Mark the parent connection as inactive
      await tx.platformConnection.update({
        where: { id: activeOldConnection.id },
        data: { isActive: false },
      });
    }

    // 2. Provision or update the connection for the new platform being activated
    const targetConnection = await tx.platformConnection.upsert({
      where: {
        shopDomain_provider: {
          shopDomain,
          provider: activateProvider,
        },
      },
      update: {
        encryptedAccessToken: newConnectionData.encryptedAccessToken,
        isActive: true,
      },
      create: {
        shopDomain,
        provider: activateProvider,
        encryptedAccessToken: newConnectionData.encryptedAccessToken,
        isActive: true,
      },
    });

    // 3. Populate target metadata for the new platform
    const metadataUpdate = {
      workspaceId: newConnectionData.metadata.workspaceId,
      fieldMappings: newConnectionData.metadata.fieldMappings || "[]",
    };

    if (activateProvider === "CLICKUP") {
      metadataUpdate.workspaceName = newConnectionData.metadata.workspaceName || "Default Workspace";
      await tx.clickUpMetadata.upsert({
        where: { connectionId: targetConnection.id },
        update: metadataUpdate,
        create: {
          connectionId: targetConnection.id,
          ...metadataUpdate,
        },
      });
    } else if (activateProvider === "MONDAY") {
      await tx.mondayMetadata.upsert({
        where: { connectionId: targetConnection.id },
        update: metadataUpdate,
        create: {
          connectionId: targetConnection.id,
          ...metadataUpdate,
        },
      });
    } else if (activateProvider === "NOTION") {
      await tx.notionMetadata.upsert({
        where: { connectionId: targetConnection.id },
        update: metadataUpdate,
        create: {
          connectionId: targetConnection.id,
          ...metadataUpdate,
        },
      });
    }

    // 4. Provision connection targets for the newly activated platform
    for (const target of newConnectionData.targetResources) {
      await tx.syncTarget.upsert({
        where: {
          connectionId_targetResourceId: {
            connectionId: targetConnection.id,
            targetResourceId: target.id,
          },
        },
        update: {
          targetResourceName: target.name,
          isActive: true,
        },
        create: {
          connectionId: targetConnection.id,
          targetResourceId: target.id,
          targetResourceName: target.name,
          isActive: true,
        },
      });
    }

    // 5. Run the billing limits validation check within the transaction context
    const sub = await tx.subscription.findUnique({ where: { shopDomain } });
    const planName = sub?.planName || "trial";
    const plan = PLANS[planName] || (planName === "trial" ? { listLimit: 5 } : { listLimit: 1 });
    const limit = plan.listLimit || 1;

    const totalActiveTargets = await tx.syncTarget.count({
      where: {
        connection: { shopDomain, isActive: true },
        isActive: true,
      },
    });

    if (totalActiveTargets > limit) {
      throw new Error(
        `Workspace platform transition aborted. Configured targets (${totalActiveTargets}) exceed subscription tier limits (${limit}).`
      );
    }
  });
}
```

---

## File: [app/shopify.server.js](file:///c:/Users/zainm/syncup-for-clickup/app/shopify.server.js)

```javascript
import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  DeliveryMethod,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  webhooks: {
    ORDERS_CREATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/orders/create",
    },
    ORDERS_UPDATED: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/orders/updated",
    },
    CUSTOMERS_DATA_REQUEST: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/customers/data_request",
    },
    CUSTOMERS_REDACT: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/customers/redact",
    },
    SHOP_REDACT: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/shop/redact",
    },
    APP_SUBSCRIPTIONS_UPDATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/app/subscriptions_update",
    },
  },
  hooks: {
    afterAuth: async ({ session }) => {
      shopify.registerWebhooks({ session });
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
```

---

## File: [CHANGELOG.md](file:///c:/Users/zainm/syncup-for-clickup/CHANGELOG.md)

```markdown
# @shopify/shopify-app-template-react-router

## 2026.02.09
- Add declarative product metafield definition and demonstrate metafield usage in the product creation flow
- Add declarative metaobject definition and demonstrate metaobject upsert in the product creation flow

## 2026.01.08
- [#170](https://github.com/Shopify/shopify-app-template-react-router/pull/170) - Update React Router minimum version to v7.12.0

## 2025.12.11

- [#151](https://github.com/Shopify/shopify-app-template-react-router/pull/151) Update `@shopify/shopify-app-react-router` to v1.1.0 and `@shopify/shopify-app-session-storage-prisma` to v8.0.0, add refresh token fields (`refreshToken` and `refreshTokenExpires`) to Session model in Prisma schema, and adopt the `expiringOfflineAccessTokens` flag for enhanced security through token rotation. See [expiring vs non-expiring offline tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens#expiring-vs-non-expiring-offline-tokens) for more information.

## 2025.10.10

- [#95](https://github.com/Shopify/shopify-app-template-react-router/pull/95) Swap the product link for [admin intents](https://shopify.dev/docs/apps/build/admin/admin-intents).

## 2025.10.02

- [#81](https://github.com/Shopify/shopify-app-template-react-router/pull/81) Add shopify global to eslint for ui extensions

## 2025.10.01

- [#79](https://github.com/Shopify/shopify-app-template-react-router/pull/78) Update API version to 2025-10.
- [#77](https://github.com/Shopify/shopify-app-template-react-router/pull/77) Update `@shopify/shopify-app-react-router` to V1.
- [#73](https://github.com/Shopify/shopify-app-template-react-router/pull/73/files) Rename @shopify/app-bridge-ui-types to @shopify/polaris-types

## 2025.08.30

- [#70](https://github.com/Shopify/shopify-app-template-react-router/pull/70/files) Upgrade `@shopify/app-bridge-ui-types` from 0.2.1 to 0.3.1.

## 2025.08.17

- [#58](https://github.com/Shopify/shopify-app-template-react-router/pull/58) Update Shopify & React Router dependencies.  Use Shopify React Router in graphqlrc, not shopify-api
- [#57](https://github.com/Shopify/shopify-app-template-react-router/pull/57) Update Webhook API version in `shopify.app.toml` to `2025-07`
- [#56](https://github.com/Shopify/shopify-app-template-react-router/pull/56) Remove local CLI from package.json in favor of global CLI installation
- [#53](https://github.com/Shopify/shopify-app-template-react-router/pull/53) Add the Shopify Dev MCP to the template

## 2025.08.16

- [#52](https://github.com/Shopify/shopify-app-template-react-router/pull/52) Use `ApiVersion.July25` rather than `LATEST_API_VERSION` in `.graphqlrc`.

## 2025.07.24

- [14](https://github.com/Shopify/shopify-app-template-react-router/pull/14/files) Add [App Bridge web components](https://shopify.dev/docs/api/app-home/app-bridge-web-components) to the template.

## July 2025

Forked the [shopify-app-template repo](https://github.com/Shopify/shopify-app-template-remix)

# @shopify/shopify-app-template-remix

## 2025.03.18

-[#998](https://github.com/Shopify/shopify-app-template-remix/pull/998) Update to Vite 6

## 2025.03.01

- [#982](https://github.com/Shopify/shopify-app-template-remix/pull/982) Add Shopify Dev Assistant extension to the VSCode extension recommendations

## 2025.01.31

- [#952](https://github.com/Shopify/shopify-app-template-remix/pull/952) Update to Shopify App API v2025-01

## 2025.01.23

- [#923](https://github.com/Shopify/shopify-app-template-remix/pull/923) Update `@shopify/shopify-app-session-storage-prisma` to v6.0.0

## 2025.01.8

- [#923](https://github.com/Shopify/shopify-app-template-remix/pull/923) Enable GraphQL autocomplete for Javascript

## 2024.12.19

- [#904](https://github.com/Shopify/shopify-app-template-remix/pull/904) bump `@shopify/app-bridge-react` to latest
-
## 2024.12.18

- [875](https://github.com/Shopify/shopify-app-template-remix/pull/875) Add Scopes Update Webhook
## 2024.12.05

- [#910](https://github.com/Shopify/shopify-app-template-remix/pull/910) Install `openssl` in Docker image to fix Prisma (see [#25817](https://github.com/prisma/prisma/issues/25817#issuecomment-2538544254))
- [#907](https://github.com/Shopify/shopify-app-template-remix/pull/907) Move `@remix-run/fs-routes` to `dependencies` to fix Docker image build
- [#899](https://github.com/Shopify/shopify-app-template-remix/pull/899) Disable v3_singleFetch flag
- [#898](https://github.com/Shopify/shopify-app-template-remix/pull/898) Enable the `removeRest` future flag so new apps aren't tempted to use the REST Admin API.

## 2024.12.04

- [#891](https://github.com/Shopify/shopify-app-template-remix/pull/891) Enable remix future flags.

## 2024.11.26

- [888](https://github.com/Shopify/shopify-app-template-remix/pull/888) Update restResources version to 2024-10

## 2024.11.06

- [881](https://github.com/Shopify/shopify-app-template-remix/pull/881) Update to the productCreate mutation to use the new ProductCreateInput type

## 2024.10.29

- [876](https://github.com/Shopify/shopify-app-template-remix/pull/876) Update shopify-app-remix to v3.4.0 and shopify-app-session-storage-prisma to v5.1.5

## 2024.10.02

- [863](https://github.com/Shopify/shopify-app-template-remix/pull/863) Update to Shopify App API v2024-10 and shopify-app-remix v3.3.2

## 2024.09.18

- [850](https://github.com/Shopify/shopify-app-template-remix/pull/850) Removed "~" import alias

## 2024.09.17

- [842](https://github.com/Shopify/shopify-app-template-remix/pull/842) Move webhook processing to individual routes

## 2024.08.19

Replaced deprecated `productVariantUpdate` with `productVariantsBulkUpdate`

## v2024.08.06

Allow `SHOP_REDACT` webhook to process without admin context

## v2024.07.16

Started tracking changes and releases using calver
```

---

## File: [docs/incident-response-policy.md](file:///c:/Users/zainm/syncup-for-clickup/docs/incident-response-policy.md)

```markdown
# SyncUp for ClickUp — Security Incident Response Policy

**Owner:** Zain (founder) — responsible for executing this policy.
**Last reviewed:** June 2026

## Purpose
Defines how SyncUp detects, responds to, and recovers from security incidents
involving merchant or customer personal data (e.g. data breaches, unauthorized
access, leaked credentials/tokens, or exploited vulnerabilities).

## 1. Detection & reporting
- Monitor Vercel logs, error alerts, and database activity for anomalies.
- Log every suspected incident with the date/time, what was observed, and the
  systems involved.

## 2. Containment
- Immediately rotate or revoke any affected credentials: Shopify access tokens,
  ClickUp OAuth tokens, the database connection string, and any API keys.
- Disable the affected integration, or take the app offline, if needed to stop
  ongoing exposure.

## 3. Assessment
- Determine what data was affected, how many merchants/customers are impacted,
  and the root cause.

## 4. Notification
- Notify affected merchants without undue delay.
- Notify Shopify within 24 hours of confirming an incident that affects
  protected customer data, per the Shopify Partner Program requirements.
- Meet any applicable breach-notification laws (e.g. the GDPR 72-hour rule).

## 5. Remediation & review
- Fix the root cause, deploy the patch, and verify the issue is resolved.
- Document the incident and update controls/processes to prevent recurrence.
```

---

## File: [package.json](file:///c:/Users/zainm/syncup-for-clickup/package.json)

```json
{
  "name": "syncup-for-clickup",
  "private": true,
  "scripts": {
    "build": "prisma generate && prisma migrate deploy && react-router build",
    "dev": "shopify app dev",
    "config:link": "shopify app config link",
    "generate": "shopify app generate",
    "deploy": "shopify app deploy",
    "config:use": "shopify app config use",
    "env": "shopify app env",
    "start": "react-router-serve ./build/server/index.js",
    "docker-start": "npm run setup && npm run start",
    "setup": "prisma generate && prisma migrate deploy",
    "lint": "eslint --ignore-path .gitignore --cache --cache-location ./node_modules/.cache/eslint .",
    "shopify": "shopify",
    "prisma": "prisma",
    "graphql-codegen": "graphql-codegen",
    "vite": "vite",
    "typecheck": "react-router typegen && tsc --noEmit"
  },
  "type": "module",
  "engines": {
    "node": ">=20.19 <22 || >=22.12"
  },
  "dependencies": {
    "@neondatabase/serverless": "^1.1.0",
    "@prisma/adapter-neon": "^7.8.0",
    "@prisma/client": "^6.16.3",
    "@react-router/dev": "^7.12.0",
    "@react-router/fs-routes": "^7.12.0",
    "@react-router/node": "^7.12.0",
    "@react-router/serve": "^7.12.0",
    "@shopify/app-bridge-react": "^4.2.4",
    "@shopify/shopify-app-react-router": "^1.1.0",
    "@shopify/shopify-app-session-storage-prisma": "^9.0.0",
    "isbot": "^5.1.31",
    "prisma": "^6.16.3",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router": "^7.12.0",
    "vite-tsconfig-paths": "^5.1.4"
  },
  "devDependencies": {
    "@shopify/api-codegen-preset": "^1.2.0",
    "@shopify/polaris-types": "1.0.1",
    "@types/eslint": "^9.6.1",
    "@types/node": "^22.18.8",
    "@types/react": "^18.3.25",
    "@types/react-dom": "^18.3.7",
    "@typescript-eslint/eslint-plugin": "^6.21.0",
    "@typescript-eslint/parser": "^6.21.0",
    "eslint": "^8.57.1",
    "eslint-import-resolver-typescript": "^3.10.1",
    "eslint-plugin-import": "^2.32.0",
    "eslint-plugin-jsx-a11y": "^6.10.2",
    "eslint-plugin-react": "^7.37.5",
    "eslint-plugin-react-hooks": "^4.6.2",
    "graphql-config": "^5.1.1",
    "prettier": "^3.6.2",
    "typescript": "^5.9.3",
    "vite": "^6.3.6"
  },
  "workspaces": [
    "extensions/*"
  ],
  "trustedDependencies": [
    "@shopify/plugin-cloudflare"
  ],
  "overrides": {
    "p-map": "^4.0.0"
  },
  "author": "zainm"
}
```

---

## File: [prisma/migrations/migration_lock.toml](file:///c:/Users/zainm/syncup-for-clickup/prisma/migrations/migration_lock.toml)

```toml
# Please do not edit this file manually
# It should be added in your version-control system (e.g., Git)
provider = "postgresql"
```

---

## File: [prisma/schema.prisma](file:///c:/Users/zainm/syncup-for-clickup/prisma/schema.prisma)

```prisma
// This is your Prisma schema file,
// learn more about it in the docs: https://pris.ly/d/prisma-schema

generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["driverAdapters"]
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Session {
  id            String    @id
  shop          String
  state         String
  isOnline      Boolean   @default(false)
  scope         String?
  expires       DateTime?
  accessToken   String
  userId        BigInt?
  firstName     String?
  lastName      String?
  email         String?
  accountOwner  Boolean   @default(false)
  locale        String?
  collaborator  Boolean?  @default(false)
  emailVerified Boolean?  @default(false)
  refreshToken        String?
  refreshTokenExpires DateTime?
}

// Tracks the billing plan and monthly order usage for each shop.
model Subscription {
  shopDomain             String    @id @map("shop_domain")
  planName               String    @default("trial") @map("plan_name") // trial, starter_monthly, starter_annual, growth_monthly, growth_annual, expired, cancelled
  shopifyChargeId        String?   @map("shopify_charge_id")
  shopifyChargeStatus    String?   @map("shopify_charge_status")
  trialStartDate         DateTime  @default(now()) @map("trial_start_date")
  trialEndDate           DateTime  @map("trial_end_date")
  isTrialActive          Boolean   @default(true) @map("is_trial_active")
  billingCycleStart      DateTime? @map("billing_cycle_start")
  annualBilling          Boolean   @default(false) @map("annual_billing")
  status                 String    @default("active") // active, paused, expired, cancelled
  ordersSyncedThisMonth  Int       @default(0) @map("orders_synced_this_month")
  ordersSyncedAllTime    Int       @default(0) @map("orders_synced_all_time")
  // Merchant-configurable sync settings
  taskNameTemplate       String?   @map("task_name_template") // e.g. "Order {order_number} — {customer_name}"
  taskDescriptionTemplate String?  @map("task_description_template")
  syncTrigger            String    @default("payment_confirmed") @map("sync_trigger") // payment_confirmed | on_create | on_fulfillment_start
  subtasksEnabled        Boolean   @default(false) @map("subtasks_enabled")
  twoWaySyncEnabled      Boolean   @default(true) @map("two_way_sync_enabled")
  createdAt              DateTime  @default(now()) @map("created_at")
  updatedAt              DateTime  @updatedAt @map("updated_at")

  @@map("subscriptions")
}

// Append-only event log for the merchant-facing activity feed.
model ActivityLog {
  id              Int      @id @default(autoincrement())
  shopDomain      String   @map("shop_domain")
  eventType       String   @map("event_type")
  description     String
  shopifyOrderId  String?  @map("shopify_order_id")
  clickupTaskId   String?  @map("clickup_task_id")
  syncStatus      String?  @map("sync_status") // synced | failed | retrying | fulfilled
  externalTaskUrl String?  @map("external_task_url") // deep link to ClickUp/Monday/Notion record
  createdAt       DateTime @default(now()) @map("created_at")

  @@index([shopDomain, createdAt(sort: Desc)])
  @@map("activity_log")
}

// Queue table for asynchronous order sync execution
model SyncJob {
  id             String   @id @default(uuid())
  shopDomain     String   @map("shop_domain")
  shopifyOrderId String   @map("shopify_order_id") // No @unique — one order can fan-out to multiple platform connections
  payload        String   // Serialized JSON of order details
  status         String   @default("pending") // pending, processing, completed, failed
  attempts       Int      @default(0)
  lastError      String?  @map("last_error")
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  @@index([status])
  @@index([shopDomain, shopifyOrderId]) // Fast duplicate-detection queries
  @@map("sync_jobs")
}

enum IntegrationProvider {
  CLICKUP
  MONDAY
  NOTION
}

model PlatformConnection {
  id                   String              @id @default(uuid())
  shopDomain           String              @map("shop_domain")
  provider             IntegrationProvider
  isActive             Boolean             @default(true) @map("is_active")
  encryptedAccessToken String              @map("encrypted_access_token")
  healthStatus         String              @default("healthy") @map("health_status") // healthy | degraded | error
  lastHealthCheck      DateTime?           @map("last_health_check")
  createdAt            DateTime            @default(now()) @map("created_at")
  updatedAt            DateTime            @updatedAt @map("updated_at")

  // Concrete child-table relationships (Delegated Schema)
  clickUpMetadata      ClickUpMetadata?
  mondayMetadata       MondayMetadata?
  notionMetadata       NotionMetadata?

  // Tracking of connected targets to enforce unified billing limits
  syncTargets          SyncTarget[]

  @@unique([shopDomain, provider])
  @@map("platform_connections")
}

model ClickUpMetadata {
  id            String             @id @default(uuid())
  connectionId  String             @unique @map("connection_id")
  connection    PlatformConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  workspaceId   String             @map("workspace_id")
  workspaceName String             @map("workspace_name")
  fieldMappings String?            @map("field_mappings") // Serialized JSON array of custom field mappings
  isFreePlan    Boolean            @default(false) @map("is_free_plan")

  @@map("clickup_metadata")
}

model MondayMetadata {
  id            String             @id @default(uuid())
  connectionId  String             @unique @map("connection_id")
  connection    PlatformConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  workspaceId   String             @map("workspace_id")
  fieldMappings String?            @map("field_mappings")

  @@map("monday_metadata")
}

model NotionMetadata {
  id            String             @id @default(uuid())
  connectionId  String             @unique @map("connection_id")
  connection    PlatformConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  workspaceId   String             @map("workspace_id")
  fieldMappings String?            @map("field_mappings")

  @@map("notion_metadata")
}

model SyncTarget {
  id                 String             @id @default(uuid())
  connectionId       String             @map("connection_id")
  connection         PlatformConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  targetResourceId   String             @map("target_resource_id") // ClickUp List ID, Monday Board ID, or Notion Database ID
  targetResourceName String             @map("target_resource_name")
  keyword            String?            @map("keyword")
  routingLocationId  String?            @map("routing_location_id")
  routingTag         String?            @map("routing_tag")
  isActive           Boolean            @default(true) @map("is_active")
  createdAt          DateTime           @default(now()) @map("created_at")
  updatedAt          DateTime           @updatedAt @map("updated_at")
  orderSyncRecords   OrderSyncRecord[]

  @@unique([connectionId, targetResourceId])
  @@map("sync_targets")
}

model OrderSyncRecord {
  id             String     @id @default(uuid())
  shopDomain     String     @map("shop_domain")
  shopifyOrderId String     @map("shopify_order_id")
  syncTargetId   String     @map("sync_target_id")
  syncTarget     SyncTarget @relation(fields: [syncTargetId], references: [id], onDelete: Cascade)
  targetRecordId String     @map("target_record_id") // ClickUp Task ID, Monday Item ID, Notion Page ID
  syncStatus     String     @default("synced") @map("sync_status") // synced, failed, retrying, fulfilled
  orderNumber    String?    @map("order_number")
  createdAt      DateTime   @default(now()) @map("created_at")
  updatedAt      DateTime   @updatedAt @map("updated_at")

  @@unique([shopifyOrderId, syncTargetId])
  @@map("order_sync_records")
}

```

---

## File: [README.md](file:///c:/Users/zainm/syncup-for-clickup/README.md)

```markdown
# Shopify App Template - React Router

This is a template for building a [Shopify app](https://shopify.dev/docs/apps/getting-started) using [React Router](https://reactrouter.com/). It was forked from the [Shopify Remix app template](https://github.com/Shopify/shopify-app-template-remix) and converted to React Router.

Rather than cloning this repo, follow the [Quick Start steps](https://github.com/Shopify/shopify-app-template-react-router#quick-start).

Visit the [`shopify.dev` documentation](https://shopify.dev/docs/api/shopify-app-react-router) for more details on the React Router app package.

## Upgrading from Remix

If you have an existing Remix app that you want to upgrade to React Router, please follow the [upgrade guide](https://github.com/Shopify/shopify-app-template-react-router/wiki/Upgrading-from-Remix). Otherwise, please follow the quick start guide below.

## Quick start

### Prerequisites

Before you begin, you'll need to [download and install the Shopify CLI](https://shopify.dev/docs/apps/tools/cli/getting-started) if you haven't already.

### Setup

```shell
shopify app init --template=https://github.com/Shopify/shopify-app-template-react-router
```

### Local Development

```shell
shopify app dev
```

Press P to open the URL to your app. Once you click install, you can start development.

Local development is powered by [the Shopify CLI](https://shopify.dev/docs/apps/tools/cli). It logs into your account, connects to an app, provides environment variables, updates remote config, creates a tunnel and provides commands to generate extensions.

### Authenticating and querying data

To authenticate and query data you can use the `shopify` const that is exported from `/app/shopify.server.js`:

```js
export async function loader({ request }) {
  const { admin } = await shopify.authenticate.admin(request);

  const response = await admin.graphql(`
    {
      products(first: 25) {
        nodes {
          title
          description
        }
      }
    }`);

  const {
    data: {
      products: { nodes },
    },
  } = await response.json();

  return nodes;
}
```

This template comes pre-configured with examples of:

1. Setting up your Shopify app in [/app/shopify.server.ts](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/shopify.server.ts)
2. Querying data using Graphql. Please see: [/app/routes/app.\_index.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/app._index.tsx).
3. Responding to webhooks. Please see [/app/routes/webhooks.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/webhooks.app.uninstalled.tsx).
4. Using metafields, metaobjects, and declarative custom data definitions. Please see [/app/routes/app.\_index.tsx](https://github.com/Shopify/shopify-app-template-react-router/blob/main/app/routes/app._index.tsx) and [shopify.app.toml](https://github.com/Shopify/shopify-app-template-react-router/blob/main/shopify.app.toml).

Please read the [documentation for @shopify/shopify-app-react-router](https://shopify.dev/docs/api/shopify-app-react-router) to see what other API's are available.

## Shopify Dev MCP

This template is configured with the Shopify Dev MCP. This instructs [Cursor](https://cursor.com/), [GitHub Copilot](https://github.com/features/copilot) and [Claude Code](https://claude.com/product/claude-code) and [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) to use the Shopify Dev MCP.

For more information on the Shopify Dev MCP please read [the documentation](https://shopify.dev/docs/apps/build/devmcp).

## Deployment

### Application Storage

This template uses [Prisma](https://www.prisma.io/) to store session data, by default using an [SQLite](https://www.sqlite.org/index.html) database.
The database is defined as a Prisma schema in `prisma/schema.prisma`.

This use of SQLite works in production if your app runs as a single instance.
The database that works best for you depends on the data your app needs and how it is queried.
Here’s a short list of databases providers that provide a free tier to get started:

| Database   | Type             | Hosters                                                                                                                                                                                                                                    |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MySQL      | SQL              | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-mysql), [Planet Scale](https://planetscale.com/), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/mysql) |
| PostgreSQL | SQL              | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-postgresql), [Amazon Aurora](https://aws.amazon.com/rds/aurora/), [Google Cloud SQL](https://cloud.google.com/sql/docs/postgres)                                   |
| Redis      | Key-value        | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-redis), [Amazon MemoryDB](https://aws.amazon.com/memorydb/)                                                                                                        |
| MongoDB    | NoSQL / Document | [Digital Ocean](https://www.digitalocean.com/products/managed-databases-mongodb), [MongoDB Atlas](https://www.mongodb.com/atlas/database)                                                                                                  |

To use one of these, you can use a different [datasource provider](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference#datasource) in your `schema.prisma` file, or a different [SessionStorage adapter package](https://github.com/Shopify/shopify-api-js/blob/main/packages/shopify-api/docs/guides/session-storage.md).

### Build

Build the app by running the command below with the package manager of your choice:

Using yarn:

```shell
yarn build
```

Using npm:

```shell
npm run build
```

Using pnpm:

```shell
pnpm run build
```

## Hosting

When you're ready to set up your app in production, you can follow [our deployment documentation](https://shopify.dev/docs/apps/launch/deployment) to host it externally. From there, you have a few options:

- [Google Cloud Run](https://shopify.dev/docs/apps/launch/deployment/deploy-to-google-cloud-run): This tutorial is written specifically for this example repo, and is compatible with the extended steps included in the subsequent [**Build your app**](tutorial) in the **Getting started** docs. It is the most detailed tutorial for taking a React Router-based Shopify app and deploying it to production. It includes configuring permissions and secrets, setting up a production database, and even hosting your apps behind a load balancer across multiple regions.
- [Fly.io](https://fly.io/docs/js/shopify/): Leverages the Fly.io CLI to quickly launch Shopify apps to a single machine.
- [Render](https://render.com/docs/deploy-shopify-app): This tutorial guides you through using Docker to deploy and install apps on a Dev store.
- [Manual deployment guide](https://shopify.dev/docs/apps/launch/deployment/deploy-to-hosting-service): This resource provides general guidance on the requirements of deployment including environment variables, secrets, and persistent data.

When you reach the step for [setting up environment variables](https://shopify.dev/docs/apps/deployment/web#set-env-vars), you also need to set the variable `NODE_ENV=production`.

## Gotchas / Troubleshooting

### Database tables don't exist

If you get an error like:

```
The table `main.Session` does not exist in the current database.
```

Create the database for Prisma. Run the `setup` script in `package.json` using `npm`, `yarn` or `pnpm`.

### Navigating/redirecting breaks an embedded app

Embedded apps must maintain the user session, which can be tricky inside an iFrame. To avoid issues:

1. Use `Link` from `react-router` or `@shopify/polaris`. Do not use `<a>`.
2. Use `redirect` returned from `authenticate.admin`. Do not use `redirect` from `react-router`
3. Use `useSubmit` from `react-router`.

This only applies if your app is embedded, which it will be by default.

### Webhooks: shop-specific webhook subscriptions aren't updated

If you are registering webhooks in the `afterAuth` hook, using `shopify.registerWebhooks`, you may find that your subscriptions aren't being updated.

Instead of using the `afterAuth` hook declare app-specific webhooks in the `shopify.app.toml` file. This approach is easier since Shopify will automatically sync changes every time you run `deploy` (e.g: `npm run deploy`). Please read these guides to understand more:

1. [app-specific vs shop-specific webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe#app-specific-subscriptions)
2. [Create a subscription tutorial](https://shopify.dev/docs/apps/build/webhooks/subscribe/get-started?deliveryMethod=https)

If you do need shop-specific webhooks, keep in mind that the package calls `afterAuth` in 2 scenarios:

- After installing the app
- When an access token expires

During normal development, the app won't need to re-authenticate most of the time, so shop-specific subscriptions aren't updated. To force your app to update the subscriptions, uninstall and reinstall the app. Revisiting the app will call the `afterAuth` hook.

### Webhooks: Admin created webhook failing HMAC validation

Webhooks subscriptions created in the [Shopify admin](https://help.shopify.com/en/manual/orders/notifications/webhooks) will fail HMAC validation. This is because the webhook payload is not signed with your app's secret key.

The recommended solution is to use [app-specific webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe#app-specific-subscriptions) defined in your toml file instead. Test your webhooks by triggering events manually in the Shopify admin(e.g. Updating the product title to trigger a `PRODUCTS_UPDATE`).

### Webhooks: Admin object undefined on webhook events triggered by the CLI

When you trigger a webhook event using the Shopify CLI, the `admin` object will be `undefined`. This is because the CLI triggers an event with a valid, but non-existent, shop. The `admin` object is only available when the webhook is triggered by a shop that has installed the app. This is expected.

Webhooks triggered by the CLI are intended for initial experimentation testing of your webhook configuration. For more information on how to test your webhooks, see the [Shopify CLI documentation](https://shopify.dev/docs/apps/tools/cli/commands#webhook-trigger).

### Incorrect GraphQL Hints

By default the [graphql.vscode-graphql](https://marketplace.visualstudio.com/items?itemName=GraphQL.vscode-graphql) extension for will assume that GraphQL queries or mutations are for the [Shopify Admin API](https://shopify.dev/docs/api/admin). This is a sensible default, but it may not be true if:

1. You use another Shopify API such as the storefront API.
2. You use a third party GraphQL API.

If so, please update [.graphqlrc.ts](https://github.com/Shopify/shopify-app-template-react-router/blob/main/.graphqlrc.ts).

### Using Defer & await for streaming responses

By default the CLI uses a cloudflare tunnel. Unfortunately cloudflare tunnels wait for the Response stream to finish, then sends one chunk. This will not affect production.

To test [streaming using await](https://reactrouter.com/api/components/Await#await) during local development we recommend [localhost based development](https://shopify.dev/docs/apps/build/cli-for-apps/networking-options#localhost-based-development).

### "nbf" claim timestamp check failed

This is because a JWT token is expired. If you are consistently getting this error, it could be that the clock on your machine is not in sync with the server. To fix this ensure you have enabled "Set time and date automatically" in the "Date and Time" settings on your computer.

### Using MongoDB and Prisma

If you choose to use MongoDB with Prisma, there are some gotchas in Prisma's MongoDB support to be aware of. Please see the [Prisma SessionStorage README](https://www.npmjs.com/package/@shopify/shopify-app-session-storage-prisma#mongodb).

### Unable to require(`C:\...\query_engine-windows.dll.node`).

Unable to require(`C:\...\query_engine-windows.dll.node`).
The Prisma engines do not seem to be compatible with your system.

query_engine-windows.dll.node is not a valid Win32 application.

**Fix:** Set the environment variable:

```shell
PRISMA_CLIENT_ENGINE_TYPE=binary
```

This forces Prisma to use the binary engine mode, which runs the query engine as a separate process and can work via emulation on Windows ARM64.

## Resources

React Router:

- [React Router docs](https://reactrouter.com/home)

Shopify:

- [Intro to Shopify apps](https://shopify.dev/docs/apps/getting-started)
- [Shopify App React Router docs](https://shopify.dev/docs/api/shopify-app-react-router)
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli)
- [Shopify App Bridge](https://shopify.dev/docs/api/app-bridge-library).
- [Polaris Web Components](https://shopify.dev/docs/api/app-home/polaris-web-components).
- [App extensions](https://shopify.dev/docs/apps/app-extensions/list)
- [Shopify Functions](https://shopify.dev/docs/api/functions)

Internationalization:

- [Internationalizing your app](https://shopify.dev/docs/apps/best-practices/internationalization/getting-started)
```

---

## File: [shopify.app.toml](file:///c:/Users/zainm/syncup-for-clickup/shopify.app.toml)

```toml
# Learn more about configuring your app at https://shopify.dev/docs/apps/tools/cli/configuration

client_id = "2eac8af074b2ed8402633158c9719a59"
name = "SyncUp"
application_url = "https://syncup-for-clickup.vercel.app"
embedded = true

[access_scopes]
scopes = "read_orders,read_customers"

[webhooks]
api_version = "2026-07"

  [[webhooks.subscriptions]]
  uri = "/webhooks/app/uninstalled"
  topics = [ "app/uninstalled" ]

  [[webhooks.subscriptions]]
  uri = "/webhooks/app/scopes_update"
  topics = [ "app/scopes_update" ]

  [[webhooks.subscriptions]]
  uri = "/webhooks/orders/create"
  topics = [ "orders/create" ]

  [[webhooks.subscriptions]]
  uri = "/webhooks/orders/updated"
  topics = [ "orders/updated" ]

  # Mandatory GDPR compliance webhooks (required for App Store listing).
  [[webhooks.subscriptions]]
  uri = "/webhooks/customers/data_request"
  compliance_topics = [ "customers/data_request" ]

  [[webhooks.subscriptions]]
  uri = "/webhooks/customers/redact"
  compliance_topics = [ "customers/redact" ]

  [[webhooks.subscriptions]]
  uri = "/webhooks/shop/redact"
  compliance_topics = [ "shop/redact" ]

  [[webhooks.subscriptions]]
  uri = "/webhooks/app/subscriptions_update"
  topics = [ "app_subscriptions/update" ]

[auth]
redirect_urls = [ "https://syncup-for-clickup.vercel.app/auth/callback" ]

[build]
automatically_update_urls_on_dev = true
```

---

## File: [shopify.web.toml](file:///c:/Users/zainm/syncup-for-clickup/shopify.web.toml)

```toml
name = "React Router"
roles = ["frontend", "backend"]
webhooks_path = "/webhooks/app/uninstalled"
[commands]
predev = "npm exec prisma generate"
dev = "npm exec prisma migrate deploy && npm exec react-router dev"
```

---

## File: [tsconfig.json](file:///c:/Users/zainm/syncup-for-clickup/tsconfig.json)

```json
{
  "include": ["env.d.ts", "**/*.ts", "**/*.tsx", ".react-router/types/**/*"],
  "compilerOptions": {
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "strict": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "allowSyntheticDefaultImports": true,
    "removeComments": false,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "allowJs": true,
    "resolveJsonModule": true,
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ES2022",
    "baseUrl": ".",
    "types": ["@react-router/node", "vite/client", "@shopify/polaris-types"],
    "rootDirs": [".", "./.react-router/types"]
  }
}
```

---

## File: [vercel.json](file:///c:/Users/zainm/syncup-for-clickup/vercel.json)

```json
{
  "crons": [
    {
      "path": "/api/reconciliation",
      "schedule": "0 0 * * *"
    }
  ]
}
```

---

## File: [vite.config.js](file:///c:/Users/zainm/syncup-for-clickup/vite.config.js)

```javascript
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Related: https://github.com/remix-run/remix/issues/2835#issuecomment-1144102176
// Replace the HOST env var with SHOPIFY_APP_URL so that it doesn't break the Vite server.
// The CLI will eventually stop passing in HOST,
// so we can remove this workaround after the next major release.
if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost")
  .hostname;
let hmrConfig;

if (host === "localhost") {
  hmrConfig = {
    protocol: "ws",
    host: "localhost",
    port: 64999,
    clientPort: 64999,
  };
} else {
  hmrConfig = {
    protocol: "wss",
    host: host,
    port: parseInt(process.env.FRONTEND_PORT) || 8002,
    clientPort: 443,
  };
}

export default defineConfig({
  server: {
    allowedHosts: [host],
    cors: {
      preflightContinue: true,
    },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: {
      // See https://vitejs.dev/config/server-options.html#server-fs-allow for more information
      allow: ["app", "node_modules"],
    },
  },
  plugins: [reactRouter(), tsconfigPaths()],
  build: {
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react"],
  },
});
```

---

