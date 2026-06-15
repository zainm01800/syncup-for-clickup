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
// Persistence helpers — ClickUpConnection
// ---------------------------------------------------------------------------

export async function getConnection(shop) {
  const conn = await prisma.clickUpConnection.findUnique({
    where: { shopDomain: shop },
  });
  if (!conn) return null;
  const accessToken = await decryptToken(conn.accessToken);
  // null means old-format token that can't be decrypted — treat as disconnected
  if (!accessToken) return null;

  let listConnections = [];
  if (conn.listConnections) {
    try {
      listConnections = JSON.parse(conn.listConnections);
    } catch (e) {
      console.error("Failed to parse listConnections:", e);
    }
  }

  // Backfill if empty but listId exists
  if (listConnections.length === 0 && conn.listId) {
    listConnections = [{ id: conn.listId, name: conn.listName || "", keyword: "" }];
  }

  return { ...conn, accessToken, listConnections };
}

export async function saveToken(shop, accessToken, workspaceName = null) {
  const encryptedToken = await encryptToken(accessToken);
  const data = { accessToken: encryptedToken };
  if (workspaceName) data.workspaceName = workspaceName;
  return prisma.clickUpConnection.upsert({
    where: { shopDomain: shop },
    update: data,
    create: { shopDomain: shop, ...data },
  });
}

export async function saveList(shop, listId, listName) {
  const listConnections = [{ id: listId, name: listName, keyword: "" }];
  return prisma.clickUpConnection.update({
    where: { shopDomain: shop },
    data: {
      listId,
      listName,
      listConnections: JSON.stringify(listConnections),
    },
  });
}

export async function saveListConnections(shop, listConnections) {
  const firstList = listConnections[0] || null;
  return prisma.clickUpConnection.update({
    where: { shopDomain: shop },
    data: {
      listId: firstList?.id || null,
      listName: firstList?.name || null,
      listConnections: JSON.stringify(listConnections),
    },
  });
}

export async function handleDowngradeToListLimit(shop, listLimit = 1) {
  const conn = await prisma.clickUpConnection.findUnique({
    where: { shopDomain: shop },
  });
  if (!conn || !conn.listConnections) return null;

  try {
    const listConns = JSON.parse(conn.listConnections);
    if (listConns.length > listLimit) {
      const kept = listConns.slice(0, listLimit);
      const removed = listConns.slice(listLimit);
      const removedNames = removed.map((c) => c.name).join(", ");

      await prisma.clickUpConnection.update({
        where: { shopDomain: shop },
        data: {
          listId: kept[0]?.id || null,
          listName: kept[0]?.name || null,
          listConnections: JSON.stringify(kept),
        },
      });

      // Log activity
      logActivity(
        shop,
        "plan_cancelled",
        `Plan limit check: kept ${listLimit} list(s). Removed extra list connections: ${removedNames}`
      );

      return removedNames;
    }
  } catch (e) {
    console.error("Failed to handle downgrade list cleanup:", e);
  }
  return null;
}

export async function disconnect(shop) {
  return prisma.clickUpConnection.deleteMany({ where: { shopDomain: shop } });
}

// ---------------------------------------------------------------------------
// Persistence helpers — OrderTask
// ---------------------------------------------------------------------------

export async function recordOrderTask(shop, shopifyOrderId, clickupTaskId, status = "synced", orderNumber = null) {
  const data = { clickupTaskId, status };
  if (orderNumber) data.orderNumber = orderNumber;

  return prisma.orderTask.upsert({
    where: {
      shopDomain_shopifyOrderId: { shopDomain: shop, shopifyOrderId },
    },
    update: data,
    create: { shopDomain: shop, shopifyOrderId, clickupTaskId, status, orderNumber },
  });
}

export async function findOrderTask(shop, shopifyOrderId) {
  return prisma.orderTask.findUnique({
    where: {
      shopDomain_shopifyOrderId: { shopDomain: shop, shopifyOrderId },
    },
  });
}

// Atomically claims an order slot before calling ClickUp.
// Returns true if this caller won the race, false if another webhook already claimed it.
export async function claimOrderSlot(shop, shopifyOrderId, orderNumber = null) {
  try {
    await prisma.orderTask.create({
      data: { shopDomain: shop, shopifyOrderId, clickupTaskId: "pending", status: "pending", orderNumber },
    });
    return true;
  } catch (e) {
    // P2002 = Prisma unique constraint; 23505 = PostgreSQL native code (Neon adapter)
    if (e.code === "P2002" || e.code === "23505") return false;
    throw e;
  }
}

export async function updateOrderTaskStatus(shop, shopifyOrderId, status) {
  return prisma.orderTask.updateMany({
    where: { shopDomain: shop, shopifyOrderId },
    data: { status },
  });
}

// ---------------------------------------------------------------------------
// Webhook retry logic (Growth plan only)
// ---------------------------------------------------------------------------

export function scheduleRetry(shop, shopifyOrderId, listId, taskData, attempt = 1) {
  const delay = attempt === 1 ? 60 * 1000 : 5 * 60 * 1000;

  setTimeout(async () => {
    try {
      console.log(`Retrying task creation for order ${shopifyOrderId} (attempt ${attempt})...`);

      const connection = await getConnection(shop);
      if (!connection?.accessToken) {
        console.error(`Retry failed: ClickUp not connected for shop ${shop}`);
        return;
      }

      // Re-import dynamically to avoid circular dependencies
      const { incrementOrderCount } = await import("./billing.server");

      const task = await createTask(connection.accessToken, listId, taskData);

      await recordOrderTask(shop, shopifyOrderId, task.id, "synced", taskData.orderNumber);
      await incrementOrderCount(shop);

      logActivity(
        shop,
        "order_synced",
        `Order #${taskData.orderNumber} (${taskData.customerName}) synced to ClickUp after retry`,
        shopifyOrderId,
        task.id
      );
      console.log(`Retry successful: Created ClickUp task ${task.id} for order ${shopifyOrderId}`);
    } catch (err) {
      console.error(`Retry attempt ${attempt} failed for order ${shopifyOrderId}:`, err);

      if (attempt < 2) {
        logActivity(
          shop,
          "sync_retried",
          `Order #${taskData.orderNumber} sync failed; retrying again in 5 minutes...`,
          shopifyOrderId
        );
        scheduleRetry(shop, shopifyOrderId, listId, taskData, attempt + 1);
      } else {
        await recordOrderTask(shop, shopifyOrderId, "failed", "failed", taskData.orderNumber).catch(() => {});
        logActivity(
          shop,
          "sync_failed",
          `Order #${taskData.orderNumber} sync failed after all retries: ${err.message}`,
          shopifyOrderId
        );
      }
    }
  }, delay);
}

export function scheduleFulfillmentRetry(shop, shopifyOrderId, clickupTaskId, orderNumber, attempt = 1) {
  const delay = attempt === 1 ? 60 * 1000 : 5 * 60 * 1000;

  setTimeout(async () => {
    try {
      console.log(`Retrying task completion for order ${shopifyOrderId} (attempt ${attempt})...`);

      const connection = await getConnection(shop);
      if (!connection?.accessToken) {
        console.error(`Retry failed: ClickUp not connected for shop ${shop}`);
        return;
      }

      await completeTask(connection.accessToken, clickupTaskId);
      await updateOrderTaskStatus(shop, shopifyOrderId, "fulfilled");

      logActivity(
        shop,
        "order_fulfilled",
        `Order #${orderNumber} marked complete in ClickUp after retry`,
        shopifyOrderId,
        clickupTaskId
      );
      console.log(`Retry successful: Completed ClickUp task ${clickupTaskId} for order ${shopifyOrderId}`);
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

