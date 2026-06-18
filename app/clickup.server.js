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

export function scheduleFulfillmentRetry(shop, shopifyOrderId, clickupTaskId, orderNumber, attempt = 1) {
  const delay = attempt === 1 ? 60 * 1000 : 5 * 60 * 1000;

  setTimeout(async () => {
    try {
      console.log(`Retrying task completion for order ${shopifyOrderId} (attempt ${attempt})...`);

      const connection = await getConnection(shop);
      if (!connection?.accessToken) {
        console.error(`Retry failed: Integration not connected for shop ${shop}`);
        return;
      }

      const { ClickUpAdapter, MondayAdapter, NotionAdapter } = await import("./adapters/core.js");
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
        throw new Error(`Unsupported selectedPlatform: ${platform}`);
      }

      await adapter.completeRecord(clickupTaskId);

      await prisma.orderSyncRecord.updateMany({
        where: { shopDomain: shop, shopifyOrderId },
        data: { syncStatus: "fulfilled" }
      });

      logActivity(
        shop,
        "order_fulfilled",
        `Order #${orderNumber} marked complete in ${platform === "clickup" ? "ClickUp" : platform === "monday" ? "Monday.com" : "Notion"} after retry`,
        shopifyOrderId,
        clickupTaskId
      );
    } catch (err) {
      console.error(`Fulfillment retry attempt ${attempt} failed for order ${shopifyOrderId}:`, err);

      if (attempt < 2) {
        logActivity(
          shop,
          "sync_retried",
          `Order #${orderNumber} fulfillment sync failed; retrying again in 5 minutes...`,
          shopifyOrderId,
          clickupTaskId
        );
        scheduleFulfillmentRetry(shop, shopifyOrderId, clickupTaskId, orderNumber, attempt + 1);
      } else {
        logActivity(
          shop,
          "sync_failed",
          `Order #${orderNumber} fulfillment sync failed after all retries: ${err.message}`,
          shopifyOrderId,
          clickupTaskId
        );
      }
    }
  }, delay);
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

